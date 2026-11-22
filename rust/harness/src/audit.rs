use crate::config::{audit_max_file_bytes, ensure_data_ignore, normalize_slashes, WorkspacePaths};
use crate::host::{HookInput, HookOutcome, Host};
use chrono::{SecondsFormat, Utc};
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

const MAX_PARTS: usize = 50;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EnvelopeV2 {
    pub v: u8,
    pub ts: String,
    #[serde(rename = "type")]
    pub rec_type: String,
    pub event: String,
    pub cli: String,
    pub sid: String,
    pub agent_id: Option<String>,
    pub agent_type: Option<String>,
    pub actor: String,
    pub project: Option<String>,
    pub cwd: String,
    pub tool: Option<String>,
    pub target: Option<String>,
    pub target_kind: Option<String>,
    pub ok: Option<bool>,
    pub dur_ms: Option<i64>,
    pub turns: Option<u64>,
    pub tokens_in: Option<u64>,
    pub tokens_out: Option<u64>,
    pub status: Option<String>,
    pub model: Option<String>,
    pub summary: String,
    pub data: Value,
    pub origin: Option<String>,
}

pub fn record_hook(input: &HookInput, outcome: &HookOutcome, paths: &WorkspacePaths) {
    // Strictly fail-open: never panic, never propagate IO errors.
    let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        ensure_data_ignore(paths);
        let max_bytes = audit_max_file_bytes();
        let root = &paths.audit_root;

        if input.host == Host::Agy && input.event == "PreToolUse" && outcome.decision.is_none() {
            // Matching adapters/agy.mjs: write timing marker on PreToolUse allow.
            write_agy_pre_marker(root, input);
            return;
        }

        let env = build_envelope(input, outcome, root);
        write_envelope(&env, root, max_bytes);

        if let Some(decision) = outcome.decision {
            let gate = build_gate_envelope(input, outcome, decision.as_str(), &env.sid);
            write_envelope(&gate, root, max_bytes);
        }
    }));
}

pub fn build_envelope(input: &HookInput, _outcome: &HookOutcome, audit_root: &Path) -> EnvelopeV2 {
    let now = Utc::now();
    let ts = now.to_rfc3339_opts(SecondsFormat::Millis, true);
    let event = input.event.clone();
    let rec_type = event_type(&event).to_string();
    let cli = input.host.as_str().to_string();
    let cwd_raw = input
        .workspace_cwd
        .as_deref()
        .or_else(|| input.workspace_paths.first().map(String::as_str))
        .or(input.tool_cwd.as_deref())
        .unwrap_or("");
    let cwd = cut(cwd_raw, 240);
    let sid = build_sid(&cli, input.session_id.as_deref(), cwd_raw);

    let agent_id = input
        .raw
        .get("agent_id")
        .and_then(Value::as_str)
        .map(|s| cut(s, 80));
    let agent_type = input
        .raw
        .get("agent_type")
        .and_then(Value::as_str)
        .map(|s| cut(s, 60));
    let actor = if agent_id.is_some() || agent_type.is_some() {
        "sub".to_string()
    } else {
        "main".to_string()
    };
    let project = project_of(cwd_raw);
    let tool = input.tool_name.clone();

    let mut data = Map::new();
    let (target, target_kind) = extract_target(tool.as_deref(), &input.tool_input, &mut data);

    if let Some(tuid) = &input.tool_use_id {
        let clean_id: String = tuid
            .chars()
            .filter(|c| c.is_ascii_alphanumeric() || *c == '_' || *c == '-')
            .take(80)
            .collect();
        if !clean_id.is_empty() {
            data.insert("tool_use_id".to_string(), Value::String(clean_id));
        }
    }

    if let Some(err) = input.raw.get("error").and_then(Value::as_str) {
        let cleaned = cut(&collapse_ws(&mask_secrets(err)), 200);
        if !cleaned.is_empty() {
            data.insert("error".to_string(), Value::String(cleaned));
        }
        if let Some(code) = extract_exit_code(err) {
            data.insert("exit_code".to_string(), Value::Number(code.into()));
        }
    }
    if let Ok(tid) = std::env::var("HUB_TASK_ID") {
        let s = safe_id(&tid, 80);
        if !s.is_empty() {
            data.insert("task_id".to_string(), Value::String(s));
        }
    }

    let (mut ok, mut status) = detect_status(input, &event);
    let mut dur_ms = input
        .raw
        .get("duration_ms")
        .or_else(|| input.raw.get("durationMs"))
        .or_else(|| input.raw.get("duration"))
        .and_then(Value::as_i64);

    if input.host == Host::Agy && tool.is_some() && dur_ms.is_none() {
        if let Some(step) = input.raw.get("stepIdx").and_then(Value::as_i64) {
            dur_ms = take_agy_pre_marker(audit_root, input.session_id.as_deref(), step);
        }
    }

    if input.host == Host::Agy && event == "Stop" {
        if let Some(tr) = input.raw.get("terminationReason").and_then(Value::as_str) {
            data.insert("stop_reason".to_string(), Value::String(cut(tr, 60)));
            if tr.starts_with("ERROR") || tr.starts_with("MAX_") {
                ok = Some(false);
                status = Some("error".to_string());
            }
        }
    }

    let model = input
        .raw
        .get("model")
        .or_else(|| input.raw.get("modelName"))
        .and_then(Value::as_str)
        .map(|s| cut(s, 60));

    let mut model = model;
    let mut turns = input.raw.get("turns").and_then(Value::as_u64);
    let mut tokens_in = input.raw.get("tokens_in").and_then(Value::as_u64);
    let mut tokens_out = input.raw.get("tokens_out").and_then(Value::as_u64);
    if input.host == Host::Claude && matches!(event.as_str(), "Stop" | "SubagentStop") {
        // SubagentStop: agent transcript only (a session transcript would assign session totals to the agent).
        let keys: &[&str] = if event == "SubagentStop" {
            &["agent_transcript_path"]
        } else {
            &["transcript_path"]
        };
        if let Some(u) = keys.iter().find_map(|k| {
            input
                .raw
                .get(*k)
                .and_then(Value::as_str)
                .and_then(|p| read_transcript_usage(Path::new(p)))
        }) {
            if u.truncated {
                data.insert("usage_truncated".to_string(), true.into());
            }
            turns = Some(u.turns);
            tokens_in = Some(u.tokens_in);
            tokens_out = Some(u.tokens_out);
            if u.model.is_some() {
                model = u.model;
            }
            data.insert("cache_read".to_string(), u.cache_read.into());
            data.insert("cache_create".to_string(), u.cache_create.into());
        }
    }
    let origin = Some(origin_of(cwd_raw).to_string());

    let mut env = EnvelopeV2 {
        v: 2,
        ts,
        rec_type,
        event,
        cli,
        sid,
        agent_id,
        agent_type,
        actor,
        project,
        cwd,
        tool,
        target,
        target_kind,
        ok,
        dur_ms,
        turns,
        tokens_in,
        tokens_out,
        status,
        model,
        summary: String::new(),
        data: Value::Object(data),
        origin,
    };
    env.summary = summarize(&env);
    env
}

fn build_gate_envelope(
    input: &HookInput,
    outcome: &HookOutcome,
    decision: &str,
    sid: &str,
) -> EnvelopeV2 {
    let ts = Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true);
    let hook = outcome.hook_name.as_deref().unwrap_or("harness");
    let rule = outcome.rule_id.as_deref();
    let masked_reason = outcome
        .reason
        .as_deref()
        .map(|r| cut(&collapse_ws(&mask_secrets(r)), 200));
    let cwd_raw = input
        .workspace_cwd
        .as_deref()
        .or_else(|| input.workspace_paths.first().map(String::as_str))
        .or(input.tool_cwd.as_deref())
        .unwrap_or("");
    let agent_id = input
        .raw
        .get("agent_id")
        .and_then(Value::as_str)
        .map(|s| cut(s, 80));
    let agent_type = input
        .raw
        .get("agent_type")
        .and_then(Value::as_str)
        .map(|s| cut(s, 60));
    let actor = if agent_id.is_some() || agent_type.is_some() {
        "sub".to_string()
    } else {
        "main".to_string()
    };
    let who = if actor == "sub" {
        agent_type.as_deref().unwrap_or("sub")
    } else {
        "main"
    };
    let rule_part = rule.map(|r| format!(":{r}")).unwrap_or_default();
    let reason_part = masked_reason
        .as_deref()
        .map(|r| format!(" | {r}"))
        .unwrap_or_default();
    let summary = cut(
        &format!("{who} gate {decision} {hook}{rule_part}{reason_part}"),
        120,
    );

    EnvelopeV2 {
        v: 2,
        ts,
        rec_type: "gate".to_string(),
        event: "Gate".to_string(),
        cli: input.host.as_str().to_string(),
        sid: sid.to_string(),
        agent_id,
        agent_type,
        actor,
        project: project_of(cwd_raw),
        cwd: cut(cwd_raw, 240),
        tool: input.tool_name.clone(),
        target: None,
        target_kind: None,
        ok: None,
        dur_ms: None,
        turns: None,
        tokens_in: None,
        tokens_out: None,
        status: Some(decision.to_string()),
        model: None,
        summary,
        data: json!({
            "gate": {
                "kind": "gate",
                "decision": decision,
                "hook": safe_id(hook, 40),
                "rule": rule.map(|r| safe_id(r, 80)),
                "reason": masked_reason,
                "tool": input.tool_name.as_deref().map(|t| safe_id(t, 40)),
            }
        }),
        origin: Some(origin_of(cwd_raw).to_string()),
    }
}

pub fn write_envelope(env: &EnvelopeV2, root: &Path, max_file_bytes: u64) {
    let Ok(json_line) = serde_json::to_string(env) else {
        return;
    };
    let line = format!("{json_line}\n");
    let date_part = env.ts.get(..10).unwrap_or("1970-01-01");
    let dir = root
        .join(format!("date={date_part}"))
        .join(format!("type={}", env.rec_type));
    let new_day = !root.join(format!("date={date_part}")).exists();
    if fs::create_dir_all(&dir).is_err() {
        return;
    }
    append_line(&dir, &env.sid, &line, max_file_bytes);
    // prune AFTER the event is written (once per new date partition, fail-open) so a slow first
    // prune can never lose the triggering event
    if new_day {
        prune_old_partitions(root, date_part, crate::data::audit_retention_days(), MAX_PRUNE_DIRS);
    }
}

fn append_line(dir: &Path, sid: &str, line: &str, max_file_bytes: u64) {
    let len = line.len() as u64;
    let Some(target) = pick_partition_file(dir, sid, max_file_bytes, len) else {
        return;
    };

    if let Ok(meta) = fs::metadata(&target) {
        if meta.len() > 0 && meta.len().saturating_add(len) > max_file_bytes {
            return;
        }
    }

    if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(&target) {
        let _ = file.write_all(line.as_bytes());
    }
}

const MAX_PRUNE_DIRS: usize = 64;

/// Delete `date=YYYY-MM-DD` dirs directly under `root` older than `days` before `today`.
/// Bounded by `cap`, never follows symlinks, fail-open.
pub(crate) fn prune_old_partitions(root: &Path, today: &str, days: u64, cap: usize) {
    let Ok(today) = chrono::NaiveDate::parse_from_str(today, "%Y-%m-%d") else {
        return;
    };
    let Some(cutoff) = today.checked_sub_days(chrono::Days::new(days)) else {
        return;
    };
    let Ok(rd) = fs::read_dir(root) else {
        return;
    };
    let mut removed = 0;
    for ent in rd.flatten().take(cap * 8) {
        if removed >= cap {
            break;
        }
        let name = ent.file_name();
        let Some(d) = name.to_str().and_then(|n| n.strip_prefix("date=")) else {
            continue;
        };
        let Ok(date) = chrono::NaiveDate::parse_from_str(d, "%Y-%m-%d") else {
            continue;
        };
        if date >= cutoff {
            continue;
        }
        let path = ent.path();
        match fs::symlink_metadata(&path) {
            Ok(m) if m.is_dir() && !m.file_type().is_symlink() => {
                let _ = fs::remove_dir_all(&path);
                removed += 1;
            }
            _ => {}
        }
    }
}

fn pick_partition_file(dir: &Path, sid: &str, max_bytes: u64, add_len: u64) -> Option<PathBuf> {
    let clean_sid = safe_id(sid, 80);
    let sid_name = if clean_sid.is_empty() {
        "nosession"
    } else {
        clean_sid.as_str()
    };
    for n in 0..MAX_PARTS {
        let name = if n == 0 {
            format!("{sid_name}.jsonl")
        } else {
            format!("{sid_name}.{n}.jsonl")
        };
        let cand = dir.join(name);
        match fs::metadata(&cand) {
            Ok(meta) => {
                let sz = meta.len();
                if sz == 0 || sz.saturating_add(add_len) <= max_bytes {
                    return Some(cand);
                }
            }
            Err(_) => return Some(cand),
        }
    }
    None
}

pub fn event_type(event: &str) -> &'static str {
    match event {
        "PreToolUse" | "PostToolUse" | "PostToolUseFailure" | "PostToolBatch" => "tool",
        "SessionStart" | "SessionEnd" | "Stop" | "PostInvocation" | "PreInvocation" | "Setup" => {
            "session"
        }
        "SubagentStart" | "SubagentStop" => "subagent",
        "UserPromptSubmit" | "UserPromptExpansion" => "prompt",
        "PermissionRequest" | "PermissionDenied" | "Notification" => "permission",
        "Gate" | "Approval" => "gate",
        "HookRun" => "hook",
        _ => "other",
    }
}

pub fn build_sid(cli: &str, raw_sid: Option<&str>, cwd: &str) -> String {
    let cleaned: String = raw_sid
        .unwrap_or("")
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '_' || *c == '-')
        .take(64)
        .collect();
    let base = if !cleaned.is_empty() {
        cleaned
    } else {
        // Hook's own pid differs per call; the parent (the CLI) is stable across a session.
        return finish_sid(cli, &sid_for_pid(cli, cwd, parent_pid()));
    };
    finish_sid(cli, &base)
}

const TRANSCRIPT_TAIL_BYTES: u64 = 8 * 1024 * 1024;
const TRANSCRIPT_DEADLINE_MS: u128 = 150;

struct TranscriptUsage {
    turns: u64,
    tokens_in: u64,
    tokens_out: u64,
    cache_read: u64,
    cache_create: u64,
    model: Option<String>,
    truncated: bool,
}

/// Sums `message.usage` over assistant messages in the transcript tail (numbers only, never text).
/// A streamed message repeats under one `message.id`; the last usage per id wins (verified on a real
/// transcript: the last line of each id carries the final output_tokens).
/// The numbers are cumulative for the session as of this Stop: consumers must take the latest
/// Stop per session, not add Stops together. `truncated` = tail cut or deadline hit (partial sum).
/// Fail-open: any IO/parse problem yields None or a partial sum.
fn read_transcript_usage(path: &Path) -> Option<TranscriptUsage> {
    use std::io::{Read, Seek, SeekFrom};
    let start = std::time::Instant::now();
    let mut f = fs::File::open(path).ok()?;
    let meta = f.metadata().ok()?;
    if !meta.is_file() {
        return None;
    }
    let len = meta.len();
    let skip_first = len > TRANSCRIPT_TAIL_BYTES;
    if skip_first {
        f.seek(SeekFrom::Start(len - TRANSCRIPT_TAIL_BYTES)).ok()?;
    }
    let mut buf = Vec::new();
    f.take(TRANSCRIPT_TAIL_BYTES).read_to_end(&mut buf).ok()?;
    let text = String::from_utf8_lossy(&buf);
    let mut lines = text.lines();
    if skip_first {
        lines.next(); // partial line at the cut
    }
    let mut by_id: Vec<(String, [u64; 4])> = Vec::new();
    let mut index: HashMap<String, usize> = HashMap::new();
    let mut model = None;
    let mut truncated = skip_first;
    for (n, line) in lines.enumerate() {
        if n % 256 == 0 && start.elapsed().as_millis() > TRANSCRIPT_DEADLINE_MS {
            truncated = true;
            break;
        }
        if !line.contains("\"usage\"") {
            continue;
        }
        let Ok(v) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        if v.get("type").and_then(Value::as_str) != Some("assistant") {
            continue;
        }
        let Some(msg) = v.get("message") else { continue };
        let Some(u) = msg.get("usage") else { continue };
        let g = |k: &str| u.get(k).and_then(Value::as_u64).unwrap_or(0);
        let vals = [
            g("input_tokens"),
            g("output_tokens"),
            g("cache_read_input_tokens"),
            g("cache_creation_input_tokens"),
        ];
        if let Some(m) = msg.get("model").and_then(Value::as_str) {
            model = Some(cut(m, 60));
        }
        let id = msg
            .get("id")
            .and_then(Value::as_str)
            .map_or_else(|| format!("#{n}"), str::to_string);
        match index.get(&id) {
            Some(&i) => by_id[i].1 = vals,
            None => {
                index.insert(id.clone(), by_id.len());
                by_id.push((id, vals));
            }
        }
    }
    if by_id.is_empty() {
        return None;
    }
    let sum = |i: usize| by_id.iter().map(|(_, v)| v[i]).sum::<u64>();
    Some(TranscriptUsage {
        turns: by_id.len() as u64,
        tokens_in: sum(0),
        tokens_out: sum(1),
        cache_read: sum(2),
        cache_create: sum(3),
        model,
        truncated,
    })
}

fn parent_pid() -> u32 {
    #[cfg(unix)]
    {
        std::os::unix::process::parent_id()
    }
    #[cfg(not(unix))]
    {
        std::process::id() // shortcut: no ppid in std on non-unix; sid is per-call there.
    }
}

fn sid_for_pid(cli: &str, cwd: &str, pid: u32) -> String {
    let seed = format!("{cli}|{cwd}|{pid}");
    let mut h: u32 = 5381;
    for b in seed.bytes() {
        h = h.wrapping_mul(33) ^ (b as u32);
    }
    format!("nosession-{}", to_base36(h))
}

fn finish_sid(cli: &str, base: &str) -> String {
    let prefix = format!("{cli}-");
    if base.starts_with(&prefix) {
        base.to_string()
    } else {
        format!("{prefix}{base}")
    }
}

fn to_base36(mut n: u32) -> String {
    if n == 0 {
        return "0".to_string();
    }
    const CHARS: &[u8] = b"0123456789abcdefghijklmnopqrstuvwxyz";
    let mut buf = Vec::new();
    while n > 0 {
        buf.push(CHARS[(n % 36) as usize]);
        n /= 36;
    }
    buf.reverse();
    String::from_utf8(buf).unwrap_or_else(|_| "0".to_string())
}

pub fn project_of(cwd: &str) -> Option<String> {
    let norm = normalize_slashes(cwd);
    let trimmed = norm.trim_end_matches('/');
    if trimmed.is_empty() {
        return None;
    }
    let base = if let Some(idx) = trimmed
        .find("/.claude/worktrees/")
        .or_else(|| trimmed.find("/.worktrees/"))
    {
        &trimmed[..idx]
    } else {
        trimmed
    };
    let name = base.rsplit('/').next().unwrap_or("");
    if name.is_empty() {
        None
    } else {
        Some(cut(name, 80))
    }
}

fn origin_of(cwd: &str) -> &'static str {
    for raw_seg in cwd.split(['/', '\\']) {
        let seg = raw_seg.to_ascii_lowercase();
        if seg == "bench"
            || seg == "mcp-test"
            || seg.starts_with("scratch")
            || seg.starts_with("zz-eval")
        {
            return "noise";
        }
    }
    "work"
}

fn extract_target(
    tool: Option<&str>,
    ti: &Value,
    data: &mut Map<String, Value>,
) -> (Option<String>, Option<String>) {
    let Some(tname) = tool else {
        return (None, None);
    };
    match tname {
        "Bash" | "PowerShell" => {
            let cmd = ti.get("command").and_then(Value::as_str).unwrap_or("");
            if let Some(to) = ti.get("timeout").and_then(Value::as_i64) {
                data.insert("has_timeout".to_string(), Value::Number(to.into()));
            } else {
                data.insert("has_timeout".to_string(), Value::Null);
            }
            data.insert(
                "bg".to_string(),
                Value::Bool(ti.get("run_in_background").and_then(Value::as_bool) == Some(true)),
            );
            if cmd.is_empty() {
                return (None, None);
            }
            let masked = mask_secrets(cmd);
            let target = cut(&masked, 160);
            data.insert(
                "target_truncated".to_string(),
                Value::Bool(masked.chars().count() > 160),
            );
            let first_line = masked.lines().next().unwrap_or("").trim();
            data.insert(
                "cmd_line".to_string(),
                Value::String(cut(&mask_leading_env_values(first_line), 100)),
            );
            let rest = strip_leading_cd_and_env(first_line);
            if let Some(head) = rest.split_whitespace().next() {
                data.insert("cmd_head".to_string(), Value::String(cut(head, 40)));
            }
            (Some(target), Some("command".to_string()))
        }
        "Read" | "Write" | "Edit" | "MultiEdit" | "NotebookEdit" => {
            let fp = ti
                .get("file_path")
                .or_else(|| ti.get("notebook_path"))
                .or_else(|| ti.get("path"))
                .and_then(Value::as_str);
            let Some(p) = fp else {
                return (None, None);
            };
            let target = path_target(p);
            (Some(target), Some("path".to_string()))
        }
        "WebFetch" => {
            let Some(u) = ti.get("url").and_then(Value::as_str) else {
                return (None, None);
            };
            (Some(url_target(u)), Some("url".to_string()))
        }
        "WebSearch" => {
            let q = ti.get("query").and_then(Value::as_str);
            (
                q.map(|s| cut(&mask_secrets(s), 120)),
                q.map(|_| "other".to_string()),
            )
        }
        "Grep" | "Glob" => {
            let pat = ti.get("pattern").and_then(Value::as_str);
            (
                pat.map(|s| cut(&mask_secrets(s), 120)),
                pat.map(|_| "other".to_string()),
            )
        }
        "Agent" | "Task" => {
            let sub = ti.get("subagent_type").and_then(Value::as_str);
            if let Some(m) = ti.get("model").and_then(Value::as_str) {
                data.insert("model".to_string(), Value::String(cut(m, 40)));
            }
            (
                sub.map(|s| cut(s, 80)),
                sub.map(|_| "other".to_string()),
            )
        }
        "MCP" => {
            if let Some(srv) = ti.get("server").and_then(Value::as_str) {
                data.insert("server".to_string(), Value::String(cut(srv, 60)));
            }
            if let Some(tn) = ti.get("tool_name").and_then(Value::as_str) {
                data.insert("tool_name".to_string(), Value::String(cut(tn, 60)));
            }
            let pat = ti
                .get("name")
                .or_else(|| ti.get("pattern"))
                .or_else(|| ti.get("tool_name"))
                .and_then(Value::as_str);
            (
                pat.map(|s| cut(&mask_secrets(s), 120)),
                pat.map(|_| "other".to_string()),
            )
        }
        _ => {
            for k in ["file_path", "path", "url", "command", "pattern"] {
                if let Some(v) = ti.get(k).and_then(Value::as_str) {
                    let kind = if k == "url" {
                        "url"
                    } else if k == "command" {
                        "command"
                    } else if k.contains("path") {
                        "path"
                    } else {
                        "other"
                    };
                    return (
                        Some(cut(&mask_secrets(v), 160)),
                        Some(kind.to_string()),
                    );
                }
            }
            (None, None)
        }
    }
}

fn path_target(p: &str) -> String {
    let base = p.rsplit(['/', '\\']).next().unwrap_or(p);
    let lower = base.to_ascii_lowercase();
    if lower.starts_with(".env")
        || lower == "access.json"
        || lower.ends_with(".pem")
        || lower.ends_with(".key")
    {
        return base.to_string();
    }
    cut(&mask_secrets(p), 200)
}

fn url_target(u: &str) -> String {
    let masked = mask_secrets(u);
    let without_query = masked.split(['?', '#']).next().unwrap_or(&masked);
    if let Some((_, rest)) = without_query.split_once("://") {
        let host_path = match rest.find('@') {
            Some(at) => &rest[at + 1..],
            None => rest,
        };
        return cut(host_path, 160);
    }
    cut(without_query, 160)
}

fn strip_leading_cd_and_env(s: &str) -> &str {
    let mut cur = s.trim_start();
    if let Some(re) = audit_re(r#"(?i)^cd\s+(?:/d\s+)?(?:"[^"]*"|'[^']*'|[^\s&;|]+)\s*(?:&&|;)\s*"#) {
        if let Some(m) = re.find(cur) {
            cur = cur[m.end()..].trim_start();
        }
    }
    if let Some(env_re) = audit_re(r#"^\w+=(?:"[^"]*"|'[^']*'|\S*)\s+"#) {
        for _ in 0..10 {
            if let Some(m) = env_re.find(cur) {
                cur = cur[m.end()..].trim_start();
            } else {
                break;
            }
        }
    }
    cur
}

fn mask_leading_env_values(s: &str) -> String {
    let mut cur = s;
    let mut prefix = String::new();
    if let Some(env_re) = audit_re(r#"^(\w+)=(?:"[^"]*"|'[^']*'|\S*)\s+"#) {
        for _ in 0..10 {
            if let Some(caps) = env_re.captures(cur) {
                let m = caps.get(0).unwrap();
                let k = caps.get(1).map_or("", |c| c.as_str());
                prefix.push_str(k);
                prefix.push_str("=*** ");
                cur = &cur[m.end()..];
            } else {
                break;
            }
        }
    }
    format!("{prefix}{cur}")
}

fn non_zero_exit_code_val(v: Option<&Value>) -> bool {
    match v {
        Some(Value::Number(n)) => n.as_i64().is_some_and(|c| c != 0),
        Some(Value::String(s)) => s.trim().parse::<i64>().is_ok_and(|c| c != 0),
        _ => false,
    }
}

fn non_empty_error_val(v: Option<&Value>) -> bool {
    match v {
        Some(Value::String(s)) => !s.trim().is_empty(),
        Some(Value::Object(m)) => !m.is_empty(),
        Some(Value::Array(a)) => !a.is_empty(),
        Some(Value::Bool(b)) => *b,
        Some(Value::Number(_)) => true,
        _ => false,
    }
}

fn str_has_exited_nonzero(s: &str) -> bool {
    const PREFIX: &str = "Command exited with code ";
    let mut rest = s;
    while let Some(idx) = rest.find(PREFIX) {
        let after = &rest[idx + PREFIX.len()..];
        let trimmed = after.trim_start_matches(' ');
        let mut num_len = 0usize;
        for (i, ch) in trimmed.char_indices() {
            if (i == 0 && ch == '-') || ch.is_ascii_digit() {
                num_len = i + ch.len_utf8();
            } else {
                break;
            }
        }
        if num_len > 0 {
            if let Ok(code) = trimmed[..num_len].parse::<i64>() {
                if code != 0 {
                    return true;
                }
            }
        }
        rest = &rest[idx + PREFIX.len()..];
    }
    false
}

fn has_command_exited_nonzero(input: &HookInput) -> bool {
    if let Some(tr) = &input.tool_response {
        if let Some(s) = tr.as_str() {
            if str_has_exited_nonzero(s) {
                return true;
            }
        } else if let Some(obj) = tr.as_object() {
            for k in ["stdout", "stderr", "output", "content", "text", "message"] {
                if obj.get(k).and_then(Value::as_str).is_some_and(str_has_exited_nonzero) {
                    return true;
                }
            }
        }
    }
    input
        .raw
        .get("output")
        .and_then(Value::as_str)
        .is_some_and(str_has_exited_nonzero)
}

fn detect_status(input: &HookInput, event: &str) -> (Option<bool>, Option<String>) {
    let tr = input.tool_response.as_ref().and_then(Value::as_object);
    match event {
        "PreToolUse" => (None, Some("started".to_string())),
        "PostToolUse" => {
            let is_err_flag = tr.and_then(|o| o.get("is_error")).and_then(Value::as_bool)
                == Some(true)
                || tr.and_then(|o| o.get("isError")).and_then(Value::as_bool) == Some(true);
            let has_nz_exit = non_zero_exit_code_val(tr.and_then(|o| o.get("exitCode")))
                || non_zero_exit_code_val(tr.and_then(|o| o.get("exit_code")))
                || non_zero_exit_code_val(input.raw.get("exitCode"))
                || non_zero_exit_code_val(input.raw.get("exit_code"));
            let has_err_field = non_empty_error_val(input.raw.get("error"))
                || non_empty_error_val(tr.and_then(|o| o.get("error")));

            if tr.and_then(|o| o.get("interrupted")).and_then(Value::as_bool) == Some(true) {
                (Some(false), Some("interrupted".to_string()))
            } else if tr.and_then(|o| o.get("ok")).and_then(Value::as_bool) == Some(false)
                || tr
                    .and_then(|o| o.get("success"))
                    .and_then(Value::as_bool)
                    == Some(false)
                || is_err_flag
                || has_nz_exit
                || has_err_field
                || has_command_exited_nonzero(input)
                || tr
                    .and_then(|o| o.get("status"))
                    .and_then(Value::as_str)
                    .is_some_and(|s| matches!(s.to_ascii_lowercase().as_str(), "error" | "failed" | "failure"))
            {
                (Some(false), Some("error".to_string()))
            } else {
                let st = tr
                    .and_then(|o| o.get("status"))
                    .and_then(Value::as_str)
                    .map(|s| cut(s, 30))
                    .unwrap_or_else(|| "ok".to_string());
                (Some(true), Some(st))
            }
        }
        "PostToolUseFailure" => {
            let st = if input.raw.get("is_interrupt").and_then(Value::as_bool) == Some(true) {
                "interrupted"
            } else {
                "error"
            };
            (Some(false), Some(st.to_string()))
        }
        "Stop" | "SubagentStop" => (None, Some("stopped".to_string())),
        "PostInvocation" => (
            None,
            Some(
                input
                    .raw
                    .get("status")
                    .and_then(Value::as_str)
                    .map(|s| cut(s, 30))
                    .unwrap_or_else(|| "ok".to_string()),
            ),
        ),
        "SessionStart" => (
            None,
            input
                .raw
                .get("source")
                .and_then(Value::as_str)
                .map(|s| cut(s, 30))
                .or_else(|| {
                    if input.host == Host::Agy {
                        Some("agy".to_string())
                    } else {
                        None
                    }
                }),
        ),
        "SessionEnd" => (
            None,
            input
                .raw
                .get("reason")
                .and_then(Value::as_str)
                .map(|s| cut(s, 30)),
        ),
        _ => (None, None),
    }
}

fn summarize(e: &EnvelopeV2) -> String {
    let who = if e.actor == "sub" {
        e.agent_type.as_deref().unwrap_or("sub")
    } else {
        "main"
    };
    let mut s = if let Some(tool) = &e.tool {
        let st = e.status.as_deref().unwrap_or(&e.event);
        let tgt = e
            .target
            .as_deref()
            .map(|t| format!(": {t}"))
            .unwrap_or_default();
        let dur = e
            .dur_ms
            .map(|d| format!(" ({d}ms)"))
            .unwrap_or_default();
        format!("{who} {tool} {st}{tgt}{dur}")
    } else if let Some(tout) = e.tokens_out {
        let turns = e.turns.unwrap_or(0);
        let tin = e.tokens_in.unwrap_or(0);
        format!("{who} {}: {turns} turns, {tin}/{tout} tokens in/out", e.event)
    } else {
        let st = e
            .status
            .as_deref()
            .map(|x| format!(": {x}"))
            .unwrap_or_default();
        format!("{who} {}{st}", e.event)
    };
    if e.event == "PostToolUseFailure" {
        if let Some(err) = e.data.get("error").and_then(Value::as_str) {
            s.push_str(" | ");
            s.push_str(err);
        }
    }
    cut(&collapse_ws(&s), 120)
}

/// Replaces the value (string, object, array, scalar) of sensitive JSON keys with "***".
fn mask_json_fields(s: &str) -> String {
    let Some(re) = audit_re(
        r#"(?i)"((?:[a-z0-9]+[_-])*(?:token|password|passwd|(?-i:pwd)|secret|api[_-]?key|authorization|cookie))"\s*:\s*"#,
    ) else {
        return s.to_string();
    };
    let mut out = String::with_capacity(s.len());
    let mut pos = 0;
    while let Some(m) = re.find_at(s, pos) {
        let end = json_value_end(s, m.end());
        let key = &s[m.start()..m.end()];
        let key_end = key.rfind('"').map_or(key.len(), |i| i + 1);
        out.push_str(&s[pos..m.start()]);
        out.push_str(&key[..key_end]);
        out.push_str(r#":"***""#);
        pos = end.max(m.end());
    }
    out.push_str(&s[pos..]);
    out
}

/// End offset of the JSON value starting at `i`: string, balanced {..}/[..] (string-aware), or scalar.
fn json_value_end(s: &str, i: usize) -> usize {
    let b = s.as_bytes();
    let mut depth = 0usize;
    let mut in_str = false;
    let mut j = i;
    while j < b.len() {
        let c = b[j];
        if in_str {
            if c == b'\\' {
                j += 1;
            } else if c == b'"' {
                in_str = false;
                if depth == 0 {
                    return j + 1;
                }
            }
        } else {
            match c {
                b'"' => in_str = true,
                b'{' | b'[' => depth += 1,
                b'}' | b']' => {
                    if depth == 0 {
                        return j;
                    }
                    depth -= 1;
                    if depth == 0 {
                        return j + 1;
                    }
                }
                b',' if depth == 0 => return j,
                _ => {}
            }
        }
        j += 1;
    }
    b.len()
}

pub fn mask_secrets(input: &str) -> String {
    const HINTS: &[&str] = &[
        ":", "sk-", "sk_", "pk_", "rk_", "ghp_", "gho_", "ghu_", "ghs_", "ghr_", "github_pat_",
        "xox", "akia", "aiza", "eyj", "bearer", "token", "key", "secret", "pass", "pwd", "auth",
        "cookie", "--", "?", "://", "-p", "-b",
    ];
    let bytes = input.as_bytes();
    let may_contain_secret = HINTS.iter().any(|h| {
        let nb = h.as_bytes();
        bytes.len() >= nb.len() && bytes.windows(nb.len()).any(|w| w.eq_ignore_ascii_case(nb))
    });
    if !may_contain_secret {
        return input.to_string();
    }
    let mut s = input.to_string();

    // 0. Cookie headers/flags: mask the whole value ("a=1; b=2"), not just the first token.
    if let Some(re) = audit_re(r#"(?i)((?:set-)?cookie\s*[=:]\s*)(?:"[^"]*"|'[^']*'|[^\n'"]*)"#) {
        s = re.replace_all(&s, "$1***").into_owned();
    }
    if let Some(re) = audit_re(
        r#"\b((?:curl|wget|http|https|xh)(?:\.exe)?\b[^|;&\n]*?\s(?:-b|--cookie|--header-cookie)[\s=]+)(?:"[^"]*"|'[^']*'|\S+)"#,
    ) {
        s = re.replace_all(&s, "$1***").into_owned();
    }

    // 1. Key=value / key: value (Bearer / Basic / token / api_key / secret / password)
    // pwd is case-sensitive so the shell's PWD=/path is not masked.
    if let Some(re) = audit_re(
        r#"(?i)((?:api[_-]?key|access[_-]?key|token|secret|passw(?:or)?d|(?-i:pwd)|auth(?:orization)?|cookie)\s*[=:]\s*)(?:"[^"]*"|'[^']*'|(?:(?:bearer|basic|token|digest|negotiate|apikey)\s+)?\S+)"#,
    ) {
        s = re.replace_all(&s, "$1***").into_owned();
    }

    // 2. CLI secret flags (--token X, --password X, --api-key X, etc.)
    if let Some(re) = audit_re(
        r#"(?i)(--?(?:password|passwd|pass|pwd|token|auth-token|access-token|api[_-]?key|access[_-]?key|secret|client-secret)\s+)(?:"[^"]*"|'[^']*'|\S+)"#,
    ) {
        s = re.replace_all(&s, "$1***").into_owned();
    }

    // 3. DB CLI attached -p<password> (case-sensitive: -P is port)
    if let Some(re) = audit_re(
        r#"\b((?:mysql|mysqldump|mysqladmin|mariadb|psql)(?:\.exe)?\b[^|;&\n]*?\s-p)(?:"[^"]*"|'[^']*'|[^\s"']\S*)"#,
    ) {
        s = re.replace_all(&s, "${1}***").into_owned();
    }

    // 4. Standalone Bearer <token>
    if let Some(re) = audit_re(r"(?i)\b(bearer\s+)[A-Za-z0-9._~+/=-]{3,}") {
        s = re.replace_all(&s, "$1***").into_owned();
    }

    // 5. JSON fields "token": "..." (any prefix like x-/client_; string, object or array value)
    s = mask_json_fields(&s);

    // 6. Token prefixes (sk-/sk_/pk_/rk_, ghp_..., xox*, AKIA*, AIza*, JWT eyJ*, bot tokens)
    if let Some(re) = audit_re(
        r"\b(?:(?:sk|pk|rk)[-_][A-Za-z0-9_-]{8,}|(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{8,}|github_pat_[A-Za-z0-9_]{8,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{10,}|AIza[A-Za-z0-9_-]{10,}|eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*|(?:bot)?\d{6,}:[A-Za-z0-9_-]{30,})",
    ) {
        s = re.replace_all(&s, "***").into_owned();
    }

    // 6. URL user:password@
    if let Some(re) = audit_re(r"([a-z][a-z0-9+.-]{0,31}://)[^\s/:@]+:[^\s/@]+@") {
        s = re.replace_all(&s, "$1***:***@").into_owned();
    }

    // 7. URL query strings (keep base URL)
    if let Some(re) = audit_re(r"(https?://[^\s?#]+)\?[^\s]*") {
        s = re.replace_all(&s, "$1").into_owned();
    }

    s
}

fn write_agy_pre_marker(root: &Path, input: &HookInput) {
    let Some(sid) = input.session_id.as_deref() else {
        return;
    };
    let Some(step) = input.raw.get("stepIdx").and_then(Value::as_i64) else {
        return;
    };
    let dir = root.join(".agy_pre");
    if fs::create_dir_all(&dir).is_err() {
        return;
    }
    let f = dir.join(format!("{}-{step}.json", safe_id(sid, 64)));
    let now_ms = Utc::now().timestamp_millis();
    let _ = fs::write(f, format!(r#"{{"ts":{now_ms}}}"#));
    prune_stale_agy_markers(&dir, 50, 3600);
}

fn prune_stale_agy_markers(dir: &Path, max_remove: usize, max_age_secs: u64) {
    let Ok(rd) = fs::read_dir(dir) else {
        return;
    };
    let now = std::time::SystemTime::now();
    let ttl = std::time::Duration::from_secs(max_age_secs);
    let mut removed = 0usize;
    for (inspected, ent) in rd.flatten().enumerate() {
        if inspected >= 200 || removed >= max_remove {
            break;
        }
        let Ok(meta) = ent.metadata() else {
            continue;
        };
        if !meta.is_file() {
            continue;
        }
        if let Ok(mtime) = meta.modified() {
            if now.duration_since(mtime).is_ok_and(|age| age > ttl)
                && fs::remove_file(ent.path()).is_ok()
            {
                removed += 1;
            }
        }
    }
}

fn take_agy_pre_marker(root: &Path, sid: Option<&str>, step: i64) -> Option<i64> {
    let sid = sid?;
    let f = root
        .join(".agy_pre")
        .join(format!("{}-{step}.json", safe_id(sid, 64)));
    let raw = fs::read_to_string(&f).ok()?;
    let _ = fs::remove_file(&f);
    let v: Value = serde_json::from_str(&raw).ok()?;
    let start_ms = v.get("ts").and_then(Value::as_i64)?;
    let dur = Utc::now().timestamp_millis() - start_ms;
    (dur >= 0).then_some(dur)
}

fn extract_exit_code(err: &str) -> Option<i64> {
    let rest = err.strip_prefix("Exit code ")?;
    let digits: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
    digits.parse::<i64>().ok()
}

pub fn safe_id(raw: &str, max: usize) -> String {
    raw.chars()
        .filter(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '-'))
        .take(max)
        .collect()
}

fn collapse_ws(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn cut(s: &str, max_chars: usize) -> String {
    if s.chars().count() <= max_chars {
        s.to_string()
    } else {
        s.chars().take(max_chars).collect()
    }
}

fn audit_re(pat: &'static str) -> Option<&'static Regex> {
    static CACHE: OnceLock<Mutex<HashMap<&'static str, Option<&'static Regex>>>> = OnceLock::new();
    let lock = CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    let mut map = lock.lock().ok()?;
    if let Some(hit) = map.get(pat) {
        return *hit;
    }
    let compiled = Regex::new(pat)
        .ok()
        .map(|r| -> &'static Regex { Box::leak(Box::new(r)) });
    map.insert(pat, compiled);
    compiled
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::host::{parse_stdin, Decision};

    #[test]
    fn masks_all_secret_formats() {
        let raw = "curl -H 'Authorization: Bearer my-secret-jwt-123' https://user:pass@api.example.com/v1?api_key=abc --token tok_999 sk-proj1234567890abcd ghp_1234567890abcdef token=secretval123";
        let masked = mask_secrets(raw);
        assert!(!masked.contains("my-secret-jwt-123"), "{masked}");
        assert!(!masked.contains("pass@"), "{masked}");
        assert!(!masked.contains("api_key=abc"), "{masked}");
        assert!(!masked.contains("tok_999"), "{masked}");
        assert!(!masked.contains("sk-proj1234567890abcd"), "{masked}");
        assert!(!masked.contains("ghp_1234567890abcdef"), "{masked}");
        assert!(!masked.contains("secretval123"), "{masked}");
        assert!(masked.contains("***"), "{masked}");
    }

    #[test]
    fn prune_removes_old_partitions_only() {
        let tmp = std::env::temp_dir().join(format!("hk-prune-{}", std::process::id()));
        let _ = fs::remove_dir_all(&tmp);
        let root = tmp.join("audit");
        let outside = tmp.join("outside");
        fs::create_dir_all(root.join("date=2026-01-01/type=tool")).unwrap();
        fs::create_dir_all(root.join("date=2026-11-20")).unwrap();
        fs::create_dir_all(root.join("other")).unwrap();
        fs::create_dir_all(&outside).unwrap();
        fs::write(outside.join("keep.txt"), "x").unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(&outside, root.join("date=2025-01-01")).unwrap();
        prune_old_partitions(&root, "2026-11-22", 30, 64);
        assert!(!root.join("date=2026-01-01").exists());
        assert!(root.join("date=2026-11-20").exists());
        assert!(root.join("other").exists());
        assert!(outside.join("keep.txt").exists());
        #[cfg(unix)]
        assert!(root.join("date=2025-01-01").exists());
        for d in 1..=5 {
            fs::create_dir_all(root.join(format!("date=2026-02-0{d}"))).unwrap();
        }
        prune_old_partitions(&root, "2026-11-22", 30, 2);
        let left = (1..=5).filter(|d| root.join(format!("date=2026-02-0{d}")).exists()).count();
        assert_eq!(left, 3);
        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn writes_v2_envelope_with_o_append_and_rotation() {
        let tmp = std::env::temp_dir().join(format!("harness-audit-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(&tmp).unwrap();

        let payload = serde_json::json!({
            "hook_event_name": "PostToolUse",
            "session_id": "s1",
            "cwd": "/tmp/demo",
            "tool_name": "Bash",
            "tool_input": {"command": "echo sk-1234567890abcdef"},
            "tool_response": {"stdout": "ok"}
        });
        let inp = parse_stdin(Host::Claude, Some("PostToolUse"), payload.to_string().as_bytes()).unwrap();
        let env = build_envelope(&inp, &HookOutcome::default(), &tmp);
        assert_eq!(env.v, 2);
        assert_eq!(env.rec_type, "tool");
        assert_eq!(env.cli, "claude");
        assert_eq!(env.sid, "claude-s1");
        assert_eq!(env.ok, Some(true));
        assert!(!env.target.as_deref().unwrap_or("").contains("sk-1234567890abcdef"));

        // Force rotation at tiny max_bytes (180 bytes)
        write_envelope(&env, &tmp, 180);
        write_envelope(&env, &tmp, 180);
        let date = &env.ts[..10];
        let dir = tmp.join(format!("date={date}")).join("type=tool");
        assert!(dir.join("claude-s1.jsonl").is_file());
        assert!(dir.join("claude-s1.1.jsonl").is_file());

        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn fail_open_on_unwritable_audit_root() {
        let paths = WorkspacePaths {
            workspace: PathBuf::from("/tmp"),
            data_dir: PathBuf::from("/proc/nonexistent/data"),
            audit_root: PathBuf::from("/proc/nonexistent/audit"),
            has_workspace_marker: true,
            is_plugin_mode: false,
        };
        let payload = serde_json::json!({
            "hook_event_name": "Stop",
            "session_id": "s1",
            "cwd": "/tmp"
        });
        let inp = parse_stdin(Host::Claude, Some("Stop"), payload.to_string().as_bytes()).unwrap();
        // Must never panic or fail
        record_hook(&inp, &HookOutcome::default(), &paths);
    }

    #[test]
    fn masks_telegram_stripe_and_mysql_secrets() {
        let cases = [
            ("123456789:AAH_1234567890abcdefghijklmnopqr", "AAH_1234567890abcdefghijklmnopqr"),
            ("https://api.telegram.org/bot123456789:AAH_1234567890abcdefghijklmnopqr/getMe", "AAH_1234567890abcdefghijklmnopqr"),
            ("sk_live_1234567890abcdef", "sk_live_1234567890abcdef"),
            ("pk_live_1234567890abcdef", "pk_live_1234567890abcdef"),
            ("rk_live_1234567890abcdef", "rk_live_1234567890abcdef"),
            ("mysql -u root -pSecretPass db", "SecretPass"),
        ];
        for (raw, secret) in cases {
            let masked = mask_secrets(raw);
            assert!(!masked.contains(secret), "secret leaked in: {masked}");
            assert!(masked.contains("***"), "expected *** in: {masked}");
        }
        // Negative checks: do not mask harmless -p flags
        assert_eq!(mask_secrets("mkdir -p build"), "mkdir -p build");
        assert_eq!(
            mask_secrets("mysql -u root -P3306 -p db"),
            "mysql -u root -P3306 -p db"
        );
    }

    #[test]
    fn detect_status_identifies_all_four_error_forms() {
        let cases = [
            serde_json::json!({
                "hook_event_name": "PostToolUse",
                "session_id": "s1",
                "cwd": "/tmp",
                "tool_name": "Bash",
                "tool_input": {"command": "ls"},
                "tool_response": {"is_error": true}
            }),
            serde_json::json!({
                "hook_event_name": "PostToolUse",
                "session_id": "s1",
                "cwd": "/tmp",
                "tool_name": "Bash",
                "tool_input": {"command": "false"},
                "tool_response": {"exitCode": 1}
            }),
            serde_json::json!({
                "hook_event_name": "PostToolUse",
                "session_id": "s1",
                "cwd": "/tmp",
                "tool_name": "Bash",
                "tool_input": {"command": "bad"},
                "error": "spawn ENOENT"
            }),
            serde_json::json!({
                "hook_event_name": "PostToolUse",
                "session_id": "s1",
                "cwd": "/tmp",
                "tool_name": "Bash",
                "tool_input": {"command": "bad"},
                "tool_response": {"output": "Command exited with code 2\nfailed"}
            }),
        ];
        for p in cases {
            let inp = parse_stdin(Host::Claude, Some("PostToolUse"), p.to_string().as_bytes()).unwrap();
            let (ok, _) = detect_status(&inp, "PostToolUse");
            assert_eq!(ok, Some(false), "expected ok=false for {p}");
        }
        // exit code 0 in output is still ok=true
        let ok_p = serde_json::json!({
            "hook_event_name": "PostToolUse",
            "session_id": "s1",
            "cwd": "/tmp",
            "tool_name": "Bash",
            "tool_input": {"command": "true"},
            "tool_response": {"output": "Command exited with code 0\ndone"}
        });
        let inp_ok = parse_stdin(Host::Claude, Some("PostToolUse"), ok_p.to_string().as_bytes()).unwrap();
        assert_eq!(detect_status(&inp_ok, "PostToolUse").0, Some(true));
    }

    #[test]
    fn record_hook_writes_gate_only_in_gate_envelope() {
        let tmp = std::env::temp_dir().join(format!("harness-audit-gate-once-{}", std::process::id()));
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
            "session_id": "s-gate",
            "cwd": "/tmp",
            "tool_name": "Bash",
            "tool_input": {"command": "cat .env"}
        });
        let inp = parse_stdin(Host::Claude, Some("PreToolUse"), payload.to_string().as_bytes()).unwrap();
        let outcome = HookOutcome {
            decision: Some(Decision::Deny),
            reason: Some("blocked".to_string()),
            rule_id: Some("config-dump".to_string()),
            hook_name: Some("guard".to_string()),
            ..Default::default()
        };
        record_hook(&inp, &outcome, &paths);
        let date = Utc::now().format("%Y-%m-%d").to_string();
        let tool_log = fs::read_to_string(
            tmp.join(format!("date={date}/type=tool/claude-s-gate.jsonl")),
        )
        .unwrap();
        let tool_val: Value = serde_json::from_str(tool_log.trim()).unwrap();
        assert!(tool_val["data"].get("gate").is_none(), "tool envelope must not duplicate data.gate");
        let gate_log = fs::read_to_string(
            tmp.join(format!("date={date}/type=gate/claude-s-gate.jsonl")),
        )
        .unwrap();
        let gate_val: Value = serde_json::from_str(gate_log.trim()).unwrap();
        assert!(gate_val["data"].get("gate").is_some(), "gate envelope must contain data.gate");
        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn prune_stale_agy_markers_caps_at_50_and_keeps_fresh() {
        let dir = std::env::temp_dir().join(format!("harness-agy-pre-ttl-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();

        let old_time = std::time::SystemTime::now() - std::time::Duration::from_secs(3700);
        for i in 0..60 {
            let p = dir.join(format!("old-{i}.json"));
            let file = fs::File::create(&p).unwrap();
            file.set_modified(old_time).unwrap();
        }
        let fresh = dir.join("fresh-0.json");
        fs::write(&fresh, r#"{"ts":1}"#).unwrap();

        prune_stale_agy_markers(&dir, 50, 3600);
        let after_first = fs::read_dir(&dir).unwrap().count();
        assert_eq!(after_first, 11, "50 of 60 stale removed, 10 stale + 1 fresh left");
        assert!(fresh.is_file());

        prune_stale_agy_markers(&dir, 50, 3600);
        let after_second = fs::read_dir(&dir).unwrap().count();
        assert_eq!(after_second, 1, "remaining 10 stale removed, 1 fresh left");
        assert!(fresh.is_file());

        let _ = fs::remove_dir_all(&dir);
    }

    fn tmp_dir(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("harness-t8-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    fn assistant_line(id: &str, model: &str, i: u64, o: u64, cr: u64) -> String {
        serde_json::json!({"type":"assistant","message":{"id":id,"model":model,"content":[{"type":"text","text":"SECRET TEXT"}],
            "usage":{"input_tokens":i,"output_tokens":o,"cache_read_input_tokens":cr,"cache_creation_input_tokens":7}}}).to_string()
    }

    fn stop_env(event: &str, key: &str, path: &Path) -> EnvelopeV2 {
        let payload = serde_json::json!({"hook_event_name": event, "session_id": "s1", "cwd": "/tmp/demo", key: path});
        let inp = parse_stdin(Host::Claude, Some(event), payload.to_string().as_bytes()).unwrap();
        build_envelope(&inp, &HookOutcome::default(), Path::new("/nonexistent"))
    }

    #[test]
    fn stop_reads_transcript_usage() {
        let d = tmp_dir("usage");
        let f = d.join("t.jsonl");
        // msg a streamed twice (same id) counts once, last usage wins
        let body = [
            r#"{"type":"user","message":{"content":"hi"}}"#.to_string(),
            assistant_line("a", "claude-x", 1, 1, 1),
            assistant_line("a", "claude-x", 10, 20, 100),
            assistant_line("b", "claude-x", 5, 6, 50),
            assistant_line("c", "claude-y", 1, 2, 3),
        ]
        .join("\n");
        fs::write(&f, body).unwrap();
        let env = stop_env("Stop", "transcript_path", &f);
        assert_eq!(env.turns, Some(3));
        assert_eq!(env.tokens_in, Some(16));
        assert_eq!(env.tokens_out, Some(28));
        assert_eq!(env.model.as_deref(), Some("claude-y"));
        assert_eq!(env.data["cache_read"], 153);
        assert!(!serde_json::to_string(&env).unwrap().contains("SECRET TEXT"));
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn subagent_stop_uses_agent_transcript_path() {
        let d = tmp_dir("sub");
        let main_f = d.join("main.jsonl");
        let sub_f = d.join("sub.jsonl");
        fs::write(&main_f, assistant_line("m", "main-model", 100, 100, 0)).unwrap();
        fs::write(&sub_f, assistant_line("s", "sub-model", 2, 3, 0)).unwrap();
        let payload = serde_json::json!({"hook_event_name":"SubagentStop","session_id":"s1","cwd":"/tmp/demo",
            "transcript_path": main_f, "agent_transcript_path": sub_f, "agent_id":"a1"});
        let inp = parse_stdin(Host::Claude, Some("SubagentStop"), payload.to_string().as_bytes()).unwrap();
        let env = build_envelope(&inp, &HookOutcome::default(), Path::new("/nonexistent"));
        assert_eq!(env.model.as_deref(), Some("sub-model"));
        assert_eq!(env.tokens_out, Some(3));
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn transcript_read_is_capped() {
        let d = tmp_dir("cap");
        let f = d.join("big.jsonl");
        let mut w = std::io::BufWriter::new(fs::File::create(&f).unwrap());
        let filler = format!("{{\"type\":\"user\",\"pad\":\"{}\"}}\n", "p".repeat(1000));
        for _ in 0..(50 * 1024) {
            w.write_all(filler.as_bytes()).unwrap();
        }
        for id in ["t1", "t2"] {
            w.write_all(assistant_line(id, "m", 1, 1, 0).as_bytes()).unwrap();
            w.write_all(b"\n").unwrap();
        }
        drop(w);
        let t = std::time::Instant::now();
        let env = stop_env("Stop", "transcript_path", &f);
        assert!(t.elapsed().as_millis() < 200, "{:?}", t.elapsed());
        assert_eq!(env.turns, Some(2));
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn missing_transcript_is_ignored() {
        let env = stop_env("Stop", "transcript_path", Path::new("/nonexistent/x.jsonl"));
        assert_eq!(env.turns, None);
    }

    #[test]
    fn redact_extra_keys() {
        let cases = [
            "client_secret=zzTOPzz1",
            "curl -H 'api-key: zzTOPzz1'",
            "api_key=zzTOPzz1",
            "Cookie: sid=zzTOPzz1; other=2",
            "Set-Cookie: sid=zzTOPzz1; Path=/",
            "pwd=zzTOPzz1",
            "password: zzTOPzz1",
            "Authorization: Basic zzTOPzz1",
            r#"{"client_secret":"zzTOPzz1"}"#,
            r#"{"cookie":"zzTOPzz1"}"#,
            r#"{"pwd":"zzTOPzz1"}"#,
            r#"{"api-key":"zzTOPzz1"}"#,
            r#"{"authorization":["Bearer zzTOPzz1"]}"#,
            r#"{"set-cookie":["a=zzTOPzz1","b=2"]}"#,
        ];
        for c in cases {
            let m = mask_secrets(c);
            assert!(!m.contains("zzTOPzz1"), "leaked: {c} -> {m}");
        }
    }

    #[test]
    fn redact_cookie_full_value_and_curl_b() {
        let cases = [
            "curl -H 'Cookie: a=1; b=zzTOPzz2' https://h/x",
            "Cookie: a=1; b=zzTOPzz2",
            "Set-Cookie: a=1; b=zzTOPzz2; Path=/",
            r#"curl -b "a=1; b=zzTOPzz2" https://h/x"#,
            "curl --cookie 'a=1; b=zzTOPzz2' https://h/x",
        ];
        for c in cases {
            let m = mask_secrets(c);
            assert!(!m.contains("zzTOPzz2"), "leaked: {c} -> {m}");
        }
        assert_eq!(mask_secrets("git checkout -b feature"), "git checkout -b feature");
    }

    #[test]
    fn redact_json_prefixed_and_nested_values() {
        let cases = [
            r#"{"x-api-key":"zzTOPzz3"}"#,
            r#"{"secret":{"a":"zzTOPzz3"}}"#,
            r#"{"secret":[["zzTOPzz3"],"zzTOPzz3"]}"#,
            r#"{"password":{"n":{"v":"zzTOPzz3"}}}"#,
            r#"{"x-auth-token":"zzTOPzz3"}"#,
        ];
        for c in cases {
            let m = mask_secrets(c);
            assert!(!m.contains("zzTOPzz3"), "leaked: {c} -> {m}");
        }
        let m = mask_secrets(r#"{"secret":{"a":"zzTOPzz3"},"keep":"ok"}"#);
        assert!(m.contains(r#""keep":"ok""#), "{m}");
        assert_eq!(mask_secrets("cd /x && PWD=/home/u ls"), "cd /x && PWD=/home/u ls");
    }

    #[test]
    fn usage_truncated_flag_and_fallback() {
        let d = tmp_dir("trunc");
        let big = d.join("big.jsonl");
        let mut w = std::io::BufWriter::new(fs::File::create(&big).unwrap());
        let filler = format!("{{\"type\":\"user\",\"pad\":\"{}\"}}\n", "p".repeat(1000));
        for _ in 0..(9 * 1024) {
            w.write_all(filler.as_bytes()).unwrap();
        }
        w.write_all(assistant_line("t1", "m", 1, 1, 0).as_bytes()).unwrap();
        w.write_all(b"\n").unwrap();
        drop(w);
        let env = stop_env("Stop", "transcript_path", &big);
        assert_eq!(env.data["usage_truncated"], true);
        let small = d.join("small.jsonl");
        fs::write(&small, assistant_line("t1", "m", 1, 1, 0)).unwrap();
        assert!(stop_env("Stop", "transcript_path", &small).data.get("usage_truncated").is_none());
        // agent path unreadable => NO fallback to the session transcript (would assign session totals to the agent)
        let payload = serde_json::json!({"hook_event_name":"SubagentStop","session_id":"s1","cwd":"/tmp/demo",
            "transcript_path": small, "agent_transcript_path": d.join("missing.jsonl")});
        let inp = parse_stdin(Host::Claude, Some("SubagentStop"), payload.to_string().as_bytes()).unwrap();
        let env = build_envelope(&inp, &HookOutcome::default(), Path::new("/nonexistent"));
        assert_eq!(env.turns, None);
        assert_eq!(env.tokens_out, None);
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn sid_fallback_uses_ppid() {
        let a = build_sid("claude", None, "/tmp/x");
        let b = build_sid("claude", None, "/tmp/x");
        assert_eq!(a, b);
        #[cfg(unix)]
        {
            let pp = std::os::unix::process::parent_id();
            assert_eq!(a, format!("claude-{}", sid_for_pid("claude", "/tmp/x", pp)));
        }
    }
}
