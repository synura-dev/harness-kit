use super::*;
use crate::host::parse_stdin;

const WS: &str = "/work/ws";

fn eval(host: Host, tool: &str, args: serde_json::Value) -> Option<Decision> {
    let payload = match host {
        Host::Claude => serde_json::json!({"hook_event_name": "PreToolUse", "session_id": "t",
            "cwd": WS, "tool_name": tool, "tool_input": args}),
        Host::Agy => serde_json::json!({"conversationId": "t", "workspacePaths": [WS],
            "toolCall": {"name": tool, "args": args}}),
    };
    let input = parse_stdin(host, Some("PreToolUse"), payload.to_string().as_bytes()).expect("parse");
    let paths = WorkspacePaths {
        workspace: PathBuf::from(WS),
        data_dir: PathBuf::from("/tmp/data"),
        audit_root: PathBuf::from("/tmp/harness-test-audit"),
        has_workspace_marker: false,
        is_plugin_mode: false,
    };
    let eng = RulesEngine::empty();
    eng.evaluate(&input, &paths).decision
}

fn bash(host: Host, cmd: &str) -> Option<Decision> {
    match host {
        Host::Claude => eval(host, "Bash", serde_json::json!({"command": cmd})),
        Host::Agy => eval(host, "run_command", serde_json::json!({"CommandLine": cmd})),
    }
}

#[test]
fn secret_files_denied_for_file_tools() {
    for tool in ["Read", "Write", "Edit", "MultiEdit", "NotebookEdit"] {
        for p in [
            ".env", "/a/b/.env.local", "k/server.pem", "x.key", "a.p12", "a.pfx", "/h/.ssh/id_rsa",
            "id_ed25519", "id_ecdsa_x", "credentials.json", ".npmrc", ".netrc", ".pgpass",
            "secrets.yaml", "C:\\a\\.env",
        ] {
            assert_eq!(eval(Host::Claude, tool, serde_json::json!({"file_path": p})), Some(Decision::Deny), "{tool} {p}");
        }
    }
    assert_eq!(eval(Host::Agy, "view_file", serde_json::json!({"Path": "/w/.env"})), Some(Decision::Deny));
    assert_eq!(eval(Host::Agy, "write_file", serde_json::json!({"Path": "/w/a.pem"})), Some(Decision::Deny));
    assert_eq!(eval(Host::Agy, "replace_file_content", serde_json::json!({"TargetFile": ".env"})), Some(Decision::Deny));
    assert_eq!(eval(Host::Claude, "Grep", serde_json::json!({"path": "/w/.env", "pattern": "x"})), Some(Decision::Deny));
    assert_eq!(eval(Host::Claude, "Grep", serde_json::json!({"path": "/tmp", "glob": ".env*", "pattern": "x"})), Some(Decision::Deny));
    assert_eq!(eval(Host::Claude, "Glob", serde_json::json!({"path": "/w/id_rsa", "pattern": "*"})), Some(Decision::Deny));
}

#[test]
fn secret_files_allow_examples_dirs_and_normal_files() {
    for p in [".env.example", ".env.sample", ".env.template", "id_rsa.pub", "README.md", "src/keys.rs", "a/envfile"] {
        assert_eq!(eval(Host::Claude, "Read", serde_json::json!({"file_path": p})), None, "{p}");
    }
    assert_eq!(eval(Host::Claude, "Grep", serde_json::json!({"path": "/tmp", "pattern": "x"})), None);
    assert_eq!(eval(Host::Claude, "Glob", serde_json::json!({"path": "/tmp", "pattern": "*.rs"})), None);
}

#[test]
fn rm_recursive_outside_asks_claude_denies_agy() {
    for cmd in [
        "rm -rf /", "rm -rf ~", "rm -rf $HOME", "rm -rf \"$HOME/x\"", "rm -rf ..", "rm -fr ../x",
        "rm -r -f /tmp/x", "rm --recursive --force /var", "rm -Rf *", "rm -rf ./*", "rm -rf .",
        "sudo rm -rf /", "bash -c 'rm -rf /'", "bash -lc \"rm -rf ~\"", "ls && rm -rf /etc",
        "echo $(rm -rf /)", "rm -rf -- /x", "rm -rf /work/ws/../other", "rm -rf '/'",
    ] {
        assert_eq!(bash(Host::Claude, cmd), Some(Decision::Ask), "{cmd}");
        assert_eq!(bash(Host::Agy, cmd), Some(Decision::Deny), "{cmd}");
    }
}

#[test]
fn rm_inside_workspace_or_non_recursive_allowed() {
    for cmd in [
        "rm -rf target/", "rm -rf .worktrees/x", "rm -rf ./target", "rm -rf /work/ws/target",
        "rm -rf target/*", "rm -r /", "rm -f /x", "rm file.txt", "cat README.md", "ls -rf /",
        "rm -rf a/../target",
    ] {
        assert_eq!(bash(Host::Claude, cmd), None, "{cmd}");
    }
}

#[test]
fn git_force_push_asks_claude_denies_agy() {
    for cmd in [
        "git push --force", "git push -f origin main", "git push --force-with-lease",
        "git push origin +main", "git push --mirror", "git push --delete origin x",
        "git push origin :old", "git -C /w push -f", "git push origin HEAD:+main",
        "git push -fu origin x", "bash -c 'git push --force'", "git push --forc",
    ] {
        assert_eq!(bash(Host::Claude, cmd), Some(Decision::Ask), "{cmd}");
        assert_eq!(bash(Host::Agy, cmd), Some(Decision::Deny), "{cmd}");
    }
    for cmd in ["git push origin main", "git push -u origin feat", "git push", "git status", "git log -f"] {
        assert_eq!(bash(Host::Claude, cmd), None, "{cmd}");
    }
}

#[test]
fn git_tracks_rules_exact_entry_only() {
    let dir = std::env::temp_dir().join(format!("harness-t6b-{}", std::process::id()));
    let git = dir.join(".git");
    std::fs::create_dir_all(&git).unwrap();
    let idx = |body: &[u8], ver: u8| {
        let mut v = b"DIRC\0\0\0".to_vec();
        v.push(ver);
        v.extend_from_slice(body);
        std::fs::write(git.join("index"), v).unwrap();
    };
    idx(b"\0\0\0\x13.harness/rules.toml\0pad", 2);
    assert!(load::git_tracks_rules(&dir));
    idx(b"\0\0\0\x1fx/.harness/rules.toml\0pad", 2);
    assert!(!load::git_tracks_rules(&dir));
    idx(b"\0\0\0\x1b.harness/rules.toml.example\0", 2);
    assert!(!load::git_tracks_rules(&dir));
    idx(b"\0\0\0\x13.harness/rules.toml\0pad", 4);
    assert!(!load::git_tracks_rules(&dir));
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn r1_secrets_prefix_only_for_data_extensions() {
    for p in ["secrets.md", "secrets.rs", "secrets.ts", "secrets.py"] {
        assert_eq!(eval(Host::Claude, "Read", serde_json::json!({"file_path": p})), None, "{p}");
    }
    for p in ["secrets.json", "secrets.yml", "secrets.yaml", "secrets.env", "secrets.toml", "secrets.ini"] {
        assert_eq!(eval(Host::Claude, "Read", serde_json::json!({"file_path": p})), Some(Decision::Deny), "{p}");
    }
}

#[test]
fn r1_grep_glob_may_match_secret() {
    for g in ["{.env,x}", "*.env", ".e*", "*.pem", "**/id_*", "*credential*", "*secret*", "*.KEY", "*npmrc"] {
        let a = serde_json::json!({"path": "/tmp", "glob": g, "pattern": "x"});
        assert_eq!(eval(Host::Claude, "Grep", a), Some(Decision::Deny), "{g}");
    }
    for g in ["*.rs", "**/*.md", "*.env.example", "src/**/*.ts"] {
        let a = serde_json::json!({"path": "/tmp", "glob": g, "pattern": "x"});
        assert_eq!(eval(Host::Claude, "Grep", a), None, "{g}");
    }
}

#[test]
fn r1_symlink_to_secret_denied() {
    let dir = std::env::temp_dir().join(format!("harness-t6b-sym-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join(".env"), "x").unwrap();
    let link = dir.join("notes.txt");
    std::os::unix::fs::symlink(dir.join(".env"), &link).unwrap();
    let r = eval(Host::Claude, "Read", serde_json::json!({"file_path": link.to_string_lossy()}));
    std::fs::remove_dir_all(&dir).ok();
    assert_eq!(r, Some(Decision::Deny));
}

#[test]
fn r1_rm_after_cd_not_provable() {
    for cmd in ["cd /tmp && rm -rf foo", "cd .. && rm -rf x", "pushd /var; rm -rf x", "cd && rm -rf x", "cd $D && rm -rf x", "cd a/../.. && rm -rf x"] {
        assert_eq!(bash(Host::Claude, cmd), Some(Decision::Ask), "{cmd}");
    }
    for cmd in ["cd src && rm -rf build", "cd /work/ws/sub && rm -rf out", "cd target && rm -rf ."] {
        assert_eq!(bash(Host::Claude, cmd), None, "{cmd}");
    }
}

#[test]
fn r1_low_items() {
    assert_eq!(bash(Host::Claude, "rm --recur --forc /x"), Some(Decision::Ask));
    assert_eq!(bash(Host::Claude, "rm --rec --fo /x"), Some(Decision::Ask));
    assert!(!is_sensitive_basename("app.example.cfg", &["app.example.cfg".to_string()]));
    assert!(!is_sensitive_basename("my.sample.json", &["my.sample.json".to_string()]));
    assert!(is_sensitive_basename("my.cfg", &["my.cfg".to_string()]));
    assert_eq!(
        eval(Host::Agy, "view_file_outline", serde_json::json!({"Path": "/w/.env"})),
        Some(Decision::Deny)
    );
}
