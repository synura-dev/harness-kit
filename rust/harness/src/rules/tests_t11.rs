use super::*;
use crate::host::parse_stdin;

const FIXTURE: &str = include_str!("../../tests/fixtures/hub-rules.toml");
const WS: &str = "/work/hub";

fn eval_toml(toml: &str, tool: &str, input_json: serde_json::Value) -> Option<Decision> {
    let engine = RulesEngine::from_toml_str(toml).expect("valid toml");
    let payload = serde_json::json!({
        "hook_event_name": "PreToolUse", "session_id": "t", "cwd": WS,
        "tool_name": tool, "tool_input": input_json,
    });
    let input = parse_stdin(Host::Claude, Some("PreToolUse"), payload.to_string().as_bytes())
        .expect("parse");
    let paths = WorkspacePaths {
        workspace: PathBuf::from(WS),
        data_dir: PathBuf::from(format!("{WS}/data")),
        audit_root: PathBuf::from("/tmp/harness-test-audit"),
        has_workspace_marker: true,
        is_plugin_mode: false,
    };
    engine.evaluate(&input, &paths).decision
}

fn eval(cmd: &str) -> Option<Decision> {
    eval_toml(FIXTURE, "Bash", serde_json::json!({ "command": cmd }))
}

#[test]
fn backslash_escaped_memories_path_is_denied() {
    for cmd in [
        r"cat memo\ries/entities/a",
        r"cat mem\ories/ent\ities/a",
        r"grep -r x memo\ries",
    ] {
        assert_eq!(eval(cmd), Some(Decision::Deny), "{cmd}");
    }
}

#[test]
fn backslash_escaped_worktree_script_is_denied() {
    let cmd = r"node .wor\ktrees/x/hub/memory/mem.mjs get a";
    assert_eq!(eval(cmd), Some(Decision::Deny), "{cmd}");
}

#[test]
fn backslash_escaped_data_dir_is_blocked() {
    let cmd = r"cat d\ata/audit/x.jsonl";
    let d = eval(cmd);
    let plain = eval("cat data/audit/x.jsonl");
    // escaped form must be treated like the plain form
    assert_eq!(d, plain, "{cmd}");
}

#[test]
fn unless_uses_normalized_path() {
    let toml = "[[path_rules]]\nid = \"p\"\naction = \"deny\"\ntools = [\"Read\"]\npattern = '(^|/)secret/'\nunless = '^/ok/secret/'\nreason = \"x\"\n";
    // normalized path is /ok/secret/a, so unless must match and allow it
    let allowed = eval_toml(toml, "Read", serde_json::json!({ "file_path": r"\ok\secret\a" }));
    assert_eq!(allowed, None);
    let denied = eval_toml(toml, "Read", serde_json::json!({ "file_path": "/no/secret/a" }));
    assert_eq!(denied, Some(Decision::Deny));
}
