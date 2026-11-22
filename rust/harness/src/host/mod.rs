pub mod agy;
pub mod claude;

use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Host {
    Claude,
    Agy,
}

impl Host {
    pub fn as_str(self) -> &'static str {
        match self {
            Host::Claude => "claude",
            Host::Agy => "agy",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Decision {
    Allow,
    Ask,
    Deny,
}

impl Decision {
    pub fn as_str(self) -> &'static str {
        match self {
            Decision::Allow => "allow",
            Decision::Ask => "ask",
            Decision::Deny => "deny",
        }
    }
}

#[derive(Debug, Clone)]
pub struct HookInput {
    pub host: Host,
    pub event: String,
    pub session_id: Option<String>,
    pub workspace_cwd: Option<String>,
    pub tool_cwd: Option<String>,
    pub workspace_paths: Vec<String>,
    pub tool_name: Option<String>,
    pub raw_tool_name: Option<String>,
    pub tool_input: Value,
    pub raw_args: Value,
    pub tool_use_id: Option<String>,
    pub tool_response: Option<Value>,
    pub raw: Value,
}

#[derive(Debug, Clone, Default)]
pub struct HookOutcome {
    pub decision: Option<Decision>,
    pub reason: Option<String>,
    pub rule_id: Option<String>,
    pub hook_name: Option<String>,
    pub updated_input: Option<Value>,
    pub additional_context: Option<String>,
    pub block: bool,
    pub block_reason: Option<String>,
    pub system_message: Option<String>,
    pub worktree_path: Option<String>,
}

#[derive(Debug, Clone)]
pub struct RenderedOutput {
    pub stdout: String,
    pub stderr: String,
    pub exit_code: i32,
}

pub fn parse_stdin(host: Host, event_arg: Option<&str>, raw_bytes: &[u8]) -> Result<HookInput, String> {
    let text = std::str::from_utf8(raw_bytes).map_err(|_| "invalid utf8".to_string())?;
    let trimmed = text.strip_prefix('\u{feff}').unwrap_or(text).trim();
    if trimmed.is_empty() {
        return Err("empty stdin".to_string());
    }
    let val: Value = serde_json::from_str(trimmed).map_err(|e| format!("bad json: {e}"))?;
    if !val.is_object() {
        return Err("root must be object".to_string());
    }
    Ok(match host {
        Host::Claude => claude::normalize(event_arg, val),
        Host::Agy => agy::normalize(event_arg, val),
    })
}

pub fn render_outcome(host: Host, event: &str, outcome: &HookOutcome) -> RenderedOutput {
    match host {
        Host::Claude => claude::render(event, outcome),
        Host::Agy => agy::render(event, outcome),
    }
}

pub fn render_fail_open(host: Host, event: &str, why: &str) -> RenderedOutput {
    match host {
        Host::Claude => claude::fail_open(event, why),
        Host::Agy => agy::fail_open(event, why),
    }
}
