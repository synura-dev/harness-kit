use super::*;
use crate::host::parse_stdin;

const FIXTURE: &str = include_str!("../../tests/fixtures/hub-rules.toml");

fn eval_toml(toml: &str, cwd: &str, cmd: &str) -> Option<Decision> {
    let engine = RulesEngine::from_toml_str(toml).expect("valid toml");
    let payload = serde_json::json!({
        "hook_event_name": "PreToolUse",
        "session_id": "test",
        "cwd": cwd,
        "tool_name": "Bash",
        "tool_input": {"command": cmd},
    });
    let input = parse_stdin(Host::Claude, Some("PreToolUse"), payload.to_string().as_bytes())
        .expect("parse");
    let paths = WorkspacePaths {
        workspace: PathBuf::from("/work/hub"),
        data_dir: PathBuf::from("/work/hub/data"),
        audit_root: PathBuf::from("/tmp/harness-test-audit"),
        has_workspace_marker: true,
        is_plugin_mode: false,
    };
    engine.evaluate(&input, &paths).decision
}

const WS: &str = "/work/hub";

fn eval(cmd: &str) -> Option<Decision> {
    eval_toml(FIXTURE, WS, cmd)
}

const NEVER_RULE: &str = "[[bash_rules]]\nid = \"t\"\nkind = \"regex\"\naction = \"deny\"\npattern = '(?s).*'\nreason = \"x\"\n";

#[test]
fn prefilter_absent_still_matches() {
    assert_eq!(eval_toml(NEVER_RULE, WS, "ls"), Some(Decision::Deny));
}

#[test]
fn prefilter_miss_skips_rule() {
    let toml = format!("{NEVER_RULE}prefilter = [\"zzz\"]\n");
    assert_eq!(eval_toml(&toml, WS, "ls"), None);
    assert_eq!(eval_toml(&toml, WS, "echo ZZZ"), Some(Decision::Deny));
    // nested/empty quotes cannot hide the keyword
    assert_eq!(eval_toml(&toml, WS, "echo z\"\"zz"), Some(Decision::Deny));
    assert_eq!(eval_toml(&toml, WS, "echo 'z'\"z\"'z'"), Some(Decision::Deny));
}

#[test]
fn prefilter_matches_cwd_path() {
    let toml = format!("{NEVER_RULE}prefilter = [\"zzz\"]\n");
    assert_eq!(eval_toml(&toml, "/tmp/zzz", "ls"), Some(Decision::Deny));
}

#[test]
fn prefilter_empty_quote_split_keyword_still_denied_worktree() {
    // T7a hole: prefilter on raw cmd missed `wor""ktrees`
    let cmd = "node .wor\"\"ktrees/x/hub/memory/mem.mjs get a";
    assert_eq!(eval(cmd), Some(Decision::Deny));
    assert_eq!(eval("node .worktrees/x/hub/memory/mem.mjs get a"), Some(Decision::Deny));
}

#[test]
fn mongo_prefilter_still_guards() {
    assert_eq!(eval("mongosh --port 27018"), Some(Decision::Ask));
    assert_eq!(eval("m\"\"ongosh --port 27018"), Some(Decision::Ask));
    assert_eq!(eval("ssh -L 27017:h:27017 box"), Some(Decision::Ask));
    assert_eq!(eval("ls"), None);
}

#[test]
fn no_hub_literals_in_code() {
    let files = [
        ("mod.rs", include_str!("mod.rs")),
        ("load.rs", include_str!("load.rs")),
        ("command_guard.rs", include_str!("command_guard.rs")),
        ("data_gate.rs", include_str!("data_gate.rs")),
        ("worktree.rs", include_str!("worktree.rs")),
        ("core_guard.rs", include_str!("core_guard.rs")),
        ("shell_parse.rs", include_str!("shell_parse.rs")),
    ];
    for (name, src) in files {
        // drop comment lines
        let code: String = src
            .lines()
            .filter(|l| !l.trim_start().starts_with("//"))
            .collect::<Vec<_>>()
            .join("\n")
            .to_ascii_lowercase();
        for bad in ["mongo", "2701", "memories", "\"worktrees\"", "contains(\"worktrees"] {
            assert!(!code.contains(bad), "{name} contains hub literal {bad:?}");
        }
    }
}

#[test]
fn data_gate_bare_word_data_allowed() {
    assert_eq!(eval("cargo test data::"), None);
    assert_eq!(eval("grep data src/main.rs"), None);
    assert_eq!(eval("grep -rn data ."), None);
    assert_eq!(eval("echo data"), None);
}

#[test]
fn data_gate_real_data_path_denied() {
    assert_eq!(eval("cat data/system/x.jsonl"), Some(Decision::Deny));
    assert_eq!(
        eval("cat '/work/hub/data/system/x.jsonl'"),
        Some(Decision::Deny)
    );
    assert_eq!(eval("ls data"), Some(Decision::Deny));
    assert_eq!(eval("harness data ls"), None);
}

#[test]
fn prefilter_sees_shell_backslash_escapes() {
    assert_eq!(eval("m\\ongosh --eval x"), Some(Decision::Ask));
    assert_eq!(eval("pkill -f mon\\god"), Some(Decision::Ask));
    assert_eq!(eval("bash -c 'm\\ongosh --eval x'"), Some(Decision::Ask));
}

#[test]
fn data_gate_prefilter_uses_dir_basename_not_bare_word() {
    // protected dir named "vault": the bare word must not matter, the dir path must
    let paths = WorkspacePaths {
        workspace: PathBuf::from("/ws"),
        data_dir: PathBuf::from("/ws/vault"),
        audit_root: PathBuf::from("/tmp/harness-test-audit"),
        has_workspace_marker: true,
        is_plugin_mode: false,
    };
    let run = |cmd: &str| {
        let engine = RulesEngine::from_toml_str("[data_gate]\n").expect("gate on");
        let payload = serde_json::json!({"hook_event_name":"PreToolUse","session_id":"t","cwd":"/ws","tool_name":"Bash","tool_input":{"command":cmd}});
        let input = parse_stdin(Host::Claude, Some("PreToolUse"), payload.to_string().as_bytes()).unwrap();
        engine.evaluate(&input, &paths).decision
    };
    assert_eq!(run("cargo test data::"), None);
    assert_eq!(run("cat vault/x.jsonl"), Some(Decision::Deny));
}
