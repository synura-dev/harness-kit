use super::*;
use crate::host::parse_stdin;

fn eval_bash(engine: &RulesEngine, host: Host, cmd: &str) -> Option<Decision> {
    let (payload, ev) = match host {
        Host::Claude => (
            serde_json::json!({"hook_event_name": "PreToolUse", "session_id": "t", "cwd": "/tmp",
                "tool_name": "Bash", "tool_input": {"command": cmd}}),
            "PreToolUse",
        ),
        Host::Agy => (
            serde_json::json!({"conversationId": "t", "workspacePaths": ["/tmp"],
                "toolCall": {"name": "run_command", "args": {"CommandLine": cmd}}}),
            "PreToolUse",
        ),
    };
    let input = parse_stdin(host, Some(ev), payload.to_string().as_bytes()).expect("parse");
    let paths = WorkspacePaths {
        workspace: PathBuf::from("/tmp"),
        data_dir: PathBuf::from("/tmp/data"),
        audit_root: PathBuf::from("/tmp/harness-test-audit"),
        has_workspace_marker: false,
        is_plugin_mode: false,
    };
    engine.evaluate(&input, &paths).decision
}

#[test]
fn rules_protect_rg_and_find_exec_are_not_pure_read() {
    let eng = RulesEngine::load_for_hook(Path::new("/tmp/harness-t6-none"), Host::Claude, Some("Bash"));
    for cmd in [
        "rg --pre sh x .harness",
        "rg --pre=sh x .harness/rules.toml",
        "rg --pre-glob '*' x .harness",
        "find .harness -exec sh -c 'rm {}' ;",
        "find .harness -ok rm {} ;",
        "find .harness -delete",
    ] {
        assert_eq!(eval_bash(&eng, Host::Claude, cmd), Some(Decision::Ask), "{cmd}");
    }
    for cmd in ["cat .harness/rules.toml", "grep id .harness/rules.toml", "find .harness -name '*.toml'"] {
        assert_ne!(eval_bash(&eng, Host::Claude, cmd), Some(Decision::Ask), "{cmd}");
    }
}

#[test]
fn tracked_rules_file_missing_fails_closed() {
    let base = std::env::temp_dir().join(format!("harness-t6-track-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&base);
    let ws = base.join("ws");
    std::fs::create_dir_all(ws.join(".git")).unwrap();
    std::fs::create_dir_all(ws.join(".harness")).unwrap();
    // Fake index: header bytes + entry name, as git stores it (plain path bytes).
    std::fs::write(ws.join(".git/index"), b"DIRC\0\0\0\x02\0\0\0\x01.....\0\x13.harness/rules.toml\0\0").unwrap();
    // File absent while tracked: catch-all fail-closed on Bash (Claude ask, agy deny).
    let eng = RulesEngine::load_for_hook(&ws, Host::Claude, Some("Bash"));
    assert_eq!(eval_bash(&eng, Host::Claude, "bash /tmp/x.sh"), Some(Decision::Ask));
    let eng = RulesEngine::load_for_hook(&ws, Host::Agy, Some("Bash"));
    assert_eq!(eval_bash(&eng, Host::Agy, "bash /tmp/x.sh"), Some(Decision::Deny));
    // File present: normal.
    std::fs::write(ws.join(".harness/rules.toml"), "").unwrap();
    let eng = RulesEngine::load_for_hook(&ws, Host::Claude, Some("Bash"));
    assert_ne!(eval_bash(&eng, Host::Claude, "bash /tmp/x.sh"), Some(Decision::Ask));
    // Not tracked: absent is fine.
    std::fs::remove_file(ws.join(".harness/rules.toml")).unwrap();
    std::fs::write(ws.join(".git/index"), b"DIRC\0\0\0\x02other").unwrap();
    let eng = RulesEngine::load_for_hook(&ws, Host::Claude, Some("Bash"));
    assert_ne!(eval_bash(&eng, Host::Claude, "bash /tmp/x.sh"), Some(Decision::Ask));
    let _ = std::fs::remove_dir_all(&base);
}
