use super::{HookInput, HookOutcome, Host, RenderedOutput};
use serde_json::{json, Map, Value};

const BLOCK_EVENTS: &[&str] = &["Stop", "SubagentStop", "PostToolUse", "UserPromptSubmit"];

pub fn normalize(event_arg: Option<&str>, raw: Value) -> HookInput {
    let event = event_arg
        .filter(|s| !s.trim().is_empty())
        .map(ToString::to_string)
        .or_else(|| {
            raw.get("hook_event_name")
                .and_then(Value::as_str)
                .map(ToString::to_string)
        })
        .unwrap_or_else(|| "PreToolUse".to_string());

    let session_id = raw
        .get("session_id")
        .and_then(Value::as_str)
        .map(ToString::to_string);
    let cwd = raw
        .get("cwd")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(ToString::to_string);
    let workspace_cwd = cwd.clone();
    let tool_cwd = cwd;
    let tool_name = raw
        .get("tool_name")
        .and_then(Value::as_str)
        .map(ToString::to_string);
    let tool_input = raw
        .get("tool_input")
        .filter(|v| v.is_object())
        .cloned()
        .unwrap_or_else(|| Value::Object(Map::new()));
    let tool_use_id = raw
        .get("tool_use_id")
        .and_then(Value::as_str)
        .map(ToString::to_string);
    let tool_response = raw.get("tool_response").cloned();

    HookInput {
        host: Host::Claude,
        event,
        session_id,
        workspace_cwd,
        tool_cwd,
        workspace_paths: Vec::new(),
        raw_tool_name: tool_name.clone(),
        tool_name,
        tool_input,
        raw_args: Value::Object(Map::new()),
        tool_use_id,
        tool_response,
        raw,
    }
}

pub fn render(event: &str, outcome: &HookOutcome) -> RenderedOutput {
    if event == "WorktreeCreate" {
        if let Some(path) = &outcome.worktree_path {
            if !outcome.block {
                return RenderedOutput {
                    stdout: path.clone(),
                    stderr: String::new(),
                    exit_code: 0,
                };
            }
        }
        let reason = outcome
            .block_reason
            .as_deref()
            .filter(|r| !r.is_empty() && *r != "blocked")
            .unwrap_or("worktree create failed: missing path");
        return RenderedOutput {
            stdout: String::new(),
            stderr: format!("{reason}\n"),
            exit_code: 1,
        };
    }

    if event == "WorktreeRemove" {
        return RenderedOutput {
            stdout: String::new(),
            stderr: String::new(),
            exit_code: 0,
        };
    }

    if outcome.block && BLOCK_EVENTS.contains(&event) {
        let reason = outcome.block_reason.as_deref().unwrap_or("blocked");
        return RenderedOutput {
            stdout: json!({ "decision": "block", "reason": reason }).to_string(),
            stderr: String::new(),
            exit_code: 0,
        };
    }

    let mut hso = Map::new();
    hso.insert("hookEventName".to_string(), Value::String(event.to_string()));

    if event == "PreToolUse" {
        if let Some(decision) = outcome.decision {
            hso.insert(
                "permissionDecision".to_string(),
                Value::String(decision.as_str().to_string()),
            );
            if let Some(reason) = &outcome.reason {
                hso.insert(
                    "permissionDecisionReason".to_string(),
                    Value::String(reason.clone()),
                );
            }
        }
        if let Some(updated) = &outcome.updated_input {
            if updated.is_object() {
                hso.insert("updatedInput".to_string(), updated.clone());
            }
        }
    }

    if let Some(ctx) = &outcome.additional_context {
        if !ctx.is_empty() {
            hso.insert(
                "additionalContext".to_string(),
                Value::String(ctx.clone()),
            );
        }
    }

    let mut out = Map::new();
    if hso.len() > 1 {
        out.insert("hookSpecificOutput".to_string(), Value::Object(hso));
    }
    if let Some(msg) = &outcome.system_message {
        if !msg.is_empty() {
            out.insert("systemMessage".to_string(), Value::String(msg.clone()));
        }
    }

    RenderedOutput {
        stdout: Value::Object(out).to_string(),
        stderr: String::new(),
        exit_code: 0,
    }
}

pub fn fail_open(event: &str, why: &str) -> RenderedOutput {
    if event == "WorktreeCreate" {
        return RenderedOutput {
            stdout: String::new(),
            stderr: format!("HKERR {event} worktree create loi: {why}\n"),
            exit_code: 1,
        };
    }
    if event == "WorktreeRemove" {
        return RenderedOutput {
            stdout: String::new(),
            stderr: format!("HKERR {event} {why}\n"),
            exit_code: 0,
        };
    }
    RenderedOutput {
        stdout: "{}".to_string(),
        stderr: format!("HKERR {event} {why}\n"),
        exit_code: 0,
    }
}
