use crate::config::{normalize_slashes, WorkspacePaths};
use chrono::{DateTime, Duration, NaiveDate, TimeZone, Utc};
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{BTreeMap, HashMap};
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::sync::OnceLock;
use std::time::Instant;

const DEFAULT_DAYS: i64 = 7;
const MAX_SCAN_BYTES: u64 = 209_715_200;
const QUERY_TIMEOUT_MS: u128 = 10_000;
const VALID_BY: &str = "cmd|tool|mcp|hook|event|model|agent|decision";

#[derive(Debug, Clone, Deserialize)]
pub struct ObserveParams {
    pub since: Option<String>,
    pub by: Option<String>,
    pub limit: Option<usize>,
    pub project: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ObserveItem {
    pub key: String,
    pub count: usize,
    pub err: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub p50_ms: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_ms: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tokens_in: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tokens_out: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cache_read: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cache_create: Option<u64>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ObserveResult {
    pub by: String,
    pub since: String,
    pub audit_root: String,
    pub files_scanned: usize,
    pub events_scanned: usize,
    pub total_groups: usize,
    pub truncated: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub truncate_reason: Option<String>,
    /// Events whose transcript usage was cut short (`data.usage_truncated`): tokens are a lower bound.
    pub usage_truncated: usize,
    pub items: Vec<ObserveItem>,
}

struct ScanInfo {
    files_scanned: usize,
    events_scanned: usize,
    truncated: bool,
    reason: Option<String>,
}

fn audit_roots(paths: &WorkspacePaths) -> Vec<PathBuf> {
    let mut roots = vec![paths.audit_root.clone()];
    if std::env::var("CLAUDE_AUDIT_DIR")
        .ok()
        .is_none_or(|v| v.trim().is_empty())
    {
        let legacy = paths.data_dir.join("audit");
        if legacy != paths.audit_root && legacy.is_dir() {
            roots.push(legacy);
        }
    }
    roots
}

enum ScanEv<'a> {
    /// A new file starts (its `date=` partition, "" if none).
    File(&'a str),
    Event(&'a Value),
}

/// Latest cumulative usage of one (sid, agent_id): Stop/SubagentStop totals grow over the session.
struct Usage {
    ts: i64,
    key: String,
    tin: u64,
    tout: u64,
    cache_read: u64,
    cache_create: u64,
    truncated: bool,
    err: bool,
}

fn usage_of(ev: &Value, key: String) -> Option<((String, String), Usage)> {
    let tin = ev.get("tokens_in").and_then(Value::as_u64);
    let tout = ev.get("tokens_out").and_then(Value::as_u64);
    if tin.is_none() && tout.is_none() {
        return None;
    }
    let s = |k: &str| ev.get(k).and_then(Value::as_str).unwrap_or("").to_string();
    let data = ev.get("data");
    let g = |k: &str| data.and_then(|d| d.get(k)).and_then(Value::as_u64).unwrap_or(0);
    Some((
        (s("sid"), s("agent_id")),
        Usage {
            ts: ts_ms(ev).unwrap_or(i64::MIN),
            key,
            tin: tin.unwrap_or(0),
            tout: tout.unwrap_or(0),
            cache_read: g("cache_read"),
            cache_create: g("cache_create"),
            truncated: data.and_then(|d| d.get("usage_truncated")).and_then(Value::as_bool) == Some(true),
            err: ev.get("ok").and_then(Value::as_bool) == Some(false),
        },
    ))
}

/// Keep the event with the largest `ts` (not read order).
fn keep_latest(m: &mut HashMap<(String, String), Usage>, k: (String, String), u: Usage) {
    match m.get(&k) {
        Some(old) if old.ts >= u.ts => {}
        _ => {
            m.insert(k, u);
        }
    }
}

/// Stream every event newer than `cutoff` to `f`, newest day first; the byte cap drops the OLDEST days.
fn scan(
    paths: &WorkspacePaths,
    cutoff: DateTime<Utc>,
    project: Option<&str>,
    max_bytes: u64,
    mut f: impl FnMut(ScanEv),
) -> ScanInfo {
    let cutoff_date = cutoff.format("%Y-%m-%d").to_string();
    let files = collect_jsonl_files(&audit_roots(paths), &cutoff_date);
    let started = Instant::now();
    let mut info = ScanInfo { files_scanned: 0, events_scanned: 0, truncated: false, reason: None };
    let mut used: u64 = 0;
    let mut buf: Vec<u8> = Vec::new();
    'files: for (fdate, path) in files {
        if started.elapsed().as_millis() > QUERY_TIMEOUT_MS {
            info.truncated = true;
            info.reason = Some("timeout".to_string());
            break;
        }
        let sz = fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
        if used.saturating_add(sz) > max_bytes {
            info.truncated = true;
            info.reason = Some("max_bytes".to_string());
            continue; // skip only this oversize file; smaller ones may still fit
        }
        let Ok(file) = fs::File::open(&path) else {
            continue;
        };
        used = used.saturating_add(sz);
        info.files_scanned += 1;
        f(ScanEv::File(&fdate));
        let mut rd = BufReader::new(file);
        let mut n = 0u32;
        loop {
            buf.clear();
            match rd.read_until(b'\n', &mut buf) {
                Ok(0) | Err(_) => break,
                Ok(_) => {}
            }
            n += 1;
            if n.is_multiple_of(8192) && started.elapsed().as_millis() > QUERY_TIMEOUT_MS {
                info.truncated = true;
                info.reason = Some("timeout".to_string());
                break 'files;
            }
            let Ok(v) = serde_json::from_slice::<Value>(buf.trim_ascii()) else {
                continue;
            };
            if !v.is_object() {
                continue;
            }
            if let Some(proj) = project.filter(|s| !s.is_empty()) {
                if v.get("project").and_then(Value::as_str) != Some(proj) {
                    continue;
                }
            }
            if let Some(dt) = v
                .get("ts")
                .and_then(Value::as_str)
                .and_then(|s| DateTime::parse_from_rfc3339(s).ok())
            {
                if dt.with_timezone(&Utc) < cutoff {
                    continue;
                }
            }
            info.events_scanned += 1;
            f(ScanEv::Event(&v));
        }
    }
    info
}

pub fn run_observe(paths: &WorkspacePaths, params: &ObserveParams) -> Result<ObserveResult, String> {
    run_observe_with(paths, params, MAX_SCAN_BYTES)
}

pub fn run_observe_with(
    paths: &WorkspacePaths,
    params: &ObserveParams,
    max_bytes: u64,
) -> Result<ObserveResult, String> {
    let by = params.by.as_deref().unwrap_or("cmd");
    if !VALID_BY.split('|').any(|b| b == by) {
        return Err(format!("invalid 'by': '{by}' (expected {VALID_BY})"));
    }
    let since_label = params
        .since
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("7d")
        .to_string();
    let cutoff = parse_since(&since_label)?;
    let limit = params.limit.unwrap_or(20).clamp(1, 200);

    let mut agg = Agg::new(by);
    let info = scan(paths, cutoff, params.project.as_deref(), max_bytes, |e| match e {
        ScanEv::File(_) => agg.pre.clear(), // Pre/Post pairs live in one file; bounds the map
        ScanEv::Event(ev) => agg.add(ev),
    });
    agg.fold_usage();
    let usage_truncated = agg.usage_truncated;
    let mut rows = agg.finish();
    let total_groups = rows.len();
    let (mut truncated, mut truncate_reason) = (info.truncated, info.reason);
    if rows.len() > limit {
        rows.truncate(limit);
        if !truncated {
            truncated = true;
            truncate_reason = Some("limit".to_string());
        }
    }

    Ok(ObserveResult {
        by: by.to_string(),
        since: since_label,
        audit_root: normalize_slashes(&paths.audit_root.to_string_lossy()),
        files_scanned: info.files_scanned,
        events_scanned: info.events_scanned,
        total_groups,
        truncated,
        truncate_reason,
        usage_truncated,
        items: rows,
    })
}

#[derive(Default)]
struct Acc {
    count: usize,
    err: usize,
    durs: Vec<i64>,
    tin: u64,
    tout: u64,
    cache_read: u64,
    cache_create: u64,
}

struct Agg<'a> {
    by: &'a str,
    acc: BTreeMap<String, Acc>,
    /// PreToolUse ts by tool_use_id, removed when the matching Post arrives (streaming pairing).
    pre: HashMap<String, i64>,
    latest: HashMap<(String, String), Usage>,
    usage_truncated: usize,
}

fn ts_ms(ev: &Value) -> Option<i64> {
    ev.get("ts")
        .and_then(Value::as_str)
        .and_then(|s| DateTime::parse_from_rfc3339(s).ok())
        .map(|d| d.timestamp_millis())
}

fn tool_use_id(ev: &Value) -> Option<&str> {
    ev.get("data")
        .and_then(|d| d.get("tool_use_id"))
        .and_then(Value::as_str)
}

fn is_deny(decision: &str) -> bool {
    matches!(decision, "deny" | "block" | "error")
}

impl<'a> Agg<'a> {
    fn new(by: &'a str) -> Self {
        Agg { by, acc: BTreeMap::new(), pre: HashMap::new(), latest: HashMap::new(), usage_truncated: 0 }
    }

    fn bump(&mut self, key: String, err: bool) -> Option<&mut Acc> {
        if key.is_empty() {
            return None;
        }
        let e = self.acc.entry(key).or_default();
        e.count += 1;
        if err {
            e.err += 1;
        }
        Some(e)
    }

    fn add(&mut self, ev: &Value) {
        let event_name = ev.get("event").and_then(Value::as_str).unwrap_or("");
        let rec_type = ev.get("type").and_then(Value::as_str).unwrap_or("");
        let ok_false = ev.get("ok").and_then(Value::as_bool) == Some(false);
        let is_fail = event_name == "PostToolUseFailure" || ok_false;

        match self.by {
            "tool" | "mcp" => self.add_tool(ev, event_name, is_fail),
            "model" | "agent" => self.add_usage(ev),
            "decision" => {
                if rec_type == "gate" || (rec_type.is_empty() && event_name == "Gate") {
                    if let Some(dc) = ev
                        .get("data")
                        .and_then(|d| d.get("gate"))
                        .and_then(|g| g.get("decision"))
                        .and_then(Value::as_str)
                    {
                        self.bump(dc.to_string(), is_deny(dc));
                    }
                }
            }
            "event" => {
                if !rec_type.is_empty() || !event_name.is_empty() {
                    self.bump(format!("{rec_type}:{event_name}"), is_fail);
                }
            }
            "hook" => {
                if rec_type == "gate" || (rec_type.is_empty() && event_name == "Gate") {
                    if let Some(gate) = ev.get("data").and_then(|d| d.get("gate")) {
                        let hk = gate.get("hook").and_then(Value::as_str).unwrap_or("gate");
                        let rl = gate.get("rule").and_then(Value::as_str).unwrap_or("-");
                        let dc = gate.get("decision").and_then(Value::as_str).unwrap_or("-");
                        self.bump(format!("{hk}:{rl}:{dc}"), is_deny(dc));
                    }
                } else if rec_type == "hook" || event_name == "HookRun" {
                    if let Some(mods) = ev
                        .get("data")
                        .and_then(|d| d.get("modules"))
                        .and_then(Value::as_array)
                    {
                        for m in mods {
                            if let Some(id) = m.get("id").and_then(Value::as_str) {
                                self.bump(id.to_string(), m.get("err").is_some());
                            }
                        }
                    }
                } else if let Some(hk) = ev.get("hook").and_then(Value::as_str) {
                    let act = ev.get("action").and_then(Value::as_str).unwrap_or("");
                    self.bump(hk.to_string(), act == "error" || ok_false);
                }
            }
            _ => {
                // "cmd": harness <domain> [sub] on PostToolUse / PostToolUseFailure Bash/PowerShell
                if !matches!(event_name, "PostToolUse" | "PostToolUseFailure") {
                    return;
                }
                let tool = ev.get("tool").and_then(Value::as_str).unwrap_or("");
                if tool != "Bash" && tool != "PowerShell" {
                    return;
                }
                let cmd_src = ev
                    .get("data")
                    .and_then(|d| d.get("cmd_line"))
                    .and_then(Value::as_str)
                    .or_else(|| ev.get("target").and_then(Value::as_str))
                    .unwrap_or("");
                if let Some((dom, sub)) = parse_harness_call(cmd_src) {
                    let key = match sub {
                        Some(s) => format!("{dom} {s}"),
                        None => dom,
                    };
                    let exit_nz = ev
                        .get("data")
                        .and_then(|d| d.get("exit_code"))
                        .and_then(Value::as_i64)
                        .is_some_and(|c| c != 0);
                    self.bump(key, is_fail || exit_nz);
                }
            }
        }
    }

    fn add_tool(&mut self, ev: &Value, event_name: &str, is_fail: bool) {
        if event_name == "PreToolUse" {
            if let (Some(id), Some(ts)) = (tool_use_id(ev), ts_ms(ev)) {
                self.pre.insert(id.to_string(), ts);
            }
            return;
        }
        if event_name != "PostToolUse" && event_name != "PostToolUseFailure" {
            return;
        }
        let Some(tool) = ev.get("tool").and_then(Value::as_str) else {
            return;
        };
        let key = if self.by == "mcp" {
            match mcp_server_name(tool, ev) {
                Some(s) => s,
                None => return,
            }
        } else {
            tool.to_string()
        };
        let dur = ev
            .get("dur_ms")
            .and_then(Value::as_i64)
            .filter(|&d| d >= 0)
            .or_else(|| {
                let start = self.pre.remove(tool_use_id(ev)?)?;
                Some(ts_ms(ev)? - start).filter(|&d| d >= 0)
            });
        if let Some(a) = self.bump(key, is_fail) {
            if let Some(d) = dur {
                a.durs.push(d);
            }
        }
    }

    fn add_usage(&mut self, ev: &Value) {
        let key = if self.by == "model" {
            ev.get("model").and_then(Value::as_str).unwrap_or("-")
        } else {
            ev.get("agent_type").and_then(Value::as_str).unwrap_or("main")
        };
        if let Some((k, u)) = usage_of(ev, key.to_string()) {
            keep_latest(&mut self.latest, k, u);
        }
    }

    /// Sum the newest cumulative usage of each (sid, agent_id) into the groups. Call once, before `finish`.
    fn fold_usage(&mut self) {
        for u in std::mem::take(&mut self.latest).into_values() {
            if u.truncated {
                self.usage_truncated += 1;
            }
            if let Some(a) = self.bump(u.key, u.err) {
                a.tin += u.tin;
                a.tout += u.tout;
                a.cache_read += u.cache_read;
                a.cache_create += u.cache_create;
            }
        }
    }

    fn finish(self) -> Vec<ObserveItem> {
        let usage = matches!(self.by, "model" | "agent");
        let mut rows: Vec<ObserveItem> = self
            .acc
            .into_iter()
            .map(|(key, mut a)| {
                let (p50_ms, max_ms) = if a.durs.is_empty() {
                    (None, None)
                } else {
                    a.durs.sort_unstable();
                    let p50 = a.durs[(a.durs.len() - 1) / 2];
                    (Some(p50), a.durs.last().copied())
                };
                ObserveItem {
                    key,
                    count: a.count,
                    err: a.err,
                    p50_ms,
                    max_ms,
                    tokens_in: usage.then_some(a.tin),
                    tokens_out: usage.then_some(a.tout),
                    cache_read: usage.then_some(a.cache_read),
                    cache_create: usage.then_some(a.cache_create),
                }
            })
            .collect();
        // Numeric sort (u64), never string order; BTreeMap input keeps key order stable for ties.
        if usage {
            rows.sort_by(|a, b| b.tokens_out.cmp(&a.tokens_out).then_with(|| a.key.cmp(&b.key)));
        } else {
            rows.sort_by(|a, b| b.count.cmp(&a.count).then_with(|| a.key.cmp(&b.key)));
        }
        rows
    }
}

fn mcp_server_name(tool: &str, ev: &Value) -> Option<String> {
    if let Some(rest) = tool.strip_prefix("mcp__") {
        let srv = rest.split("__").next()?;
        if let Some(ai) = srv.strip_prefix("claude_ai_") {
            return Some(format!("claude.ai {}", ai.replace('_', " ")));
        }
        return Some(srv.to_string());
    }
    if tool == "MCP" {
        if let Some(srv) = ev
            .get("data")
            .and_then(|d| d.get("server"))
            .and_then(Value::as_str)
        {
            return Some(srv.to_string());
        }
        if let Some(tgt) = ev.get("target").and_then(Value::as_str) {
            if let Some((srv, _)) = tgt.split_once('/') {
                return Some(srv.to_string());
            }
            return Some(tgt.to_string());
        }
    }
    None
}

/// (quote-stripper, harness-call matcher), compiled once.
fn harness_regexes() -> &'static (Regex, Regex) {
    static RE: OnceLock<(Regex, Regex)> = OnceLock::new();
    RE.get_or_init(|| {
        (
            Regex::new(r#""[^"]*"|'[^']*'"#).expect("static regex"),
            Regex::new(
                r"(?:^|[\s;&|(])(?:[^\s;&|()]*[\\/])?harness(?:\.mjs|\.cmd|\.exe)?\s+([a-z][\w-]*)(?:\s+([a-z][\w-]*))?",
            )
            .expect("static regex"),
        )
    })
}

fn parse_harness_call(cmd_line: &str) -> Option<(String, Option<String>)> {
    if !cmd_line.contains("harness") {
        return None; // cheap prefilter: most Bash lines are not harness calls
    }
    let (strip_q, re) = harness_regexes();
    let bare = strip_q.replace_all(cmd_line, "\"\"");
    let caps = re.captures(&bare)?;
    let dom = caps.get(1)?.as_str().to_string();
    let sub = caps
        .get(2)
        .map(|m| m.as_str())
        .filter(|s| !s.starts_with('-'))
        .map(ToString::to_string);
    Some((dom, sub))
}

/// jsonl files with their `date=` partition (empty when none), newest date first, then path.
fn collect_jsonl_files(roots: &[PathBuf], cutoff_date: &str) -> Vec<(String, PathBuf)> {
    let mut files: Vec<(String, PathBuf)> = Vec::new();
    for root in roots {
        if !root.is_dir() {
            continue;
        }
        let mut stack = vec![(root.clone(), String::new())];
        while let Some((dir, date)) = stack.pop() {
            let Ok(ents) = fs::read_dir(&dir) else {
                continue;
            };
            for ent in ents.flatten() {
                let p = ent.path();
                let Ok(ft) = ent.file_type() else {
                    continue;
                };
                if ft.is_symlink() {
                    continue;
                }
                if ft.is_dir() {
                    let mut d = date.clone();
                    if let Some(name) = p.file_name().and_then(|n| n.to_str()) {
                        if let Some(dt) = name.strip_prefix("date=") {
                            if dt < cutoff_date {
                                continue;
                            }
                            d = dt.to_string();
                        }
                    }
                    stack.push((p, d));
                } else if ft.is_file() && p.extension().and_then(|e| e.to_str()) == Some("jsonl") {
                    files.push((date.clone(), p));
                }
            }
        }
    }
    files.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| a.1.cmp(&b.1)));
    files
}

pub fn parse_since(raw: &str) -> Result<DateTime<Utc>, String> {
    let now = Utc::now();
    if raw.is_empty() {
        return Ok(now - Duration::days(DEFAULT_DAYS));
    }
    if let Ok(days) = raw.parse::<i64>() {
        if days > 0 {
            return Ok(now - Duration::days(days));
        }
    }
    if let Some(num_str) = raw.strip_suffix('d') {
        if let Ok(n) = num_str.parse::<i64>() {
            if n > 0 {
                return Ok(now - Duration::days(n));
            }
        }
    }
    if let Some(num_str) = raw.strip_suffix('h') {
        if let Ok(n) = num_str.parse::<i64>() {
            if n > 0 {
                return Ok(now - Duration::hours(n));
            }
        }
    }
    if let Some(num_str) = raw.strip_suffix('m') {
        if let Ok(n) = num_str.parse::<i64>() {
            if n > 0 {
                return Ok(now - Duration::minutes(n));
            }
        }
    }
    if let Ok(dt) = DateTime::parse_from_rfc3339(raw) {
        return Ok(dt.with_timezone(&Utc));
    }
    if let Ok(nd) = NaiveDate::parse_from_str(raw, "%Y-%m-%d") {
        if let Some(ndt) = nd.and_hms_opt(0, 0, 0) {
            return Ok(Utc.from_utc_datetime(&ndt));
        }
    }
    Err(format!("invalid 'since' window: '{raw}' (use e.g. 7d, 24h, 2026-11-20)"))
}

pub fn format_observe_summary(res: &ObserveResult) -> String {
    let mut lines = vec![format!(
        "observe by={} since={} ({} items/{} groups, {} events, {} files{}{})",
        res.by,
        res.since,
        res.items.len(),
        res.total_groups,
        res.events_scanned,
        res.files_scanned,
        if res.truncated {
            format!(", truncated={}", res.truncate_reason.as_deref().unwrap_or("true"))
        } else {
            String::new()
        },
        if res.usage_truncated > 0 {
            format!(", usage_truncated={} (tokens are a lower bound)", res.usage_truncated)
        } else {
            String::new()
        }
    )];
    for r in &res.items {
        let timing = match (r.p50_ms, r.max_ms) {
            (Some(p), Some(m)) => format!("  p50={p}ms max={m}ms"),
            _ => String::new(),
        };
        let tokens = match (r.tokens_in, r.tokens_out) {
            (Some(i), Some(o)) => format!(
                "  in={i} out={o} cache_read={} cache_create={}",
                r.cache_read.unwrap_or(0),
                r.cache_create.unwrap_or(0)
            ),
            _ => String::new(),
        };
        lines.push(format!("{:>6}  err={}{}{}  {}", r.count, r.err, timing, tokens, r.key));
    }
    lines.join("\n")
}

#[derive(Debug, Clone, Default, Serialize)]
pub struct ReportDay {
    pub date: String,
    pub events: usize,
    pub errors: usize,
    pub denies: usize,
    pub tokens_in: u64,
    pub tokens_out: u64,
}

#[derive(Debug, Clone, Serialize)]
pub struct ReportResult {
    pub days_window: i64,
    pub audit_root: String,
    pub files_scanned: usize,
    pub events_scanned: usize,
    pub truncated: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub truncate_reason: Option<String>,
    /// Newest day first.
    pub days: Vec<ReportDay>,
}

/// Per-day roll-up (read-only; the old `observe report --dry-run` as the weekly playbook used it).
pub fn run_report(paths: &WorkspacePaths, days: i64) -> Result<ReportResult, String> {
    if !(1..=365).contains(&days) {
        return Err(format!("invalid 'days': {days} (1..365)"));
    }
    let cutoff = Utc::now() - Duration::days(days);
    let mut by_day: BTreeMap<String, ReportDay> = BTreeMap::new();
    // Cumulative Stop usage: newest per (day, sid, agent_id), summed after the scan.
    let mut latest: HashMap<(String, String), Usage> = HashMap::new();
    let mut cur_date = String::new();
    let info = scan(paths, cutoff, None, MAX_SCAN_BYTES, |e| {
        let ev = match e {
            ScanEv::File(d) => {
                cur_date = d.to_string();
                return;
            }
            ScanEv::Event(ev) => ev,
        };
        // Day = `date=` partition; ts prefix only for files outside a partition.
        let date: &str = if cur_date.is_empty() {
            match ev.get("ts").and_then(Value::as_str).and_then(|s| s.get(..10)) {
                Some(d) => d,
                None => return,
            }
        } else {
            &cur_date
        };
        if let Some(((sid, agent), u)) = usage_of(ev, String::new()) {
            keep_latest(&mut latest, (format!("{date}\u{1f}{sid}"), agent), u);
        }
        let d = by_day.entry(date.to_string()).or_insert_with(|| ReportDay {
            date: date.to_string(),
            ..Default::default()
        });
        d.events += 1;
        if ev.get("ok").and_then(Value::as_bool) == Some(false)
            || ev.get("event").and_then(Value::as_str) == Some("PostToolUseFailure")
        {
            d.errors += 1;
        }
        if ev
            .get("data")
            .and_then(|x| x.get("gate"))
            .and_then(|g| g.get("decision"))
            .and_then(Value::as_str)
            .is_some_and(|dc| matches!(dc, "deny" | "block"))
        {
            d.denies += 1;
        }
    });
    for ((day_sid, _), u) in latest {
        let date = day_sid.split('\u{1f}').next().unwrap_or("");
        if let Some(d) = by_day.get_mut(date) {
            d.tokens_in += u.tin;
            d.tokens_out += u.tout;
        }
    }
    Ok(ReportResult {
        days_window: days,
        audit_root: normalize_slashes(&paths.audit_root.to_string_lossy()),
        files_scanned: info.files_scanned,
        events_scanned: info.events_scanned,
        truncated: info.truncated,
        truncate_reason: info.reason,
        days: by_day.into_values().rev().collect(),
    })
}

pub fn format_report_summary(r: &ReportResult) -> String {
    let mut lines = vec![format!(
        "report days={} ({} days with data, {} events, {} files{})",
        r.days_window,
        r.days.len(),
        r.events_scanned,
        r.files_scanned,
        if r.truncated {
            format!(", truncated={}", r.truncate_reason.as_deref().unwrap_or("true"))
        } else {
            String::new()
        }
    )];
    for d in &r.days {
        lines.push(format!(
            "{}  events={} err={} deny={} tokens_in={} tokens_out={}",
            d.date, d.events, d.errors, d.denies, d.tokens_in, d.tokens_out
        ));
    }
    lines.join("\n")
}

#[derive(Debug, Clone, Serialize)]
pub struct SizesResult {
    pub audit_root: String,
    pub total_bytes: u64,
    /// (date partition, bytes), biggest first; "" = files outside a `date=` partition.
    pub partitions: Vec<(String, u64)>,
}

/// Bytes of audit jsonl per date partition (read-only).
pub fn run_sizes(paths: &WorkspacePaths) -> SizesResult {
    let mut m: BTreeMap<String, u64> = BTreeMap::new();
    for (date, p) in collect_jsonl_files(&audit_roots(paths), "") {
        *m.entry(date).or_default() += fs::metadata(&p).map(|x| x.len()).unwrap_or(0);
    }
    let mut partitions: Vec<(String, u64)> = m.into_iter().collect();
    partitions.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
    SizesResult {
        audit_root: normalize_slashes(&paths.audit_root.to_string_lossy()),
        total_bytes: partitions.iter().map(|p| p.1).sum(),
        partitions,
    }
}

pub fn format_sizes_summary(s: &SizesResult) -> String {
    let mut lines = vec![format!(
        "sizes {} partitions, {} bytes total ({})",
        s.partitions.len(),
        s.total_bytes,
        s.audit_root
    )];
    for (d, b) in s.partitions.iter().take(10) {
        lines.push(format!("{b:>12}  {}", if d.is_empty() { "(no date)" } else { d }));
    }
    lines.join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn observe_groups_by_cmd_tool_mcp_hook_event() {
        let tmp = std::env::temp_dir().join(format!("harness-obs-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&tmp);
        let today = Utc::now().format("%Y-%m-%d").to_string();
        let tool_dir = tmp.join(format!("date={today}")).join("type=tool");
        let gate_dir = tmp.join(format!("date={today}")).join("type=gate");
        fs::create_dir_all(&tool_dir).unwrap();
        fs::create_dir_all(&gate_dir).unwrap();

        let lines = [
            serde_json::json!({"v":2,"ts":Utc::now().to_rfc3339(),"type":"tool","event":"PostToolUse","tool":"Bash","ok":true,"dur_ms":12,"data":{"cmd_line":"harness data ls"}}),
            serde_json::json!({"v":2,"ts":Utc::now().to_rfc3339(),"type":"tool","event":"PostToolUse","tool":"mcp__mem__mem_read","ok":true,"dur_ms":8,"data":{}}),
            serde_json::json!({"v":2,"ts":Utc::now().to_rfc3339(),"type":"tool","event":"PostToolUseFailure","tool":"Bash","ok":false,"dur_ms":5,"data":{"cmd_line":"harness doctor","exit_code":1}}),
        ];
        fs::write(
            tool_dir.join("claude-s1.jsonl"),
            lines.iter().map(|v| v.to_string()).collect::<Vec<_>>().join("\n") + "\n",
        )
        .unwrap();
        fs::write(
            gate_dir.join("claude-s1.jsonl"),
            serde_json::json!({"v":2,"ts":Utc::now().to_rfc3339(),"type":"gate","event":"Gate","data":{"gate":{"hook":"guard","rule":"config-dump","decision":"deny"}}}).to_string() + "\n",
        )
        .unwrap();

        let paths = WorkspacePaths {
            workspace: PathBuf::from("/tmp"),
            data_dir: tmp.clone(),
            audit_root: tmp.clone(),
            has_workspace_marker: true,
            is_plugin_mode: false,
        };

        let by_cmd = run_observe(&paths, &ObserveParams { since: Some("1d".into()), by: Some("cmd".into()), limit: None, project: None }).unwrap();
        assert_eq!(by_cmd.items.len(), 2);

        let by_mcp = run_observe(&paths, &ObserveParams { since: Some("1d".into()), by: Some("mcp".into()), limit: None, project: None }).unwrap();
        assert_eq!(by_mcp.items[0].key, "mem");
        assert_eq!(by_mcp.items[0].p50_ms, Some(8));

        let by_hook = run_observe(&paths, &ObserveParams { since: Some("1d".into()), by: Some("hook".into()), limit: None, project: None }).unwrap();
        assert_eq!(by_hook.items[0].key, "guard:config-dump:deny");
        assert_eq!(by_hook.items[0].err, 1);

        let by_ev = run_observe(&paths, &ObserveParams { since: Some("1d".into()), by: Some("event".into()), limit: None, project: None }).unwrap();
        assert!(!by_ev.items.is_empty());

        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn observe_by_hook_counts_recorded_gate_once() {
        let tmp = std::env::temp_dir().join(format!("harness-obs-once-{}", std::process::id()));
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(&tmp).unwrap();
        let paths = WorkspacePaths {
            workspace: PathBuf::from("/tmp"),
            data_dir: tmp.clone(),
            audit_root: tmp.clone(),
            has_workspace_marker: true,
            is_plugin_mode: false,
        };
        let payload = serde_json::json!({
            "hook_event_name": "PreToolUse",
            "session_id": "s-obs",
            "cwd": "/tmp",
            "tool_name": "Bash",
            "tool_input": {"command": "cat .env"}
        });
        let inp = crate::host::parse_stdin(
            crate::host::Host::Claude,
            Some("PreToolUse"),
            payload.to_string().as_bytes(),
        )
        .unwrap();
        let outcome = crate::host::HookOutcome {
            decision: Some(crate::host::Decision::Deny),
            reason: Some("blocked".to_string()),
            rule_id: Some("config-dump".to_string()),
            hook_name: Some("guard".to_string()),
            ..Default::default()
        };
        crate::audit::record_hook(&inp, &outcome, &paths);
        let res = run_observe(
            &paths,
            &ObserveParams {
                since: Some("1d".into()),
                by: Some("hook".into()),
                limit: None,
                project: None,
            },
        )
        .unwrap();
        assert_eq!(res.items.len(), 1);
        assert_eq!(res.items[0].key, "guard:config-dump:deny");
        assert_eq!(res.items[0].count, 1, "gate event must be counted exactly once");
        let _ = fs::remove_dir_all(&tmp);
    }
}

#[cfg(test)]
mod tests_t9a {
    use super::*;
    use std::path::PathBuf;

    fn mk(name: &str) -> (PathBuf, WorkspacePaths) {
        let tmp = std::env::temp_dir().join(format!("harness-t9a-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(&tmp).unwrap();
        let p = WorkspacePaths {
            workspace: PathBuf::from("/tmp"),
            data_dir: tmp.clone(),
            audit_root: tmp.clone(),
            has_workspace_marker: true,
            is_plugin_mode: false,
        };
        (tmp, p)
    }

    fn params(by: &str) -> ObserveParams {
        ObserveParams { since: Some("30d".into()), by: Some(by.into()), limit: None, project: None }
    }

    fn put(root: &std::path::Path, days_ago: i64, lines: &[Value]) {
        let d = (Utc::now() - Duration::days(days_ago)).format("%Y-%m-%d").to_string();
        let dir = root.join(format!("date={d}")).join("type=tool");
        fs::create_dir_all(&dir).unwrap();
        let body: String = lines.iter().map(|v| v.to_string() + "\n").collect();
        fs::write(dir.join("claude-s1.jsonl"), body).unwrap();
    }

    fn ev(days_ago: i64, cmd: &str) -> Value {
        let ts = (Utc::now() - Duration::days(days_ago)).to_rfc3339();
        serde_json::json!({"v":2,"ts":ts,"type":"tool","event":"PostToolUse","tool":"Bash","ok":true,"data":{"cmd_line":format!("harness {cmd}")}})
    }

    #[test]
    fn observe_keeps_newest_when_capped() {
        let (tmp, paths) = mk("cap");
        for (i, c) in ["dayaaa", "daybbb", "daycc0"].iter().enumerate() {
            put(&tmp, i as i64, &[ev(i as i64, c)]);
        }
        let one = fs::metadata(
            fs::read_dir(tmp.join(format!("date={}", Utc::now().format("%Y-%m-%d"))).join("type=tool"))
                .unwrap().next().unwrap().unwrap().path(),
        ).unwrap().len();
        let res = run_observe_with(&paths, &params("cmd"), one * 2 + 1).unwrap();
        let keys: Vec<_> = res.items.iter().map(|i| i.key.as_str()).collect();
        assert!(keys.contains(&"dayaaa"), "newest day must be kept: {keys:?}");
        assert!(keys.contains(&"daybbb"));
        assert!(!keys.contains(&"daycc0"), "oldest day must be dropped: {keys:?}");
        assert!(res.truncated);
        assert_eq!(res.truncate_reason.as_deref(), Some("max_bytes"));
        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn observe_oversize_file_skipped_not_break() {
        let (tmp, paths) = mk("skip");
        put(&tmp, 0, &[ev(0, "newok")]);
        let big: Vec<Value> = (0..50).map(|_| ev(1, "bigone")).collect();
        put(&tmp, 1, &big);
        put(&tmp, 2, &[ev(2, "oldok")]);
        let one = fs::metadata(
            fs::read_dir(tmp.join(format!("date={}", Utc::now().format("%Y-%m-%d"))).join("type=tool"))
                .unwrap().next().unwrap().unwrap().path(),
        ).unwrap().len();
        let res = run_observe_with(&paths, &params("cmd"), one * 3).unwrap();
        let keys: Vec<_> = res.items.iter().map(|i| i.key.as_str()).collect();
        assert!(keys.contains(&"newok") && keys.contains(&"oldok"), "{keys:?}");
        assert!(!keys.contains(&"bigone"));
        assert!(res.truncated);
        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn observe_streams_without_vec() {
        let (tmp, paths) = mk("stream");
        let lines: Vec<Value> = (0..200_000).map(|_| ev(0, "doctor")).collect();
        put(&tmp, 0, &lines);
        let t = Instant::now();
        let res = run_observe(&paths, &params("cmd")).unwrap();
        assert_eq!(res.events_scanned, 200_000);
        assert_eq!(res.items[0].count, 200_000);
        // 2s in release; the unoptimized test profile is ~20x slower, so only guard against blow-ups there.
        let limit = if cfg!(debug_assertions) { 30.0 } else { 2.0 };
        assert!(t.elapsed().as_secs_f64() < limit, "took {:?}", t.elapsed());
        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn observe_regex_compiled_once() {
        let a = harness_regexes() as *const _;
        let b = harness_regexes() as *const _;
        assert!(std::ptr::eq(a, b));
        assert_eq!(parse_harness_call("cd x && harness data ls"), Some(("data".into(), Some("ls".into()))));
    }

    #[test]
    fn observe_by_model_sums_tokens() {
        let (tmp, paths) = mk("model");
        let now = Utc::now();
        // Stop usage is CUMULATIVE per (sid, agent_id): only the newest-ts event counts, whatever the file order.
        let stop = |sid: &str, agent: Option<&str>, model: &str, i: u64, o: u64, secs_ago: i64, trunc: bool| {
            let ts = (now - Duration::seconds(secs_ago)).to_rfc3339();
            let mut v = serde_json::json!({"v":2,"ts":ts,"type":"lifecycle","event":"Stop","sid":sid,"model":model,
                "tokens_in":i,"tokens_out":o,"data":{"cache_read":7,"cache_create":3}});
            if let Some(a) = agent { v["agent_id"] = a.into(); v["agent_type"] = "builder".into(); }
            if trunc { v["data"]["usage_truncated"] = true.into(); }
            v
        };
        let ts = now.to_rfc3339();
        put(&tmp, 0, &[
            stop("s1", None, "opus", 20, 200, 0, false),
            stop("s1", None, "opus", 5, 50, 20, false),
            stop("s1", None, "opus", 12, 120, 10, false),
            stop("s2", Some("a1"), "opus", 1, 7, 0, true),
            stop("s3", None, "sonnet", 1, 2, 0, false),
            serde_json::json!({"v":2,"ts":ts,"type":"gate","event":"Gate","data":{"gate":{"hook":"guard","rule":"r","decision":"deny"}}}),
        ]);
        let m = run_observe(&paths, &params("model")).unwrap();
        let opus = m.items.iter().find(|i| i.key == "opus").unwrap();
        assert_eq!((opus.count, opus.tokens_in, opus.tokens_out), (2, Some(21), Some(207)));
        assert_eq!((opus.cache_read, opus.cache_create), (Some(14), Some(6)));
        assert_eq!(m.items.len(), 2, "events without tokens are not counted");
        assert_eq!(m.usage_truncated, 1, "truncated usage must surface");
        let a = run_observe(&paths, &params("agent")).unwrap();
        assert_eq!(a.items.iter().find(|i| i.key == "builder").unwrap().tokens_out, Some(7));
        assert_eq!(a.items.iter().find(|i| i.key == "main").unwrap().tokens_out, Some(202));
        let d = run_observe(&paths, &params("decision")).unwrap();
        assert_eq!(d.items[0].key, "deny");
        let r = run_report(&paths, 7).unwrap();
        assert_eq!(r.days.len(), 1);
        assert_eq!(r.days[0].tokens_out, 209);
        assert_eq!(r.days[0].denies, 1);
        let _ = fs::remove_dir_all(&tmp);
    }
}
