use serde_json::{json, Value};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

fn bin_path() -> &'static str {
    env!("CARGO_BIN_EXE_harness-rs")
}

struct TempDir(PathBuf);

impl TempDir {
    fn new(prefix: &str) -> Self {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let dir = std::env::temp_dir().join(format!("{prefix}-{}-{nanos}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("create temp dir");
        Self(dir)
    }

    fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn run_harness(args: &[&str], stdin_bytes: &[u8], audit_dir: &Path) -> std::process::Output {
    let mut child = Command::new(bin_path())
        .args(args)
        .env("CLAUDE_AUDIT_DIR", audit_dir)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn harness");
    if let Some(mut stdin) = child.stdin.take() {
        let _ = stdin.write_all(stdin_bytes);
    }
    child.wait_with_output().expect("wait harness")
}

#[test]
fn binary_replays_all_11_fixtures_with_layered_hub_rules() {
    let ws = TempDir::new("harness-e2e-ws");
    let audit = TempDir::new("harness-e2e-audit");
    fs::create_dir_all(ws.path().join(".harness")).unwrap();
    fs::create_dir_all(ws.path().join("config/hub")).unwrap();
    fs::write(ws.path().join("config/hub/default.json"), "{}").unwrap();
    fs::write(
        ws.path().join(".harness/rules.toml"),
        include_str!("fixtures/hub-rules.toml"),
    )
    .unwrap();

    let ws_str = ws.path().to_string_lossy().to_string();
    let fixture_dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("../fixtures");
    if fixture_dir.is_dir() {
        let mut files: Vec<PathBuf> = fs::read_dir(&fixture_dir)
            .unwrap()
            .flatten()
            .map(|e| e.path())
            .filter(|p| p.extension().and_then(|e| e.to_str()) == Some("json"))
            .collect();
        files.sort();
        assert_eq!(files.len(), 11, "expected 11 golden fixtures on disk");

        for path in files {
            let name = path.file_name().unwrap().to_string_lossy().to_string();
            let raw = fs::read_to_string(&path).unwrap();
            let fx: Value = serde_json::from_str(&raw).unwrap();
            let host = fx["host"].as_str().unwrap();
            let event = fx["event"].as_str().unwrap();
            let mut inp = fx["input"].clone();
            if let Some(obj) = inp.as_object_mut() {
                if obj.contains_key("cwd") {
                    obj.insert("cwd".to_string(), Value::String(ws_str.clone()));
                }
                if obj.contains_key("workspacePaths") {
                    obj.insert(
                        "workspacePaths".to_string(),
                        Value::Array(vec![Value::String(ws_str.clone())]),
                    );
                }
                if let Some(args) = obj
                    .get_mut("toolCall")
                    .and_then(|tc| tc.get_mut("args"))
                    .and_then(Value::as_object_mut)
                {
                    if args.contains_key("Cwd") {
                        args.insert("Cwd".to_string(), Value::String(ws_str.clone()));
                    }
                }
            }
            let out = run_harness(
                &["hook", "--host", host, event],
                inp.to_string().as_bytes(),
                audit.path(),
            );
            assert_eq!(
                out.status.code(),
                Some(fx["expected"]["exit_code"].as_i64().unwrap() as i32),
                "{name} stderr={}",
                String::from_utf8_lossy(&out.stderr)
            );
            let stdout = String::from_utf8_lossy(&out.stdout);
            let parsed: Value = serde_json::from_str(stdout.trim())
                .unwrap_or_else(|e| panic!("{name}: invalid stdout json '{stdout}': {e}"));
            assert_eq!(parsed, fx["expected"]["stdout_json"], "{name}");
        }
    } else {
        panic!("fixtures dir missing: {}", fixture_dir.display());
    }

    // Verify audit JSONL files were written on disk
    let date = chrono::Utc::now().format("%Y-%m-%d").to_string();
    let tool_dir = audit.path().join(format!("date={date}")).join("type=tool");
    let gate_dir = audit.path().join(format!("date={date}")).join("type=gate");
    assert!(tool_dir.is_dir(), "expected audit tool dir");
    assert!(gate_dir.is_dir(), "expected audit gate dir");
}

#[test]
fn binary_hook_fail_open_and_claude_enrichments() {
    let audit = TempDir::new("harness-failopen-audit");

    // Bad JSON on agy PreToolUse MUST emit {"decision":"allow"}, NEVER {}
    let out = run_harness(&["hook", "--host", "agy", "PreToolUse"], b"{not-json", audit.path());
    assert_eq!(out.status.code(), Some(0));
    assert_eq!(String::from_utf8_lossy(&out.stdout).trim(), r#"{"decision":"allow"}"#);

    // Oversize (>1MB) on agy PreToolUse MUST fail-open with allow
    let big = vec![b'x'; 1_048_600];
    let out_big = run_harness(&["hook", "--host", "agy", "PreToolUse"], &big, audit.path());
    assert_eq!(out_big.status.code(), Some(0));
    assert_eq!(String::from_utf8_lossy(&out_big.stdout).trim(), r#"{"decision":"allow"}"#);

    // Empty stdin on agy PostToolUse -> {}
    let out_post = run_harness(&["hook", "--host", "agy", "PostToolUse"], b"", audit.path());
    assert_eq!(out_post.status.code(), Some(0));
    assert_eq!(String::from_utf8_lossy(&out_post.stdout).trim(), "{}");

    // Bad JSON on claude PreToolUse -> {}
    let out_c = run_harness(&["hook", "--host", "claude", "PreToolUse"], b"", audit.path());
    assert_eq!(out_c.status.code(), Some(0));
    assert_eq!(String::from_utf8_lossy(&out_c.stdout).trim(), "{}");

    // WorktreeCreate missing name -> exit 1
    let out_wt = run_harness(
        &["hook", "--host", "claude", "WorktreeCreate"],
        b"{}",
        audit.path(),
    );
    assert_eq!(out_wt.status.code(), Some(1));

    // Claude Bash without timeout gets updatedInput.timeout = 120000
    let bash_in = json!({
        "hook_event_name": "PreToolUse",
        "session_id": "s1",
        "cwd": "/tmp",
        "tool_name": "Bash",
        "tool_input": { "command": "ls -la" }
    });
    let out_bash = run_harness(
        &["hook", "--host", "claude", "PreToolUse"],
        bash_in.to_string().as_bytes(),
        audit.path(),
    );
    assert_eq!(out_bash.status.code(), Some(0));
    let v: Value = serde_json::from_slice(&out_bash.stdout).unwrap();
    assert_eq!(v["hookSpecificOutput"]["updatedInput"]["timeout"], json!(120000));

    // Claude Bash with secret in command gets masked in audit JSONL
    let sec_in = json!({
        "hook_event_name": "PostToolUse",
        "session_id": "s-secret",
        "cwd": "/tmp",
        "tool_name": "Bash",
        "tool_input": { "command": "curl -H 'Authorization: Bearer sk-1234567890abcdef' https://example.com?token=mysecret" },
        "tool_response": { "stdout": "ok" }
    });
    let out_sec = run_harness(
        &["hook", "--host", "claude", "PostToolUse"],
        sec_in.to_string().as_bytes(),
        audit.path(),
    );
    assert_eq!(out_sec.status.code(), Some(0));
    let date = chrono::Utc::now().format("%Y-%m-%d").to_string();
    let log_file = audit
        .path()
        .join(format!("date={date}/type=tool/claude-s-secret.jsonl"));
    let log_txt = fs::read_to_string(log_file).unwrap();
    assert!(!log_txt.contains("sk-1234567890abcdef"));
    assert!(!log_txt.contains("mysecret"));
}

#[test]
fn binary_mcp_stdio_protocol_and_cli_commands() {
    let ws = TempDir::new("harness-mcp-ws");
    let audit = TempDir::new("harness-mcp-audit");
    let ws_str = ws.path().to_string_lossy().to_string();

    let reqs = [
        json!({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": "2024-11-05"}}),
        json!({"jsonrpc": "2.0", "method": "notifications/initialized"}),
        json!({"jsonrpc": "2.0", "id": 2, "method": "ping"}),
        json!({"jsonrpc": "2.0", "id": 3, "method": "tools/list"}),
        json!({"jsonrpc": "2.0", "id": 4, "method": "tools/call", "params": {"name": "harness_doctor", "arguments": {"cwd": ws_str}}}),
        json!({"jsonrpc": "2.0", "id": 5, "method": "tools/call", "params": {"name": "harness_policy", "arguments": {"cwd": ws_str}}}),
        json!({"jsonrpc": "2.0", "id": 6, "method": "tools/call", "params": {"name": "harness_data", "arguments": {"action": "ls", "cwd": ws_str}}}),
        json!({"jsonrpc": "2.0", "id": 7, "method": "tools/call", "params": {"name": "harness_observe", "arguments": {"by": "tool", "since": "7d", "cwd": ws_str}}}),
    ];
    let stdin_data = reqs.iter().map(|v| v.to_string()).collect::<Vec<_>>().join("\n") + "\n";
    let out = run_harness(&["mcp"], stdin_data.as_bytes(), audit.path());
    assert_eq!(out.status.code(), Some(0));

    let lines: Vec<Value> = String::from_utf8_lossy(&out.stdout)
        .lines()
        .map(|l| serde_json::from_str(l).expect("valid jsonrpc line"))
        .collect();
    // 7 requests with ids (notification produces 0 responses)
    assert_eq!(lines.len(), 7);
    assert_eq!(lines[0]["id"], json!(1));
    assert_eq!(lines[1]["id"], json!(2));
    assert_eq!(lines[2]["id"], json!(3));
    let tools = lines[2]["result"]["tools"].as_array().unwrap();
    assert_eq!(tools.len(), 4);
    for line in &lines[3..7] {
        assert_eq!(line["result"]["isError"], json!(false), "{line:?}");
    }

    // CLI doctor
    let doc_out = run_harness(&["doctor", "--json", "--cwd", &ws_str], b"", audit.path());
    assert_eq!(doc_out.status.code(), Some(0));
    let doc_json: Value = serde_json::from_slice(&doc_out.stdout).unwrap();
    assert_eq!(doc_json["ok"], json!(true));

}

#[test]
fn binary_agy_separates_workspace_cwd_and_tool_cwd() {
    let ws = TempDir::new("harness-agy-cwd-ws");
    let audit = TempDir::new("harness-agy-cwd-audit");
    fs::create_dir_all(ws.path().join(".harness")).unwrap();
    fs::create_dir_all(ws.path().join("config/hub")).unwrap();
    fs::create_dir_all(ws.path().join("memories")).unwrap();
    fs::write(ws.path().join("config/hub/default.json"), "{}").unwrap();
    fs::write(
        ws.path().join(".harness/rules.toml"),
        include_str!("fixtures/hub-rules.toml"),
    )
    .unwrap();

    let ws_str = ws.path().to_string_lossy().to_string();
    let mem_rel = ["entities", "agent", "scout", "profile.yaml"].join("/");
    let mem_full = ["memories", "entities", "agent", "scout", "profile.yaml"].join("/");
    let fake_home = TempDir::new("harness-fake-home");
    let home = fake_home.path().to_string_lossy().to_string();

    // 1. Cwd = HOME while workspacePaths = [hub] -> agy MUST remain enabled & hub rules active!
    let p_home = json!({
        "conversationId": "agy-home-cwd",
        "workspacePaths": [ws_str],
        "toolCall": {
            "name": "run_command",
            "args": { "CommandLine": format!("cat {mem_full}"), "Cwd": home }
        }
    });
    let out_home = run_harness(
        &["hook", "--host", "agy", "PreToolUse"],
        p_home.to_string().as_bytes(),
        audit.path(),
    );
    let v_home: Value = serde_json::from_slice(&out_home.stdout).unwrap();
    assert_eq!(v_home["decision"], json!("deny"), "Cwd=HOME must not disable agy: {v_home}");

    // 1b. Explicit fake HOME with Cwd = that HOME
    let p_net_home = json!({
        "conversationId": "agy-user-home",
        "workspacePaths": [ws_str],
        "toolCall": {
            "name": "run_command",
            "args": { "CommandLine": format!("cat {mem_full}"), "Cwd": home }
        }
    });
    let mut cmd_home = Command::new(bin_path());
    cmd_home
        .args(["hook", "--host", "agy", "PreToolUse"])
        .env("HOME", &home)
        .env("CLAUDE_AUDIT_DIR", audit.path())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child_home = cmd_home.spawn().unwrap();
    child_home
        .stdin
        .take()
        .unwrap()
        .write_all(p_net_home.to_string().as_bytes())
        .unwrap();
    let out_net_home = child_home.wait_with_output().unwrap();
    let v_net_home: Value = serde_json::from_slice(&out_net_home.stdout).unwrap();
    assert_eq!(v_net_home["decision"], json!("deny"), "fake HOME + Cwd=HOME must not disable agy: {v_net_home}");

    // 2. Cwd = /tmp while workspacePaths = [hub] -> hub rules still loaded!
    let p_tmp = json!({
        "conversationId": "agy-tmp-cwd",
        "workspacePaths": [ws_str],
        "toolCall": {
            "name": "run_command",
            "args": { "CommandLine": format!("cat {mem_full}"), "Cwd": "/tmp" }
        }
    });
    let out_tmp = run_harness(
        &["hook", "--host", "agy", "PreToolUse"],
        p_tmp.to_string().as_bytes(),
        audit.path(),
    );
    let v_tmp: Value = serde_json::from_slice(&out_tmp.stdout).unwrap();
    assert_eq!(v_tmp["decision"], json!("deny"), "Cwd=/tmp must still load hub rules: {v_tmp}");

    // 3. Cwd = <ws>/memories & CommandLine = "cat entities/..." -> DENIED!
    let mem_cwd = ws.path().join("memories").to_string_lossy().to_string();
    let p_sub = json!({
        "conversationId": "agy-sub-cwd",
        "workspacePaths": [ws_str],
        "toolCall": {
            "name": "run_command",
            "args": { "CommandLine": format!("cat {mem_rel}"), "Cwd": mem_cwd }
        }
    });
    let out_sub = run_harness(
        &["hook", "--host", "agy", "PreToolUse"],
        p_sub.to_string().as_bytes(),
        audit.path(),
    );
    let v_sub: Value = serde_json::from_slice(&out_sub.stdout).unwrap();
    assert_eq!(v_sub["decision"], json!("deny"), "Cwd=<ws>/memories + cat entities/... must deny: {v_sub}");

    // 4. workspacePaths pointing to subdir (<ws>/memories) walks up to repo root (<ws>)
    let p_ws_sub = json!({
        "conversationId": "agy-ws-subdir",
        "workspacePaths": [mem_cwd],
        "toolCall": {
            "name": "run_command",
            "args": { "CommandLine": format!("cat {mem_full}"), "Cwd": "/tmp" }
        }
    });
    let out_ws_sub = run_harness(
        &["hook", "--host", "agy", "PreToolUse"],
        p_ws_sub.to_string().as_bytes(),
        audit.path(),
    );
    let v_ws_sub: Value = serde_json::from_slice(&out_ws_sub.stdout).unwrap();
    assert_eq!(v_ws_sub["decision"], json!("deny"), "subdir workspacePaths must walk up to hub root: {v_ws_sub}");
}

// ---------------------------------------------------------------------------
// Plugin-level e2e: real binary, real hooks.json commands, real MCP stdio.
// ---------------------------------------------------------------------------

fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../..")
}

/// Temp workspace whose `.harness/rules.toml` is the hub rules fixture.
fn hub_ws(prefix: &str) -> TempDir {
    let ws = TempDir::new(prefix);
    fs::create_dir_all(ws.path().join(".harness")).unwrap();
    fs::write(
        ws.path().join(".harness/rules.toml"),
        include_str!("fixtures/hub-rules.toml"),
    )
    .unwrap();
    ws
}

/// Plugin dir with `bin/harness-rs` = copy of the real test binary.
fn plugin_dir_with_bin(prefix: &str) -> TempDir {
    let dir = TempDir::new(prefix);
    fs::create_dir_all(dir.path().join("bin")).unwrap();
    let dst = dir.path().join("bin/harness-rs");
    fs::copy(bin_path(), &dst).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&dst, fs::Permissions::from_mode(0o755)).unwrap();
    }
    dir
}

/// Command of the first hook registered for `event` in plugins/claude/hooks/hooks.json.
fn claude_hook_command(event: &str) -> String {
    let raw = fs::read_to_string(repo_root().join("plugins/claude/hooks/hooks.json")).unwrap();
    let v: Value = serde_json::from_str(&raw).unwrap();
    v["hooks"][event][0]["hooks"][0]["command"]
        .as_str()
        .unwrap_or_else(|| panic!("no command for {event}"))
        .to_string()
}

/// Run `sh -c <command>` (the way Claude Code does) with `CLAUDE_PLUGIN_ROOT` substituted.
fn run_sh_hook(command: &str, plugin_root: &Path, stdin_bytes: &[u8], audit: &Path, cwd: &Path) -> std::process::Output {
    let cmd = command.replace("${CLAUDE_PLUGIN_ROOT}", &plugin_root.to_string_lossy());
    let mut child = Command::new("sh")
        .arg("-c")
        .arg(&cmd)
        .current_dir(cwd)
        .env("CLAUDE_AUDIT_DIR", audit)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn sh");
    if let Some(mut stdin) = child.stdin.take() {
        let _ = stdin.write_all(stdin_bytes);
    }
    child.wait_with_output().expect("wait sh")
}

#[test]
fn e2e_permission_request() {
    let ws = hub_ws("harness-perm-ws");
    let audit = TempDir::new("harness-perm-audit");
    let inp = json!({
        "hook_event_name": "PermissionRequest",
        "session_id": "perm-1",
        "cwd": ws.path().to_string_lossy(),
        "tool_name": "Bash",
        "tool_input": { "command": "ls" }
    });
    let out = run_harness(
        &["hook", "--host", "claude", "PermissionRequest"],
        inp.to_string().as_bytes(),
        audit.path(),
    );
    assert_eq!(out.status.code(), Some(0), "stderr={}", String::from_utf8_lossy(&out.stderr));
    let v: Value = serde_json::from_slice(&out.stdout).expect("stdout is JSON");
    // PermissionRequest is audit-only: it must not decide on the user's behalf.
    assert_eq!(v, json!({}), "PermissionRequest must be a no-op: {v}");
    let date = chrono::Utc::now().format("%Y-%m-%d").to_string();
    assert!(
        audit.path().join(format!("date={date}")).join("type=permission").is_dir(),
        "PermissionRequest must be audited under type=permission"
    );
}

#[test]
fn e2e_stop_block() {
    // The harness does NOT support blocking Stop (no `decision:"block"`): Stop is audit-only.
    // Even with stop_hook_active=false and a transcript-less payload it must emit `{}` + exit 0.
    let ws = hub_ws("harness-stop-ws");
    let audit = TempDir::new("harness-stop-audit");
    for active in [false, true] {
        let inp = json!({
            "hook_event_name": "Stop",
            "session_id": "stop-1",
            "cwd": ws.path().to_string_lossy(),
            "stop_hook_active": active
        });
        let out = run_harness(
            &["hook", "--host", "claude", "Stop"],
            inp.to_string().as_bytes(),
            audit.path(),
        );
        assert_eq!(out.status.code(), Some(0));
        assert_eq!(String::from_utf8_lossy(&out.stdout).trim(), "{}", "Stop never blocks");
    }
}

#[test]
fn e2e_plugin_root_command() {
    let ws = hub_ws("harness-plugroot-ws");
    let audit = TempDir::new("harness-plugroot-audit");
    let plugin = plugin_dir_with_bin("harness-plugroot-plugin");
    let cmd = claude_hook_command("PreToolUse");
    assert!(cmd.starts_with("${CLAUDE_PLUGIN_ROOT}/bin/harness-rs "), "{cmd}");
    let cwd = ws.path().to_string_lossy().to_string();

    let deny_env = json!({
        "hook_event_name": "PreToolUse", "session_id": "pr-1", "cwd": cwd,
        "tool_name": "Read", "tool_input": { "file_path": format!("{cwd}/.env") }
    });
    let out = run_sh_hook(&cmd, plugin.path(), deny_env.to_string().as_bytes(), audit.path(), ws.path());
    assert_eq!(out.status.code(), Some(0), "stderr={}", String::from_utf8_lossy(&out.stderr));
    let v: Value = serde_json::from_slice(&out.stdout).unwrap();
    assert_eq!(v["hookSpecificOutput"]["permissionDecision"], json!("deny"), "{v}");

    let ask_mongo = json!({
        "hook_event_name": "PreToolUse", "session_id": "pr-2", "cwd": cwd,
        "tool_name": "Bash", "tool_input": { "command": "mongosh --port 27018" }
    });
    let out = run_sh_hook(&cmd, plugin.path(), ask_mongo.to_string().as_bytes(), audit.path(), ws.path());
    assert_eq!(out.status.code(), Some(0));
    let v: Value = serde_json::from_slice(&out.stdout).unwrap();
    assert_eq!(v["hookSpecificOutput"]["permissionDecision"], json!("ask"), "{v}");
}

#[test]
fn e2e_agy_relative_bin() {
    // agy hooks.json uses `./bin/harness-rs`: it resolves against the plugin dir used as cwd.
    let raw = fs::read_to_string(repo_root().join("plugins/agy/hooks.json")).unwrap();
    assert!(raw.contains("./bin/harness-rs hook --host agy PreToolUse"));
    let ws = hub_ws("harness-agyrel-ws");
    let audit = TempDir::new("harness-agyrel-audit");
    let plugin = plugin_dir_with_bin("harness-agyrel-plugin");
    let ws_str = ws.path().to_string_lossy().to_string();
    let inp = json!({
        "conversationId": "agy-rel",
        "workspacePaths": [ws_str],
        "toolCall": { "name": "write_file", "args": { "Path": format!("{ws_str}/.env") } }
    });
    let out = run_sh_hook(
        "./bin/harness-rs hook --host agy PreToolUse",
        plugin.path(),
        inp.to_string().as_bytes(),
        audit.path(),
        plugin.path(),
    );
    assert_eq!(out.status.code(), Some(0), "stderr={}", String::from_utf8_lossy(&out.stderr));
    let v: Value = serde_json::from_slice(&out.stdout).unwrap();
    assert_eq!(v["decision"], json!("deny"), "{v}");
}

#[test]
fn e2e_mcp_tools_list() {
    let audit = TempDir::new("harness-mcplist-audit");
    let reqs = [
        json!({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": "2024-11-05"}}),
        json!({"jsonrpc": "2.0", "method": "notifications/initialized"}),
        json!({"jsonrpc": "2.0", "id": 2, "method": "tools/list"}),
    ];
    let stdin_data = reqs.iter().map(|v| v.to_string()).collect::<Vec<_>>().join("\n") + "\n";
    let out = run_harness(&["mcp"], stdin_data.as_bytes(), audit.path());
    assert_eq!(out.status.code(), Some(0));
    let lines: Vec<Value> = String::from_utf8_lossy(&out.stdout)
        .lines()
        .map(|l| serde_json::from_str(l).expect("jsonrpc line"))
        .collect();
    assert_eq!(lines.len(), 2);
    assert_eq!(lines[0]["id"], json!(1));
    let mut names: Vec<String> = lines[1]["result"]["tools"]
        .as_array()
        .unwrap()
        .iter()
        .map(|t| t["name"].as_str().unwrap().to_string())
        .collect();
    names.sort();
    assert_eq!(names, ["harness_data", "harness_doctor", "harness_observe", "harness_policy"]);
}

#[test]
fn e2e_missing_binary() {
    // Documentation test: when bin/harness-rs is missing, sh exits 127. Claude Code treats any
    // exit code other than 0/2 as a NON-blocking error, so the guards silently stop protecting
    // (fail-open). `harness doctor` / check-binary.sh are the only detection.
    let ws = hub_ws("harness-missing-ws");
    let audit = TempDir::new("harness-missing-audit");
    let empty_plugin = TempDir::new("harness-missing-plugin"); // no bin/
    let cmd = claude_hook_command("PreToolUse");
    let cwd = ws.path().to_string_lossy().to_string();
    let inp = json!({
        "hook_event_name": "PreToolUse", "session_id": "miss-1", "cwd": cwd,
        "tool_name": "Read", "tool_input": { "file_path": format!("{cwd}/.env") }
    });
    let out = run_sh_hook(&cmd, empty_plugin.path(), inp.to_string().as_bytes(), audit.path(), ws.path());
    assert_eq!(out.status.code(), Some(127));
    assert!(out.stdout.is_empty(), "no decision JSON when binary is missing");
}
