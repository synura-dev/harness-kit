use crate::audit;
use crate::config::{is_agy_enabled, resolve_paths};
use crate::data::{format_data, run_data};
use crate::doctor::{format_doctor_summary, run_doctor};
use crate::host::{parse_stdin, render_fail_open, render_outcome, Host};
use crate::mcp;
use crate::observe::{format_observe_summary, run_observe, ObserveParams};
use crate::rules::RulesEngine;
use clap::{Parser, Subcommand, ValueEnum};
#[cfg(test)]
use std::fs;
use std::io::{self, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

const STDIN_READ_TIMEOUT: Duration = Duration::from_secs(2);
/// Hook stdin cap (8 MiB). Over the cap or timeout: never silently allow writes (see `handle_read_failure`).
pub const HOOK_STDIN_CAP: usize = 8 * 1024 * 1024;

/// Shared by every test in the crate that sets CLAUDE_AUDIT_DIR (env is process-global).
#[cfg(test)]
pub(crate) static AUDIT_ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// Result of reading hook stdin; `partial` holds the bytes read when `res` is an error.
struct StdinRead {
    res: Result<Vec<u8>, String>,
    partial: Vec<u8>,
}

#[derive(Debug, Parser)]
#[command(
    name = "harness-rs",
    version = concat!(env!("CARGO_PKG_VERSION"), " (src ", env!("HARNESS_SRC_TREE_SHORT"), ")"),
    about = "Native deterministic constraint, hook, audit, and MCP server for harness-kit"
)]
pub struct Cli {
    #[command(subcommand)]
    pub command: Commands,
}

#[derive(Debug, Clone, Copy, ValueEnum)]
pub enum HostArg {
    Claude,
    Agy,
}

impl From<HostArg> for Host {
    fn from(h: HostArg) -> Self {
        match h {
            HostArg::Claude => Host::Claude,
            HostArg::Agy => Host::Agy,
        }
    }
}

#[derive(Debug, Subcommand)]
pub enum Commands {
    /// Evaluate a host lifecycle hook on stdin (fail-open)
    Hook {
        #[arg(long, value_enum)]
        host: HostArg,
        event: Option<String>,
    },
    /// Run stdio JSON-RPC 2.0 MCP server (4 read-only tools)
    Mcp,
    /// Run environment, rules, hooks, and audit diagnostics
    Doctor {
        #[arg(long)]
        json: bool,
        #[arg(long)]
        cwd: Option<String>,
    },
    /// Query audit usage summaries
    Observe {
        /// usage (default, same as no action) | report | sizes
        action: Option<String>,
        /// report: window in days (default 7)
        #[arg(long)]
        days: Option<i64>,
        /// accepted for old playbooks: report is always read-only
        #[arg(long)]
        dry_run: bool,
        /// report output: only "-" (stdout) is supported
        #[arg(long)]
        out: Option<String>,
        /// accepted for old playbooks (scan has a fixed 10s budget)
        #[arg(long)]
        timeout_s: Option<u64>,
        #[arg(long, default_value = "7d")]
        since: String,
        #[arg(long, default_value = "cmd")]
        by: String,
        #[arg(long, default_value_t = 20)]
        limit: usize,
        #[arg(long)]
        project: Option<String>,
        #[arg(long)]
        json: bool,
        #[arg(long)]
        cwd: Option<String>,
    },
    /// Inspect data zones and registry
    Data {
        action: String,
        #[arg(long)]
        zone: Option<String>,
        #[arg(long)]
        json: bool,
        #[arg(long)]
        cwd: Option<String>,
    },
    /// Print active layered rules policy
    Policy {
        #[arg(long)]
        json: bool,
        #[arg(long)]
        cwd: Option<String>,
    },
}

pub fn run(cli: Cli) -> i32 {
    match cli.command {
        Commands::Hook { host, event } => run_hook(host.into(), event.as_deref()),
        Commands::Mcp => mcp::run_stdio_server(),
        Commands::Doctor { json, cwd } => {
            let paths = resolve_paths(cwd.as_deref());
            let rep = run_doctor(&paths);
            if json {
                println!(
                    "{}",
                    serde_json::to_string_pretty(&rep).unwrap_or_else(|_| "{}".to_string())
                );
            } else {
                println!("{}", format_doctor_summary(&rep));
            }
            if rep.ok { 0 } else { 1 }
        }
        Commands::Observe {
            action,
            days,
            dry_run: _,
            out,
            timeout_s,
            since,
            by,
            limit,
            project,
            json,
            cwd,
        } => {
            if timeout_s.is_some_and(|t| t != 10) {
                eprintln!("observe: --timeout-s ignored: fixed 10s budget");
            }
            let paths = resolve_paths(cwd.as_deref());
            let emit = |text: String, val: serde_json::Value| {
                if json {
                    println!("{}", serde_json::to_string_pretty(&val).unwrap_or_else(|_| "{}".to_string()));
                } else {
                    println!("{text}");
                }
            };
            match action.as_deref().unwrap_or("usage") {
                "usage" => {
                    let since = days.map_or(since, |d| format!("{d}d"));
                    let params = ObserveParams {
                        since: Some(since),
                        by: Some(by),
                        limit: Some(limit),
                        project,
                    };
                    match run_observe(&paths, &params) {
                        Ok(res) => {
                            emit(format_observe_summary(&res), serde_json::to_value(&res).unwrap_or_default());
                            0
                        }
                        Err(e) => {
                            eprintln!("observe error: {e}");
                            2
                        }
                    }
                }
                "report" => {
                    if out.as_deref().is_some_and(|o| o != "-") {
                        eprintln!("observe error: report only supports --out - (stdout)");
                        return 2;
                    }
                    match crate::observe::run_report(&paths, days.unwrap_or(7)) {
                        Ok(res) => {
                            emit(crate::observe::format_report_summary(&res), serde_json::to_value(&res).unwrap_or_default());
                            0
                        }
                        Err(e) => {
                            eprintln!("observe error: {e}");
                            2
                        }
                    }
                }
                "sizes" => {
                    let res = crate::observe::run_sizes(&paths);
                    emit(crate::observe::format_sizes_summary(&res), serde_json::to_value(&res).unwrap_or_default());
                    0
                }
                other => {
                    eprintln!("observe error: unknown action '{other}' (usage|report|sizes; data-prune is not ported)");
                    2
                }
            }
        }
        Commands::Data {
            action,
            zone,
            json,
            cwd,
        } => {
            let paths = resolve_paths(cwd.as_deref());
            match run_data(&paths, &action, zone.as_deref()) {
                Ok(val) => {
                    println!("{}", format_data(&val, json));
                    // scan: any warning or truncated walk is a failure for scripts.
                    let has_warnings = val
                        .get("warnings")
                        .and_then(|w| w.as_array())
                        .is_some_and(|w| !w.is_empty());
                    let truncated = val.get("truncated").and_then(|t| t.as_bool()).unwrap_or(false);
                    if action == "scan" && (has_warnings || truncated) { 1 } else { 0 }
                }
                Err(e) => {
                    eprintln!("data error: {e}");
                    2
                }
            }
        }
        Commands::Policy { json: _, cwd } => {
            let paths = resolve_paths(cwd.as_deref());
            let engine = RulesEngine::load_for_workspace(&paths.workspace);
            let val = engine.policy_dump(&paths.workspace);
            println!(
                "{}",
                serde_json::to_string_pretty(&val).unwrap_or_else(|_| val.to_string())
            );
            0
        }
    }
}

pub fn run_hook_fast(host: Host, event_arg: Option<&str>) -> i32 {
    run_hook(host, event_arg)
}

fn run_hook(host: Host, event_arg: Option<&str>) -> i32 {
    let mut stdout_lock = io::stdout().lock();
    run_hook_guarded_to(host, event_arg, &mut stdout_lock, |emitted, is_agy_pre, w| {
        run_hook_inner(host, event_arg, emitted, is_agy_pre, w)
    })
}

/// Panic branch: one HKERR line + best-effort audit (never panics again).
fn report_panic<E: Write>(host: Host, event: &str, err_w: &mut E) {
    let _ = writeln!(err_w, "HKERR {event} panic");
    log_fail_open(host, event, "panic", None, None);
}

/// Ok(bytes) = continue evaluating with these bytes; Err(code) = output already emitted.
#[allow(clippy::too_many_arguments)]
fn recover_block<W: Write, E: Write>(
    host: Host,
    ev: &str,
    why: &str,
    partial: &[u8],
    is_agy_pre: &AtomicBool,
    stdout_w: &mut W,
    err_w: &mut E,
    emitted: &AtomicBool,
) -> Result<Vec<u8>, i32> {
    match recover_partial(host, ev, partial) {
        Recovery::Deny { tool, cwd } => {
            is_agy_pre.store(host == Host::Agy, Ordering::Relaxed);
            let outcome = crate::host::HookOutcome {
                decision: Some(crate::host::Decision::Deny),
                reason: Some(format!(
                    "harness: hook payload unreadable ({why}); write/exec tool blocked"
                )),
                rule_id: Some("stdin-guard".to_string()),
                hook_name: Some("stdin-guard".to_string()),
                ..Default::default()
            };
            let mut rendered = render_outcome(host, ev, &outcome);
            rendered.stderr = format!("HKERR {ev} deny {why} tool={}\n", tool_label(tool.as_deref()));
            emit_rendered_to(stdout_w, err_w, emitted, &rendered);
            let input = synthetic_input(host, ev, tool.as_deref(), cwd.as_deref());
            audit::record_hook(&input, &outcome, &resolve_paths(cwd.as_deref()));
            Err(rendered.exit_code)
        }
        Recovery::Evaluate { bytes, tool } => {
            // Read-only tool with an extractable path: evaluate path rules; the normal flow
            // writes the single audit record.
            let _ = writeln!(err_w, "HKERR {ev} partial {why} tool={}", tool_label(tool.as_deref()));
            Ok(bytes)
        }
        Recovery::FailOpen { tool, cwd } => Err(fail_open_emit(
            host, ev, why, tool.as_deref(), cwd.as_deref(), stdout_w, err_w, emitted,
        )),
    }
}

fn tool_label(tool: Option<&str>) -> String {
    let s = tool.map(|t| audit::safe_id(t, 64)).unwrap_or_default();
    if s.is_empty() { "?".to_string() } else { s }
}

fn panic_fail_open_output(is_agy_pre: bool) -> &'static str {
    if is_agy_pre {
        "{\"decision\":\"allow\"}\n"
    } else {
        "{}\n"
    }
}

fn run_hook_guarded_to<W: Write, F>(
    host: Host,
    event_arg: Option<&str>,
    stdout_w: &mut W,
    f: F,
) -> i32
where
    F: FnOnce(&AtomicBool, &AtomicBool, &mut W) -> i32,
{
    let emitted = AtomicBool::new(false);
    let is_agy_pre = AtomicBool::new(
        host == Host::Agy && event_arg.unwrap_or("PreToolUse") == "PreToolUse",
    );
    let res = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        f(&emitted, &is_agy_pre, stdout_w)
    }));
    match res {
        Ok(code) => code,
        Err(_) => {
            report_panic(host, event_arg.unwrap_or("PreToolUse"), &mut io::stderr());
            if !emitted.load(Ordering::Relaxed) {
                let _ = stdout_w
                    .write_all(panic_fail_open_output(is_agy_pre.load(Ordering::Relaxed)).as_bytes());
                let _ = stdout_w.flush();
            }
            0
        }
    }
}

fn run_hook_inner<W: Write>(
    host: Host,
    event_arg: Option<&str>,
    emitted: &AtomicBool,
    is_agy_pre: &AtomicBool,
    stdout_w: &mut W,
) -> i32 {
    let read = read_capped_stdin(HOOK_STDIN_CAP);
    run_hook_with_read(
        host,
        event_arg,
        read,
        emitted,
        is_agy_pre,
        stdout_w,
        &mut io::stderr(),
    )
}

fn run_hook_with_read<W: Write, E: Write>(
    host: Host,
    event_arg: Option<&str>,
    read: StdinRead,
    emitted: &AtomicBool,
    is_agy_pre: &AtomicBool,
    stdout_w: &mut W,
    err_w: &mut E,
) -> i32 {
    let ev_fallback = event_arg.unwrap_or("PreToolUse");
    let raw_bytes = match read.res {
        Ok(b) => b,
        Err(why) => match recover_block(
            host, ev_fallback, &why, &read.partial, is_agy_pre, stdout_w, err_w, emitted,
        ) {
            Ok(b) => b,
            Err(code) => return code,
        },
    };

    let input = match parse_stdin(host, event_arg, &raw_bytes) {
        Ok(inp) => inp,
        Err(why) => {
            // Unparseable non-empty payload: same policy as oversize/timeout.
            // Garbage with no identifiable tool (e2e: `{not-json`, plain bytes) stays fail-open + HKERR.
            // (agy payload with a toolCall but unreadable name is NOT garbage: deny like oversize.)
            let agy_toolcall = host == Host::Agy && find_sub(&raw_bytes, b"\"toolCall\"", 0).is_some();
            if sniff_tool_name(host, &raw_bytes).is_none() && !agy_toolcall {
                return fail_open_emit(host, ev_fallback, &why, None, None, stdout_w, err_w, emitted);
            }
            let synth = match recover_block(
                host, ev_fallback, &why, &raw_bytes, is_agy_pre, stdout_w, err_w, emitted,
            ) {
                Ok(b) => b,
                Err(code) => return code,
            };
            match parse_stdin(host, event_arg, &synth) {
                Ok(inp) => inp,
                Err(w2) => {
                    return fail_open_emit(host, ev_fallback, &w2, None, None, stdout_w, err_w, emitted);
                }
            }
        }
    };

    is_agy_pre.store(
        host == Host::Agy && input.event == "PreToolUse",
        Ordering::Relaxed,
    );

    // Project anchor: CLAUDE_PROJECT_DIR (Claude) / workspacePaths[0] (agy) beats the payload cwd,
    // so a cwd in a worktree or outside the project cannot pick a different rule set.
    let claude_proj = (host == Host::Claude)
        .then(|| std::env::var("CLAUDE_PROJECT_DIR").ok())
        .flatten()
        .filter(|s| !s.trim().is_empty());
    let ws_hint = claude_proj
        .as_deref()
        .or_else(|| input.workspace_paths.first().map(String::as_str))
        .or(input.workspace_cwd.as_deref())
        .or(input.tool_cwd.as_deref());
    let paths = resolve_paths(ws_hint);

    if host == Host::Agy && !is_agy_enabled(&paths.workspace) {
        // Intentional off-switch, not a fault: valid allow output, no HKERR noise.
        let mut out = render_fail_open(Host::Agy, &input.event, "agy disabled");
        out.stderr.clear();
        emit_rendered_to(stdout_w, err_w, emitted, &out);
        return out.exit_code;
    }

    let outcome = if input.event == "PreToolUse" {
        let engine = RulesEngine::load_for_hook(&paths.workspace, host, input.tool_name.as_deref());
        engine.evaluate(&input, &paths)
    } else if input.event == "WorktreeCreate" || input.event == "WorktreeRemove" {
        RulesEngine::empty().evaluate(&input, &paths)
    } else {
        crate::host::HookOutcome::default()
    };
    let rendered = render_outcome(host, &input.event, &outcome);
    emit_rendered_to(stdout_w, err_w, emitted, &rendered);
    audit::record_hook(&input, &outcome, &paths);
    rendered.exit_code
}

enum Recovery {
    /// PreToolUse write/exec (or unidentifiable) tool with unusable payload: block.
    Deny { tool: Option<String>, cwd: Option<String> },
    /// Read-only tool with a sniffed path: evaluate rules on a synthesized minimal payload.
    Evaluate { bytes: Vec<u8>, tool: Option<String> },
    FailOpen { tool: Option<String>, cwd: Option<String> },
}

/// Known read-only tools (after agy mapping). Anything else not MCP is denied when unreadable.
const READ_TOOLS: &[&str] = &["Read", "Glob", "Grep", "LS", "NotebookRead", "WebFetch", "WebSearch"];

/// Decide what to do with an unusable payload (oversize/timeout/bad JSON), from its prefix only.
fn recover_partial(host: Host, event: &str, partial: &[u8]) -> Recovery {
    let raw_tool = sniff_tool_name(host, partial);
    let cwd = sniff_json_string(partial, &["cwd", "workspacePath"]);
    if event != "PreToolUse" {
        return Recovery::FailOpen { tool: raw_tool, cwd };
    }
    let mapped = match (host, raw_tool.as_deref()) {
        (Host::Agy, Some(n)) => Some(crate::host::agy::map_tool_name(n)),
        (_, Some(n)) => Some(n.to_string()),
        (_, None) => None,
    };
    // shortcut: MCP tools fail-open (+HKERR) without checking whether a TOML rule targets MCP.
    let is_mcp = mapped.as_deref().is_some_and(|m| m == "MCP" || m.starts_with("mcp__"));
    if is_mcp {
        return Recovery::FailOpen { tool: raw_tool, cwd };
    }
    let known_read = mapped.as_deref().is_some_and(|m| READ_TOOLS.contains(&m));
    if !known_read {
        return Recovery::Deny { tool: raw_tool, cwd };
    }
    let field = if matches!(mapped.as_deref(), Some("Glob" | "Grep")) { "path" } else { "file_path" };
    let path_keys: &[&str] = match host {
        Host::Claude => &["file_path", "path", "notebook_path"],
        Host::Agy => &["Path", "AbsolutePath", "TargetFile", "FilePath", "file_path", "path"],
    };
    let Some(path) = sniff_json_string(partial, path_keys) else {
        return Recovery::FailOpen { tool: raw_tool, cwd };
    };
    let name = raw_tool.clone().unwrap_or_default();
    let synth = match host {
        Host::Claude => serde_json::json!({
            "hook_event_name": "PreToolUse",
            "tool_name": name,
            "tool_input": { field: path },
            "cwd": cwd,
        }),
        Host::Agy => serde_json::json!({
            "toolCall": { "name": name, "args": { "Path": path } },
            "cwd": cwd,
        }),
    };
    Recovery::Evaluate { bytes: synth.to_string().into_bytes(), tool: raw_tool }
}

fn synthetic_input(host: Host, event: &str, tool: Option<&str>, cwd: Option<&str>) -> crate::host::HookInput {
    use serde_json::{Map, Value};
    let tool = tool.map(|t| audit::safe_id(t, 40)).filter(|t| !t.is_empty());
    crate::host::HookInput {
        host,
        event: event.to_string(),
        session_id: None,
        workspace_cwd: cwd.map(ToString::to_string),
        tool_cwd: None,
        workspace_paths: Vec::new(),
        tool_name: tool.clone(),
        raw_tool_name: tool,
        tool_input: Value::Object(Map::new()),
        raw_args: Value::Object(Map::new()),
        tool_use_id: None,
        tool_response: None,
        raw: Value::Null,
    }
}

/// Audit a fail-open (status `fail_open`) using only public audit fns; never payload content.
fn log_fail_open(host: Host, event: &str, why: &str, tool: Option<&str>, cwd: Option<&str>) {
    let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let paths = resolve_paths(cwd);
        crate::config::ensure_data_ignore(&paths);
        let input = synthetic_input(host, event, tool, cwd);
        let mut env =
            audit::build_envelope(&input, &crate::host::HookOutcome::default(), &paths.audit_root);
        env.status = Some("fail_open".to_string());
        env.summary = format!("fail_open: {}", audit::safe_id(why, 80));
        audit::write_envelope(&env, &paths.audit_root, crate::config::audit_max_file_bytes());
    }));
}

#[allow(clippy::too_many_arguments)]
fn fail_open_emit<W: Write, E: Write>(
    host: Host,
    event: &str,
    why: &str,
    tool: Option<&str>,
    cwd: Option<&str>,
    stdout_w: &mut W,
    err_w: &mut E,
    emitted: &AtomicBool,
) -> i32 {
    let out = render_fail_open(host, event, why);
    emit_rendered_to(stdout_w, err_w, emitted, &out);
    log_fail_open(host, event, why, tool, cwd);
    out.exit_code
}

/// Tool name from a possibly truncated payload prefix (Claude `tool_name`; agy `toolName`/`toolCall.name`).
fn sniff_tool_name(host: Host, buf: &[u8]) -> Option<String> {
    if host == Host::Agy {
        // Same precedence as host/agy.rs normalize: toolCall.name, then toolName, then tool_name.
        // If toolCall exists but its name is not readable, do NOT fall back to args look-alikes.
        if let Some(at) = find_sub(buf, b"\"toolCall\"", 0) {
            return toolcall_depth1_name(buf, at + b"\"toolCall\"".len());
        }
        return sniff_json_string(buf, &["toolName", "tool_name"]);
    }
    sniff_json_string(buf, &["tool_name"])
}

fn sniff_json_string(buf: &[u8], keys: &[&str]) -> Option<String> {
    keys.iter().find_map(|k| string_after_key(buf, 0, k))
}

fn skip_ws(buf: &[u8], mut i: usize) -> usize {
    while i < buf.len() && buf[i].is_ascii_whitespace() {
        i += 1;
    }
    i
}

/// End index (exclusive) of the JSON string starting at `buf[i] == '"'`; None if unterminated.
fn string_end(buf: &[u8], i: usize) -> Option<usize> {
    let mut k = i + 1;
    while k < buf.len() {
        match buf[k] {
            b'\\' => k += 2,
            b'"' => return Some(k + 1),
            _ => k += 1,
        }
    }
    None
}

/// End index (exclusive) of the JSON value at `i`; None if unsure/truncated.
fn value_end(buf: &[u8], i: usize) -> Option<usize> {
    match *buf.get(i)? {
        b'"' => string_end(buf, i),
        b'{' | b'[' => {
            let mut depth = 0usize;
            let mut k = i;
            while k < buf.len() {
                match buf[k] {
                    b'"' => {
                        k = string_end(buf, k)?;
                        continue;
                    }
                    b'{' | b'[' => depth += 1,
                    b'}' | b']' => {
                        depth -= 1;
                        if depth == 0 {
                            return Some(k + 1);
                        }
                    }
                    _ => {}
                }
                k += 1;
            }
            None
        }
        _ => {
            let mut k = i;
            while k < buf.len() && !matches!(buf[k], b',' | b'}' | b']') {
                k += 1;
            }
            (k < buf.len()).then_some(k)
        }
    }
}

/// `name` key at depth 1 of the object that follows `"toolCall"` (value at `from`); skips other
/// values whole (so nested `name`/`toolCall` in args never count). Unsure => None.
fn toolcall_depth1_name(buf: &[u8], from: usize) -> Option<String> {
    let mut i = skip_ws(buf, from);
    if buf.get(i) != Some(&b':') {
        return None;
    }
    i = skip_ws(buf, i + 1);
    if buf.get(i) != Some(&b'{') {
        return None;
    }
    i += 1;
    loop {
        i = skip_ws(buf, i);
        if buf.get(i) == Some(&b',') {
            i = skip_ws(buf, i + 1);
        }
        if buf.get(i) != Some(&b'"') {
            return None;
        }
        let kend = string_end(buf, i)?;
        let key: String = serde_json::from_slice(&buf[i..kend]).ok()?;
        i = skip_ws(buf, kend);
        if buf.get(i) != Some(&b':') {
            return None;
        }
        i = skip_ws(buf, i + 1);
        let vend = value_end(buf, i)?;
        if key == "name" {
            return serde_json::from_slice::<String>(&buf[i..vend]).ok().filter(|s| !s.is_empty());
        }
        i = vend;
    }
}

fn find_sub(hay: &[u8], needle: &[u8], from: usize) -> Option<usize> {
    if from >= hay.len() || needle.is_empty() {
        return None;
    }
    hay[from..].windows(needle.len()).position(|w| w == needle).map(|p| p + from)
}

/// First `"key": "<string>"` at or after `from`; string capped at 4096 bytes.
fn string_after_key(buf: &[u8], from: usize, key: &str) -> Option<String> {
    let pat = format!("\"{key}\"");
    let mut pos = from;
    while let Some(i) = find_sub(buf, pat.as_bytes(), pos) {
        pos = i + pat.len();
        let mut j = pos;
        while j < buf.len() && buf[j].is_ascii_whitespace() {
            j += 1;
        }
        if buf.get(j) != Some(&b':') {
            continue;
        }
        j += 1;
        while j < buf.len() && buf[j].is_ascii_whitespace() {
            j += 1;
        }
        if buf.get(j) != Some(&b'"') {
            continue;
        }
        let start = j;
        let mut k = j + 1;
        while k < buf.len() && k - start < 4096 {
            match buf[k] {
                b'\\' => k += 2,
                b'"' => {
                    return serde_json::from_slice::<String>(&buf[start..=k])
                        .ok()
                        .filter(|s| !s.is_empty());
                }
                _ => k += 1,
            }
        }
    }
    None
}

fn read_capped_stdin(max_bytes: usize) -> StdinRead {
    #[cfg(unix)]
    {
        use std::os::unix::io::AsRawFd;
        let mut buf = Vec::with_capacity(4096);
        let r = read_capped_fd_partial(
            io::stdin().as_raw_fd(),
            max_bytes,
            STDIN_READ_TIMEOUT,
            &mut buf,
        );
        match r {
            Ok(()) => StdinRead { res: Ok(buf), partial: Vec::new() },
            Err(e) => StdinRead { res: Err(e), partial: buf },
        }
    }
    #[cfg(not(unix))]
    {
        read_capped_reader_partial(io::stdin(), max_bytes, STDIN_READ_TIMEOUT)
    }
}

#[cfg(all(unix, test))]
fn read_capped_fd_with_timeout(
    fd: std::os::unix::io::RawFd,
    max_bytes: usize,
    timeout: Duration,
) -> Result<Vec<u8>, String> {
    let mut buf = Vec::new();
    read_capped_fd_partial(fd, max_bytes, timeout, &mut buf).map(|()| buf)
}

/// Reads up to `max_bytes`; bytes read so far stay in `out` even on error (timeout/oversize).
#[cfg(unix)]
fn read_capped_fd_partial(
    fd: std::os::unix::io::RawFd,
    max_bytes: usize,
    timeout: Duration,
    out: &mut Vec<u8>,
) -> Result<(), String> {
    use std::ffi::{c_int, c_short, c_ulong, c_void};
    use std::time::Instant;

    const POLLIN: c_short = 0x0001;
    const POLLERR: c_short = 0x0008;
    const POLLHUP: c_short = 0x0010;
    const POLLNVAL: c_short = 0x0020;

    #[repr(C)]
    struct PollFd {
        fd: c_int,
        events: c_short,
        revents: c_short,
    }

    extern "C" {
        fn poll(fds: *mut PollFd, nfds: c_ulong, timeout: c_int) -> c_int;
        fn read(fd: c_int, buf: *mut c_void, count: usize) -> isize;
    }

    let started = Instant::now();
    let mut chunk = [0u8; 8192];

    loop {
        let elapsed = started.elapsed();
        if elapsed >= timeout {
            return Err("stdin timeout".to_string());
        }
        let rem_ms = timeout
            .saturating_sub(elapsed)
            .as_millis()
            .clamp(1, c_int::MAX as u128) as c_int;
        let mut pfd = PollFd {
            fd,
            events: POLLIN,
            revents: 0,
        };
        // SAFETY: `pfd` is a valid stack-allocated PollFd for 1 descriptor.
        let rc = unsafe { poll(&mut pfd, 1, rem_ms) };
        if rc < 0 {
            let err = io::Error::last_os_error();
            if err.kind() == io::ErrorKind::Interrupted {
                continue;
            }
            return Err(format!("stdin poll error: {err}"));
        }
        if rc == 0 {
            return Err("stdin timeout".to_string());
        }
        if (pfd.revents & POLLNVAL) != 0 {
            return Err("stdin invalid fd".to_string());
        }
        if (pfd.revents & (POLLIN | POLLERR | POLLHUP)) != 0 {
            let want = (max_bytes + 1 - out.len()).min(chunk.len());
            // SAFETY: `chunk` has `chunk.len() >= want` writable bytes.
            let n = unsafe { read(fd, chunk.as_mut_ptr().cast::<c_void>(), want) };
            if n < 0 {
                let err = io::Error::last_os_error();
                if err.kind() == io::ErrorKind::Interrupted {
                    continue;
                }
                return Err(format!("stdin error: {err}"));
            }
            if n == 0 {
                break;
            }
            out.extend_from_slice(&chunk[..n as usize]);
            if out.len() > max_bytes {
                return Err("stdin oversize".to_string());
            }
        }
    }
    Ok(())
}

#[cfg(test)]
fn read_capped_reader_with_timeout<R: std::io::Read + Send + 'static>(
    reader: R,
    max_bytes: usize,
    timeout: Duration,
) -> Result<Vec<u8>, String> {
    read_capped_reader_partial(reader, max_bytes, timeout).res
}

/// Thread-based reader (non-unix stdin, tests). The thread appends chunks to a shared buffer so a
/// timeout still exposes the prefix received so far.
#[cfg(any(not(unix), test))]
fn read_capped_reader_partial<R: std::io::Read + Send + 'static>(
    mut reader: R,
    max_bytes: usize,
    timeout: Duration,
) -> StdinRead {
    use std::sync::{Arc, Mutex};
    let shared: Arc<Mutex<Vec<u8>>> = Arc::new(Mutex::new(Vec::new()));
    let (tx, rx) = std::sync::mpsc::sync_channel::<Result<(), String>>(1);
    let th_buf = Arc::clone(&shared);
    std::thread::spawn(move || {
        let mut chunk = [0u8; 8192];
        let res = loop {
            match reader.read(&mut chunk) {
                Ok(0) => break Ok(()),
                Ok(n) => {
                    let mut g = th_buf.lock().unwrap_or_else(|e| e.into_inner());
                    g.extend_from_slice(&chunk[..n]);
                    if g.len() > max_bytes {
                        break Err("stdin oversize".to_string());
                    }
                }
                Err(e) if e.kind() == io::ErrorKind::Interrupted => {}
                Err(e) => break Err(format!("stdin error: {e}")),
            }
        };
        let _ = tx.send(res);
    });
    let res = match rx.recv_timeout(timeout) {
        Ok(r) => r,
        Err(std::sync::mpsc::RecvTimeoutError::Timeout) => Err("stdin timeout".to_string()),
        Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
            Err("stdin reader disconnected".to_string())
        }
    };
    let buf = std::mem::take(&mut *shared.lock().unwrap_or_else(|e| e.into_inner()));
    match res {
        Ok(()) => StdinRead { res: Ok(buf), partial: Vec::new() },
        Err(e) => StdinRead { res: Err(e), partial: buf },
    }
}

fn emit_rendered_to<W: Write, E: Write>(
    stdout_w: &mut W,
    err_w: &mut E,
    emitted: &AtomicBool,
    out: &crate::host::RenderedOutput,
) {
    if !out.stderr.is_empty() {
        let _ = err_w.write_all(out.stderr.as_bytes());
        let _ = err_w.flush();
    }
    if !out.stdout.is_empty() {
        let _ = stdout_w.write_all(out.stdout.as_bytes());
        let _ = stdout_w.flush();
    }
    emitted.store(true, Ordering::Relaxed);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn catch_unwind_hook_emits_host_fail_open_json_on_panic() {
        let mut agy_out = Vec::new();
        let code = run_hook_guarded_to(Host::Agy, Some("PreToolUse"), &mut agy_out, |_, _, _| {
            panic!("boom")
        });
        assert_eq!(code, 0);
        assert_eq!(String::from_utf8(agy_out).unwrap().trim(), r#"{"decision":"allow"}"#);

        let mut agy_post = Vec::new();
        let code2 = run_hook_guarded_to(Host::Agy, Some("PostToolUse"), &mut agy_post, |_, _, _| {
            panic!("boom")
        });
        assert_eq!(code2, 0);
        assert_eq!(String::from_utf8(agy_post).unwrap().trim(), "{}");

        let mut claude_out = Vec::new();
        let code3 =
            run_hook_guarded_to(Host::Claude, Some("PreToolUse"), &mut claude_out, |_, _, _| {
                panic!("boom")
            });
        assert_eq!(code3, 0);
        assert_eq!(String::from_utf8(claude_out).unwrap().trim(), "{}");
    }

    // Env is process-global: serialize every test that touches CLAUDE_AUDIT_DIR.


    fn with_audit_dir<T>(f: impl FnOnce() -> T) -> (T, String) {
        let _g = crate::cli::AUDIT_ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let dir = std::env::temp_dir().join(format!("harness-t5-{}-{:?}", std::process::id(), std::thread::current().id()));
        let _ = fs::remove_dir_all(&dir);
        std::env::set_var("CLAUDE_AUDIT_DIR", &dir);
        let r = f();
        std::env::remove_var("CLAUDE_AUDIT_DIR");
        let mut found = String::new();
        for e in walk(&dir) {
            found.push_str(&fs::read_to_string(e).unwrap_or_default());
        }
        let _ = fs::remove_dir_all(&dir);
        (r, found)
    }

    fn run_with(host: Host, event: &str, read: StdinRead) -> (String, String, i32) {
        let (r, _) = run_with_audit(host, event, read);
        r
    }

    fn run_with_audit(host: Host, event: &str, read: StdinRead) -> ((String, String, i32), String) {
        with_audit_dir(|| run_with_raw(host, event, read))
    }

    fn run_with_raw(host: Host, event: &str, read: StdinRead) -> (String, String, i32) {
        let emitted = AtomicBool::new(false);
        let is_agy_pre = AtomicBool::new(false);
        let (mut out, mut err) = (Vec::new(), Vec::new());
        let code = run_hook_with_read(
            host,
            Some(event),
            read,
            &emitted,
            &is_agy_pre,
            &mut out,
            &mut err,
        );
        (
            String::from_utf8(out).unwrap(),
            String::from_utf8(err).unwrap(),
            code,
        )
    }

    fn oversize_read(head: &str, tail: &str) -> StdinRead {
        let mut payload = head.to_string();
        payload.push_str(&"x".repeat(9 * 1024 * 1024));
        payload.push_str(tail);
        read_capped_reader_partial(
            io::Cursor::new(payload.into_bytes()),
            HOOK_STDIN_CAP,
            Duration::from_secs(10),
        )
    }

    fn t6_dir(tag: &str) -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!("harness-t6-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    const T6_DENY_RULE: &str = "[[path_rules]]\nid = \"t6-proj\"\ntools = [\"Read\"]\naction = \"deny\"\nmatch_kind = \"regex\"\npattern = 't6-marker'\nreason = \"proj\"\n";

    fn json_read(v: serde_json::Value) -> StdinRead {
        StdinRead { res: Ok(v.to_string().into_bytes()), partial: Vec::new() }
    }

    #[test]
    fn ws_prefers_claude_project_dir() {
        let _g = crate::cli::AUDIT_ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let hub = t6_dir("prefer");
        fs::create_dir_all(hub.join(".harness")).unwrap();
        fs::write(hub.join(".harness/rules.toml"), T6_DENY_RULE).unwrap();
        let wt = hub.join(".worktrees/x");
        fs::create_dir_all(&wt).unwrap();
        fs::write(wt.join(".git"), "gitdir: /nowhere/else").unwrap();
        std::env::set_var("CLAUDE_PROJECT_DIR", &hub);
        std::env::set_var("CLAUDE_AUDIT_DIR", hub.join("aud"));
        let (out, _, _) = run_with_raw(
            Host::Claude,
            "PreToolUse",
            json_read(serde_json::json!({"hook_event_name":"PreToolUse","cwd":wt,
                "tool_name":"Read","tool_input":{"file_path":"/tmp/t6-marker.txt"}})),
        );
        std::env::remove_var("CLAUDE_PROJECT_DIR");
        std::env::remove_var("CLAUDE_AUDIT_DIR");
        assert!(out.contains(r#""permissionDecision":"deny""#), "{out}");
        let _ = fs::remove_dir_all(&hub);
    }

    #[test]
    fn ws_tmp_cwd_still_core_and_user() {
        let _g = crate::cli::AUDIT_ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let d = t6_dir("tmpcwd");
        std::env::remove_var("CLAUDE_PROJECT_DIR");
        std::env::set_var("CLAUDE_AUDIT_DIR", d.join("aud"));
        let (out, _, _) = run_with_raw(
            Host::Claude,
            "PreToolUse",
            json_read(serde_json::json!({"hook_event_name":"PreToolUse","cwd":d.join("nope/x"),
                "tool_name":"Bash","tool_input":{"command":"cat .env"}})),
        );
        std::env::remove_var("CLAUDE_AUDIT_DIR");
        assert!(out.contains(r#""permissionDecision":"deny""#), "{out}");
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn agy_off_file_in_project_is_ignored_by_hook() {
        let _g = crate::cli::AUDIT_ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let d = t6_dir("agyoff");
        fs::create_dir_all(d.join(".harness")).unwrap();
        fs::write(d.join(".harness/agy.off"), "").unwrap();
        fs::write(d.join(".harness/rules.toml"), "").unwrap();
        std::env::remove_var("HARNESS_AGY");
        std::env::set_var("CLAUDE_AUDIT_DIR", d.join("aud"));
        let payload = serde_json::json!({"conversationId":"t","workspacePaths":[d],
            "toolCall":{"name":"run_command","args":{"CommandLine":"cat .env"}}});
        let (out, _, _) = run_with_raw(Host::Agy, "PreToolUse", json_read(payload));
        std::env::remove_var("CLAUDE_AUDIT_DIR");
        assert!(out.contains(r#""decision":"deny""#), "agy.off must be ignored: {out}");
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn oversize_write_env_is_denied() {
        let read = oversize_read(
            r#"{"hook_event_name":"PreToolUse","tool_name":"Write","tool_input":{"file_path":".env","content":""#,
            r#""}}"#,
        );
        assert_eq!(read.res.as_ref().unwrap_err(), "stdin oversize");
        let (out, err, code) = run_with(Host::Claude, "PreToolUse", read);
        assert_eq!(code, 0);
        assert!(out.contains(r#""permissionDecision":"deny""#), "{out}");
        assert!(err.contains("HKERR"), "{err}");
        assert!(!err.contains("xxxx"), "payload leaked to stderr");

        let read = oversize_read(
            r#"{"toolCall":{"name":"write_file","args":{"Path":".env"}},"pad":""#,
            r#""}"#,
        );
        let (out, _, _) = run_with(Host::Agy, "PreToolUse", read);
        assert!(out.contains(r#""decision":"deny""#), "{out}");
    }

    #[test]
    fn oversize_read_allows_with_stderr() {
        let read = oversize_read(
            r#"{"hook_event_name":"PreToolUse","tool_name":"Read","tool_input":{"file_path":"/tmp/a.txt"},"pad":""#,
            r#""}"#,
        );
        let (out, err, code) = run_with(Host::Claude, "PreToolUse", read);
        assert_eq!(code, 0);
        assert!(!out.contains("deny"), "{out}");
        assert!(err.contains("HKERR"), "{err}");

        let read = oversize_read(
            r#"{"toolCall":{"name":"view_file","args":{"Path":"/tmp/a.txt"}},"pad":""#,
            r#""}"#,
        );
        let (out, err, _) = run_with(Host::Agy, "PreToolUse", read);
        assert_eq!(out.trim(), r#"{"decision":"allow"}"#);
        assert!(err.contains("HKERR"), "{err}");
    }

    #[test]
    fn timeout_partial_write_denied() {
        let (rx_pipe, mut tx_pipe) = io::pipe().unwrap();
        tx_pipe.write_all(br#"{"tool_name":"Write""#).unwrap();
        let read = read_capped_reader_partial(rx_pipe, 1024, Duration::from_millis(80));
        assert_eq!(read.res.as_ref().unwrap_err(), "stdin timeout");
        let (out, err, _) = run_with(Host::Claude, "PreToolUse", read);
        assert!(out.contains(r#""permissionDecision":"deny""#), "{out}");
        assert!(err.contains("HKERR"), "{err}");
        drop(tx_pipe);
    }

    #[test]
    fn fail_open_always_logs() {
        let read = StdinRead {
            res: Ok(b"{not json".to_vec()),
            partial: Vec::new(),
        };
        let ((out, err, code), found) = run_with_audit(Host::Claude, "PostToolUse", read);
        assert_eq!(code, 0);
        assert_eq!(out.trim(), "{}");
        assert_eq!(err.lines().count(), 1, "{err}");
        assert!(err.starts_with("HKERR PostToolUse "), "{err}");
        assert!(found.contains(r#""status":"fail_open""#), "audit: {found}");
    }

    #[test]
    fn oversize_agy_ignores_tool_name_in_args() {
        let read = oversize_read(
            r#"{"toolCall":{"name":"write_file","args":{"tool_name":"view_file","TargetFile":".claude/settings.json"}},"pad":""#,
            r#""}"#,
        );
        let (out, _, _) = run_with(Host::Agy, "PreToolUse", read);
        assert!(out.contains(r#""decision":"deny""#), "{out}");
    }

    #[test]
    fn oversize_agy_name_only_at_depth_one() {
        let read = oversize_read(
            r#"{"toolCall":{"args":{"name":"view_file","TargetFile":".claude/settings.json"},"name":"write_file"},"pad":""#,
            r#""}"#,
        );
        let (out, _, _) = run_with(Host::Agy, "PreToolUse", read);
        assert!(out.contains(r#""decision":"deny""#), "{out}");
        let read = oversize_read(
            r#"{"toolCall":{"args":{"x":{"toolCall":{"name":"view_file"}},"s":"}{\"name\":\"view_file\""},"name":"write_file"},"pad":""#,
            r#""}"#,
        );
        let (out, _, _) = run_with(Host::Agy, "PreToolUse", read);
        assert!(out.contains(r#""decision":"deny""#), "{out}");
    }

    #[test]
    fn bad_json_agy_toolcall_without_name_denied() {
        let raw = br#"{"toolCall":{"args":{"a":"\ud800"}}}"#;
        let read = StdinRead { res: Ok(raw.to_vec()), partial: Vec::new() };
        let (out, _, _) = run_with(Host::Agy, "PreToolUse", read);
        assert!(out.contains(r#""decision":"deny""#), "{out}");
    }

    #[test]
    fn bad_json_write_is_denied() {
        let raw = br#"{"hook_event_name":"PreToolUse","tool_name":"Write","tool_input":{"file_path":".env","content":"\ud800"}}"#;
        let read = StdinRead { res: Ok(raw.to_vec()), partial: Vec::new() };
        let ((out, err, _), found) = run_with_audit(Host::Claude, "PreToolUse", read);
        assert!(out.contains(r#""permissionDecision":"deny""#), "{out}");
        assert!(err.starts_with("HKERR PreToolUse "), "{err}");
        assert!(found.contains("stdin-guard"), "audit: {found}");
    }

    #[test]
    fn real_fd_timeout_partial_write_denied() {
        use std::os::unix::io::AsRawFd;
        let (rx, mut tx) = io::pipe().unwrap();
        tx.write_all(br#"{"tool_name":"Bash""#).unwrap();
        let mut buf = Vec::new();
        let r = read_capped_fd_partial(rx.as_raw_fd(), 1024, Duration::from_millis(80), &mut buf);
        assert_eq!(r.unwrap_err(), "stdin timeout");
        let read = StdinRead { res: Err("stdin timeout".into()), partial: buf };
        let (out, _, _) = run_with(Host::Claude, "PreToolUse", read);
        assert!(out.contains(r#""permissionDecision":"deny""#), "{out}");
        drop(tx);
    }

    #[test]
    fn unknown_tool_oversize_denied_mcp_allowed() {
        let read = oversize_read(r#"{"tool_name":"SomethingNew","pad":""#, r#""}"#);
        let (out, _, _) = run_with(Host::Claude, "PreToolUse", read);
        assert!(out.contains(r#""permissionDecision":"deny""#), "{out}");
        let read = oversize_read(r#"{"tool_name":"mcp__x__y","pad":""#, r#""}"#);
        let (out, err, _) = run_with(Host::Claude, "PreToolUse", read);
        assert!(!out.contains("deny"), "{out}");
        assert!(err.contains("HKERR"), "{err}");
    }

    #[test]
    fn panic_branch_reports_hkerr_and_audits() {
        let ((), found) = with_audit_dir(|| {
            let mut err = Vec::new();
            report_panic(Host::Claude, "PreToolUse", &mut err);
            let s = String::from_utf8(err).unwrap();
            assert_eq!(s.lines().count(), 1, "{s}");
            assert!(s.starts_with("HKERR PreToolUse panic"), "{s}");
        });
        assert!(found.contains(r#""status":"fail_open""#), "audit: {found}");
    }

    fn walk(p: &std::path::Path) -> Vec<std::path::PathBuf> {
        let mut v = Vec::new();
        if let Ok(rd) = fs::read_dir(p) {
            for e in rd.flatten() {
                let path = e.path();
                if path.is_dir() {
                    v.extend(walk(&path));
                } else {
                    v.push(path);
                }
            }
        }
        v
    }

    #[test]
    fn read_capped_reader_times_out_on_hanging_pipe() {
        let ok = read_capped_reader_with_timeout(
            io::Cursor::new(b"hello".to_vec()),
            1024,
            Duration::from_millis(200),
        )
        .unwrap();
        assert_eq!(ok, b"hello");

        let (rx_pipe, tx_pipe) = io::pipe().unwrap();
        let err = read_capped_reader_with_timeout(rx_pipe, 1024, Duration::from_millis(60))
            .unwrap_err();
        assert_eq!(err, "stdin timeout");
        drop(tx_pipe);

        #[cfg(unix)]
        {
            use std::os::unix::io::AsRawFd;
            let (rx_fd_pipe, mut tx_fd_pipe) = io::pipe().unwrap();
            tx_fd_pipe.write_all(b"partial").unwrap();
            let err_fd = read_capped_fd_with_timeout(
                rx_fd_pipe.as_raw_fd(),
                1024,
                Duration::from_millis(60),
            )
            .unwrap_err();
            assert_eq!(err_fd, "stdin timeout");
            drop(tx_fd_pipe);

            let (rx_ok, mut tx_ok) = io::pipe().unwrap();
            tx_ok.write_all(b"{\"ok\":true}").unwrap();
            drop(tx_ok);
            let data = read_capped_fd_with_timeout(
                rx_ok.as_raw_fd(),
                1024,
                Duration::from_millis(200),
            )
            .unwrap();
            assert_eq!(data, b"{\"ok\":true}");
        }
    }
}
