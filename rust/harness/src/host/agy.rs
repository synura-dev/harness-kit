use super::{Decision, HookInput, HookOutcome, Host, RenderedOutput};
use serde_json::{json, Map, Value};

pub fn map_tool_name(name: &str) -> String {
    match name {
        "run_command" => "Bash".to_string(),
        "write_file" | "write_to_file" => "Write".to_string(),
        "edit_file" | "replace_file_content" | "multi_replace_file_content" => "Edit".to_string(),
        "read_file" | "view_file" | "view_file_outline" | "view_code_item" => "Read".to_string(),
        "find_by_name" | "list_dir" => "Glob".to_string(),
        "grep_search" => "Grep".to_string(),
        "call_mcp_tool" => "MCP".to_string(),
        "invoke_subagent" | "send_message" => "Agent".to_string(),
        s if s.starts_with("mcp_") => "MCP".to_string(),
        other => other.to_string(),
    }
}

fn pick_arg(args: &Map<String, Value>, keys: &[&str]) -> Option<String> {
    for &k in keys {
        if let Some(v) = args.get(k) {
            if let Some(s) = v.as_str() {
                if !s.trim().is_empty() {
                    return Some(s.to_string());
                }
            } else if let Some(n) = v.as_i64() {
                return Some(n.to_string());
            } else if let Some(n) = v.as_u64() {
                return Some(n.to_string());
            }
        }
    }
    for &k in keys {
        let lower = k.to_ascii_lowercase();
        for (ak, av) in args {
            if ak.to_ascii_lowercase() == lower {
                if let Some(s) = av.as_str() {
                    if !s.trim().is_empty() {
                        return Some(s.to_string());
                    }
                } else if let Some(n) = av.as_i64() {
                    return Some(n.to_string());
                } else if let Some(n) = av.as_u64() {
                    return Some(n.to_string());
                }
            }
        }
    }
    None
}

fn pick_command_raw(args: &Map<String, Value>) -> Option<String> {
    for k in ["CommandLine", "commandLine", "command", "cmd"] {
        if let Some(s) = args.get(k).and_then(Value::as_str) {
            return Some(s.to_string());
        }
    }
    None
}

pub fn normalize(event_arg: Option<&str>, raw: Value) -> HookInput {
    let tc = raw.get("toolCall").and_then(Value::as_object);
    let raw_tool_name = tc
        .and_then(|o| o.get("name").and_then(Value::as_str))
        .or_else(|| raw.get("toolName").and_then(Value::as_str))
        .or_else(|| raw.get("tool_name").and_then(Value::as_str))
        .map(ToString::to_string);

    let event = event_arg
        .filter(|s| !s.trim().is_empty())
        .map(ToString::to_string)
        .or_else(|| {
            raw.get("hook_event_name")
                .or_else(|| raw.get("hookEventName"))
                .or_else(|| raw.get("event"))
                .or_else(|| raw.get("eventName"))
                .and_then(Value::as_str)
                .map(ToString::to_string)
        })
        .unwrap_or_else(|| {
            if raw_tool_name.is_some() {
                "PostToolUse".to_string()
            } else if raw.get("terminationReason").is_some() || raw.get("fullyIdle").is_some() {
                "Stop".to_string()
            } else if raw.get("invocationNum").is_some() {
                "UserPromptSubmit".to_string()
            } else {
                "SessionStart".to_string()
            }
        });

    let session_id = raw
        .get("conversationId")
        .or_else(|| raw.get("sessionId"))
        .or_else(|| raw.get("session_id"))
        .and_then(Value::as_str)
        .map(ToString::to_string);

    let workspace_paths: Vec<String> = raw
        .get("workspacePaths")
        .and_then(Value::as_array)
        .map(|arr| {
            arr.iter()
                .filter_map(Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(ToString::to_string)
                .collect()
        })
        .unwrap_or_default();

    let raw_args_val = tc
        .and_then(|o| o.get("args"))
        .or_else(|| raw.get("toolInput"))
        .or_else(|| raw.get("tool_input"))
        .filter(|v| v.is_object())
        .cloned()
        .unwrap_or_else(|| Value::Object(Map::new()));

    let args_map = raw_args_val.as_object();

    let args_cwd = args_map.and_then(|m| pick_arg(m, &["Cwd", "cwd"]));
    let raw_cwd = raw
        .get("cwd")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(ToString::to_string);
    let raw_ws_path = raw
        .get("workspacePath")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(ToString::to_string);

    let workspace_cwd = workspace_paths
        .first()
        .cloned()
        .or(raw_ws_path)
        .or_else(|| args_cwd.clone())
        .or_else(|| raw_cwd.clone());
    let tool_cwd = args_cwd.or(raw_cwd).or_else(|| workspace_cwd.clone());

    let tool_name = raw_tool_name.as_deref().map(map_tool_name);
    let mut ti = Map::new();

    if let (Some(mapped), Some(args)) = (tool_name.as_deref(), args_map) {
        match mapped {
            "Bash" => {
                if let Some(cmd) = pick_command_raw(args) {
                    ti.insert("command".to_string(), Value::String(cmd));
                }
            }
            "Read" | "Write" | "Edit" => {
                if let Some(fp) = pick_arg(
                    args,
                    &[
                        "Path",
                        "TargetFile",
                        "AbsolutePath",
                        "FilePath",
                        "file_path",
                        "path",
                    ],
                ) {
                    ti.insert("file_path".to_string(), Value::String(fp));
                }
                if mapped == "Read" {
                    if let Some(off) = pick_arg(args, &["StartLine", "offset", "ByteOffset"]) {
                        if let Ok(n) = off.parse::<i64>() {
                            ti.insert("offset".to_string(), Value::Number(n.into()));
                        }
                    }
                    if let Some(lim) = pick_arg(args, &["EndLine", "limit"]) {
                        if let Ok(n) = lim.parse::<i64>() {
                            ti.insert("limit".to_string(), Value::Number(n.into()));
                        }
                    }
                }
            }
            "Glob" | "Grep" => {
                if let Some(p) = pick_arg(
                    args,
                    &[
                        "SearchDirectory",
                        "SearchPath",
                        "DirectoryPath",
                        "TargetDirectory",
                        "Path",
                        "path",
                    ],
                ) {
                    ti.insert("path".to_string(), Value::String(p));
                }
                if let Some(pat) = pick_arg(args, &["Pattern", "Query", "pattern", "query"]) {
                    ti.insert("pattern".to_string(), Value::String(pat));
                }
            }
            "MCP" => {
                let mut srv = pick_arg(args, &["ServerName", "serverName", "server_name", "server"]);
                let mut tname = pick_arg(args, &["ToolName", "toolName", "tool_name", "tool"]);
                if (srv.is_none() || tname.is_none())
                    && raw_tool_name
                        .as_deref()
                        .is_some_and(|n| n.starts_with("mcp_"))
                {
                    let rest = &raw_tool_name.as_deref().unwrap_or("")[4..];
                    let mut parts = rest.splitn(2, '_');
                    if srv.is_none() {
                        srv = parts.next().map(ToString::to_string);
                    }
                    if tname.is_none() {
                        tname = parts.next().map(ToString::to_string);
                    }
                }
                if let Some(s) = &srv {
                    ti.insert("server_name".to_string(), Value::String(s.clone()));
                    ti.insert("server".to_string(), Value::String(s.clone()));
                }
                if let Some(t) = &tname {
                    ti.insert("tool_name".to_string(), Value::String(t.clone()));
                }
                let target = match (srv, tname) {
                    (Some(s), Some(t)) => Some(format!("{s}/{t}")),
                    (None, Some(t)) => Some(t),
                    (Some(s), None) => Some(s),
                    (None, None) => None,
                };
                if let Some(t) = target {
                    ti.insert("name".to_string(), Value::String(t.clone()));
                    ti.insert("pattern".to_string(), Value::String(t));
                }
            }
            "Agent" => {
                let is_send = raw_tool_name.as_deref() == Some("send_message");
                if is_send {
                    let rec = pick_arg(args, &["Recipient", "recipient"])
                        .unwrap_or_else(|| "peer".to_string());
                    ti.insert("subagent_type".to_string(), Value::String(rec.clone()));
                    ti.insert("recipient".to_string(), Value::String(rec));
                    if let Some(msg) = pick_arg(args, &["Message", "message"]) {
                        ti.insert("prompt".to_string(), Value::String(msg));
                    }
                } else {
                    let st = pick_arg(
                        args,
                        &["TypeName", "typeName", "Role", "role", "subagent_type", "type"],
                    )
                    .unwrap_or_else(|| "subagent".to_string());
                    ti.insert("subagent_type".to_string(), Value::String(st));
                    if let Some(p) = pick_arg(args, &["Prompt", "prompt"]) {
                        ti.insert("prompt".to_string(), Value::String(p));
                    }
                    if let Some(m) = pick_arg(args, &["Model", "model"]) {
                        ti.insert("model".to_string(), Value::String(m));
                    }
                }
            }
            _ => {
                if let Some(obj) = raw_args_val.as_object() {
                    ti = obj.clone();
                }
            }
        }
    }

    let tool_response = raw
        .get("toolResult")
        .or_else(|| raw.get("tool_result"))
        .or_else(|| raw.get("toolResponse"))
        .or_else(|| raw.get("tool_response"))
        .or_else(|| raw.get("result"))
        .cloned();

    HookInput {
        host: Host::Agy,
        event,
        session_id,
        workspace_cwd,
        tool_cwd,
        workspace_paths,
        tool_name,
        raw_tool_name,
        tool_input: Value::Object(ti),
        raw_args: raw_args_val,
        tool_use_id: raw
            .get("stepIdx")
            .and_then(|v| v.as_i64().map(|n| format!("step-{n}")))
            .or_else(|| {
                raw.get("stepIdx")
                    .and_then(Value::as_str)
                    .map(|s| format!("step-{s}"))
            }),
        tool_response,
        raw,
    }
}

/// CRITICAL agy contract:
/// - On PreToolUse: ALWAYS emit `{"decision":"allow"}` or `{"decision":"deny","reason":"..."}`.
///   NEVER emit `{}` (agy treats `{}` as DENY) and NEVER emit `updatedInput` (protojson rejects).
/// - `ask` MUST map to `deny` with `[ASK] ` prefix.
/// - Non-PreToolUse events MUST emit `{}`.
pub fn render(event: &str, outcome: &HookOutcome) -> RenderedOutput {
    if event != "PreToolUse" {
        return RenderedOutput {
            stdout: "{}\n".to_string(),
            stderr: String::new(),
            exit_code: 0,
        };
    }

    let stdout = match outcome.decision {
        Some(Decision::Deny) => match &outcome.reason {
            Some(r) => json!({ "decision": "deny", "reason": r }).to_string(),
            None => json!({ "decision": "deny" }).to_string(),
        },
        Some(Decision::Ask) => {
            let r = outcome.reason.as_deref().unwrap_or("approval");
            json!({ "decision": "deny", "reason": format!("[ASK] {r}") }).to_string()
        }
        Some(Decision::Allow) | None => r#"{"decision":"allow"}"#.to_string(),
    };

    RenderedOutput {
        stdout: format!("{stdout}\n"),
        stderr: String::new(),
        exit_code: 0,
    }
}

/// Fail-open output (PreToolUse stays valid `{"decision":"allow"}`); stderr always carries HKERR.
pub fn fail_open(event: &str, why: &str) -> RenderedOutput {
    let stderr = format!("HKERR {event} {why}\n");
    if event == "PreToolUse" {
        RenderedOutput {
            stdout: "{\"decision\":\"allow\"}\n".to_string(),
            stderr,
            exit_code: 0,
        }
    } else {
        RenderedOutput {
            stdout: "{}\n".to_string(),
            stderr,
            exit_code: 0,
        }
    }
}
