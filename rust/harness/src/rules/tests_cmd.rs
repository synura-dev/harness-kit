use super::*;
use crate::host::parse_stdin;

fn eval(cmd: &str) -> Option<Decision> {
    let engine = RulesEngine::from_toml_str(include_str!("../../tests/fixtures/hub-rules.toml"))
        .expect("valid hub-rules.toml");
    let payload = serde_json::json!({
        "hook_event_name": "PreToolUse",
        "session_id": "test",
        "cwd": "/work/hub",
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

#[test]
fn memories_guard_git_bypass_denied() {
    let cmds = [
        "git -c alias.w='!echo x > memories/entities/a.md' w",
        "git -c core.pager='sh -c \"cat > memories/x\"' log",
        "git -c core.editor='sh -c \"cat > memories/x\"' commit",
        "git -c core.sshCommand='sh -c \"cat > memories/x\"' fetch",
        "git -calias.w='!cat memories/entities/a.md' w",
        "X='!cat memories/entities/a' git --config-env=alias.w=X w",
        "/usr/bin/git -c alias.w='!cat memories/entities/a.md' w",
        "env git -c alias.w='!cat memories/entities/a.md' w",
        "env -S \"git -c alias.w='!cat memories/entities/a.md' w\"",
        "GIT_PAGER='sh -c \"cat > memories/x\"' git log",
        "env GIT_SSH_COMMAND='sh -c \"cat > memories/x\"' git fetch",
        "bash -lc \"git -c alias.w='!cat memories/entities/a.md' w\"",
        "echo $(git -c alias.w='!cat memories/entities/a.md' w)",
        // shortcut: nested-quote obfuscation inside an alias payload (mem""ories in single
        // quotes) escapes the mod.rs "memories" substring prefilter (T7b owns it); not covered.
        "GIT_TRACE=/abs/memories/entities/a.md git status",
        "GIT_INDEX_FILE=memories/entities/a.md git add -A",
        "git rebase -x 'sh -c \"echo x > memories/entities/a.md\"' HEAD~1",
        "git difftool -y -x 'cat memories/entities/a.md'",
        "git config alias.x '!cat memories/entities/a.md' && git x",
        "git submodule foreach 'cat memories/entities/a.md'",
        "git -c core.fsmonitor='cat memories/entities/a.md' status",
        "git bisect run cat memories/entities/a.md",
        "git fetch --upload-pack='cat memories/entities/a.md' origin",
        "git rebase -qx 'cat memories/entities/a.md' HEAD~1",
        "git fetch --exe='cat memories/entities/a.md' origin",
        "git clone -u 'cat memories/entities/a.md' src dst",
        "git fetch --upload-pa='cat memories/entities/a.md' origin",
        "git grep --open-files='cat memories/entities/a.md' foo",
        "git submodule--helper foreach 'cat memories/entities/a.md'",
        "git config --file=x --get memories/entities/a.md",
    ];
    let missed: Vec<&str> = cmds
        .into_iter()
        .filter(|c| eval(c) != Some(Decision::Deny))
        .collect();
    assert!(missed.is_empty(), "expected deny for: {missed:#?}");
}

#[test]
fn memories_guard_git_plain_allowed() {
    for cmd in [
        "git status",
        "git log memories/",
        "git diff -- memories/entities/a.md",
        "git -C /tmp status",
        "/usr/bin/git status",
        "env git log -n 3",
        "git commit -m 'update memories'",
        "git -c safe.directory=X -C /w diff -- memories/entities/a.md",
        "git -c safe.directory='*' -C hub log -- memories/entities/x.md",
        "git switch -c feat",
        "git commit -m \"update memories/entities\"",
        "git --no-pager log -- memories/entities/a.md",
        "git config --get user.name",
        "GIT_OPTIONAL_LOCKS=0 git -C hub log -- memories/entities/x.md",
        "git -c core.autocrlf=false -C w diff -- memories/entities/a.md",
    ] {
        assert_eq!(eval(cmd), None, "expected allow for: {cmd}");
    }
}

#[test]
fn memories_guard_rg_pre_denied_regression() {
    // regression only: already denied by the memories mention check, not by new code
    for cmd in ["rg --pre=sh pat memories/", "rg --pre sh pat memories/"] {
        assert_eq!(eval(cmd), Some(Decision::Deny), "expected deny for: {cmd}");
    }
}

#[test]
fn mongo_guard_rg_pre_asks_in_readonly() {
    for cmd in ["rg --pre=sh mongosh x", "rg --pre sh mongosh x"] {
        assert_eq!(eval(cmd), Some(Decision::Ask), "expected ask for: {cmd}");
    }
    for cmd in ["ag --pager=sh mongosh x", "man -P sh mongosh", "man --pager=mongosh ls"] {
        assert_eq!(eval(cmd), Some(Decision::Ask), "expected ask for: {cmd}");
    }
    assert_eq!(eval("rg mongosh README.md"), None);
}
