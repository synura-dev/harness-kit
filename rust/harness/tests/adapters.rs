use serde_json::Value;
use std::fs;
use std::path::PathBuf;

const CLAUDE_EVENTS: &[&str] = &[
    "SessionStart",
    "UserPromptSubmit",
    "PreToolUse",
    "PostToolUse",
    "PostToolUseFailure",
    "PermissionRequest",
    "PermissionDenied",
    "Notification",
    "SubagentStart",
    "Stop",
    "SubagentStop",
    "SessionEnd",
    "WorktreeCreate",
    "WorktreeRemove",
];
const AGY_EVENTS: &[&str] = &["SessionStart", "PreToolUse", "PostToolUse", "PostInvocation", "Stop"];

fn repo_file(rel: &str) -> Value {
    let p = PathBuf::from(env!("CARGO_MANIFEST_DIR")).parent().unwrap().parent().unwrap().join(rel);
    let s = fs::read_to_string(&p).unwrap_or_else(|e| panic!("{}: {e}", p.display()));
    serde_json::from_str(&s).unwrap_or_else(|e| panic!("{}: {e}", p.display()))
}

/// Walk the JSON and collect (event, command) for every `command` entry under an event key.
fn commands(root: &Value) -> Vec<(String, String)> {
    fn walk(ev: &str, v: &Value, out: &mut Vec<(String, String)>) {
        match v {
            Value::Object(m) => {
                if let Some(c) = m.get("command").and_then(Value::as_str) {
                    out.push((ev.to_string(), c.to_string()));
                }
                for c in m.values() {
                    walk(ev, c, out);
                }
            }
            Value::Array(a) => a.iter().for_each(|c| walk(ev, c, out)),
            _ => {}
        }
    }
    let mut out = Vec::new();
    let events = root.as_object().expect("object");
    for (ev, v) in events {
        walk(ev, v, &mut out);
    }
    out
}

fn check(root: &Value, prefix: &str, host: &str, allowed: &[&str]) {
    let cmds = commands(root);
    assert_eq!(cmds.len(), allowed.len(), "one command per event: {cmds:?}");
    for (ev, cmd) in cmds {
        assert!(allowed.contains(&ev.as_str()), "unsupported event {ev}");
        assert_eq!(cmd, format!("{prefix} hook --host {host} {ev}"));
    }
}

#[test]
fn claude_hooks_use_plugin_root_binary() {
    let v = repo_file("plugins/claude/hooks/hooks.json");
    check(
        &v["hooks"],
        "${CLAUDE_PLUGIN_ROOT}/bin/harness-rs",
        "claude",
        CLAUDE_EVENTS,
    );
}

#[test]
fn agy_hooks_use_relative_binary() {
    let v = repo_file("plugins/agy/hooks.json");
    let inner = &v["harness-kit"];
    assert!(inner.is_object(), "agy hooks keyed by plugin name");
    check(inner, "./bin/harness-rs", "agy", AGY_EVENTS);
}

#[test]
fn claude_mcp_points_at_plugin_binary() {
    let v = repo_file("plugins/claude/.mcp.json");
    let s = &v["mcpServers"]["harness"];
    assert_eq!(s["type"], "stdio");
    assert_eq!(s["command"], "${CLAUDE_PLUGIN_ROOT}/bin/harness-rs");
    assert_eq!(s["args"], serde_json::json!(["mcp"]));
}

#[test]
fn version_has_src_tree() {
    let out = std::process::Command::new(env!("CARGO_BIN_EXE_harness-rs"))
        .arg("--version")
        .output()
        .unwrap();
    let s = String::from_utf8_lossy(&out.stdout);
    let want = format!("harness-rs {} (src ", env!("CARGO_PKG_VERSION"));
    assert!(s.starts_with(&want), "{s}");
}

#[test]
fn marketplace_points_at_claude_plugin() {
    let v = repo_file(".claude-plugin/marketplace.json");
    assert_eq!(v["plugins"][0]["name"], "harness-kit");
    assert_eq!(v["plugins"][0]["source"], "./plugins/claude");
}
