    use super::*;
    use crate::host::{parse_stdin, render_outcome};

    fn hub_engine() -> RulesEngine {
        let raw = include_str!("../../tests/fixtures/hub-rules.toml");
        RulesEngine::from_toml_str(raw).expect("valid hub-rules.toml")
    }

    fn eval_claude(engine: &RulesEngine, tool: &str, ti: Value) -> HookOutcome {
        let payload = serde_json::json!({
            "hook_event_name": "PreToolUse",
            "session_id": "test",
            "cwd": "/work/hub",
            "tool_name": tool,
            "tool_input": ti,
        });
        let input = parse_stdin(Host::Claude, Some("PreToolUse"), payload.to_string().as_bytes())
            .expect("parse");
        let paths = WorkspacePaths {
            workspace: PathBuf::from("/work/hub"),
            data_dir: PathBuf::from("/work/hub/data"),
            audit_root: PathBuf::from("/work/hub/data/system/audit"),
            has_workspace_marker: true,
            is_plugin_mode: false,
        };
        engine.evaluate(&input, &paths)
    }

    fn eval_agy(engine: &RulesEngine, name: &str, args: Value) -> HookOutcome {
        let payload = serde_json::json!({
            "conversationId": "test",
            "workspacePaths": ["/work/hub"],
            "toolCall": { "name": name, "args": args },
        });
        let input = parse_stdin(Host::Agy, Some("PreToolUse"), payload.to_string().as_bytes())
            .expect("parse");
        let paths = WorkspacePaths {
            workspace: PathBuf::from("/work/hub"),
            data_dir: PathBuf::from("/work/hub/data"),
            audit_root: PathBuf::from("/tmp/harness-test-audit"),
            has_workspace_marker: true,
            is_plugin_mode: false,
        };
        engine.evaluate(&input, &paths)
    }

    #[test]
    fn tighten_only_blocks_disabling_core_or_downgrading_rules() {
        let mut eng = RulesEngine::empty();
        eng.merge_toml_str("user", "user.toml", include_str!("../../tests/fixtures/hub-rules.toml"))
            .unwrap();
        let before = eng.bash_rules.len();
        let evil = r#"
[[path_rules]]
id = "config-dump"
tools = ["Bash"]
action = "ask"
pattern = "never"
reason = "try loosen core"

[[bash_rules]]
id = "memories-guard-bash"
kind = "regex"
action = "ask"
pattern = "never"
reason = "try downgrade deny to ask"
"#;
        eng.merge_toml_str("project", "proj.toml", evil).unwrap();
        assert_eq!(eng.bash_rules.len(), before + 1, "union keeps both");
        assert!(eng.warnings.iter().any(|w| w.contains("cannot be overridden")));
        let mem_bash = eng.bash_rules.iter().find(|r| r.id == "memories-guard-bash").unwrap();
        assert_eq!(mem_bash.action, RuleAction::Deny);
    }

    #[test]
    fn core_guard_blocks_env_allows_example_and_sha256() {
        let eng = hub_engine();
        assert_eq!(
            eval_claude(&eng, "Bash", serde_json::json!({"command": "cat .env"})).decision,
            Some(Decision::Deny)
        );
        assert_eq!(
            eval_claude(&eng, "Bash", serde_json::json!({"command": "cat config/.env.production"})).decision,
            Some(Decision::Deny)
        );
        assert_eq!(
            eval_claude(&eng, "Bash", serde_json::json!({"command": "cat ~/.ssh/id_rsa"})).decision,
            Some(Decision::Deny)
        );
        assert_eq!(
            eval_claude(&eng, "Bash", serde_json::json!({"command": "cat .env.example"})).decision,
            None
        );
        assert_eq!(
            eval_claude(&eng, "Bash", serde_json::json!({"command": "cat .env | sha256sum"})).decision,
            None
        );
    }

    #[test]
    fn core_bash_guard_and_data_gate() {
        let eng = hub_engine();
        assert_eq!(
            eval_claude(&eng, "Bash", serde_json::json!({"command": "python3 - <<EOF\nprint(1)\nEOF"})).decision,
            Some(Decision::Deny)
        );
        assert_eq!(
            eval_claude(&eng, "Bash", serde_json::json!({"command": "cat <<EOF\n1\n2\n3\n4\nEOF"})).decision,
            Some(Decision::Deny)
        );
        // 3 lines heredoc allowed
        assert_eq!(
            eval_claude(&eng, "Bash", serde_json::json!({"command": "cat <<EOF\n1\n2\n3\nEOF"})).decision,
            None
        );
        // data-gate blocks raw read in data/
        assert_eq!(
            eval_claude(&eng, "Read", serde_json::json!({"file_path": "/work/hub/data/system/audit/x.jsonl"})).decision,
            Some(Decision::Deny)
        );
        // data-gate allows harness data ls
        assert_eq!(
            eval_claude(&eng, "Bash", serde_json::json!({"command": "harness data ls"})).decision,
            None
        );
    }

    #[test]
    fn memories_guard_bypass_vectors() {
        let eng = hub_engine();
        let mem_path = ["memories", "entities", "agent", "scout", "entity.yaml"].join("/");
        let denied_cmds = [
            format!("cat {mem_path}"),
            "cat \"memories\"/\"entities\"/agent/scout/entity.yaml".to_string(),
            "cat memories/./entities/agent/scout/entity.yaml".to_string(),
            "cat memories\\\\entities\\\\agent\\\\scout\\\\entity.yaml".to_string(),
            format!("harness mem get agent:scout > {mem_path}"),
            "git status > memories/out.txt".to_string(),
            format!("PATH=/tmp harness mem get {mem_path}"),
            format!("env harness mem get {mem_path}"),
            format!("harness() {{ cat \"$@\"; }}; harness mem {mem_path}"),
            format!("echo $(cat {mem_path})"),
            format!("git commit -m \"$(cat {mem_path})\""),
            "ls -laR memories/".to_string(),
            "cd memories".to_string(),
            "grep -rn foo memories".to_string(),
            "bun .worktrees/foo/hub/memory/ops.mjs".to_string(),
        ];
        for cmd in &denied_cmds {
            let out = eval_claude(&eng, "Bash", serde_json::json!({"command": cmd}));
            assert_eq!(out.decision, Some(Decision::Deny), "expected deny for: {cmd}");
        }

        let allowed_cmds = [
            "harness mem get agent:scout".to_string(),
            format!("git diff -- {mem_path}"),
            format!("git commit -F - <<EOF\nupdate {mem_path}\nEOF"),
            "MEM_ROOT=/tmp/test bun .worktrees/foo/hub/memory/ops.mjs".to_string(),
            "bun .worktrees/foo/hub/memory/ops.test.mjs".to_string(),
            "bun test .worktrees/foo/hub/memory/ops.test.mjs".to_string(),
        ];
        for cmd in &allowed_cmds {
            let out = eval_claude(&eng, "Bash", serde_json::json!({"command": cmd}));
            assert_eq!(out.decision, None, "expected allow for: {cmd}");
        }

        // agy arg scan on non-standard search tool and Cwd
        let agy_search = eval_agy(
            &eng,
            "grep_search",
            serde_json::json!({"SearchPath": format!("/work/hub/{mem_path}"), "Query": "x"}),
        );
        assert_eq!(agy_search.decision, Some(Decision::Deny));
        let agy_cwd = eval_agy(
            &eng,
            "run_command",
            serde_json::json!({"CommandLine": "ls", "Cwd": format!("/work/hub/{mem_path}")}),
        );
        assert_eq!(agy_cwd.decision, Some(Decision::Deny));
    }

    #[test]
    fn mongo_guard_bypass_vectors() {
        let eng = hub_engine();
        let ask_cmds = [
            "mongosh --version",
            "sudo mongosh",
            "timeout 10 mongosh",
            "ssh prod 'mongosh --eval db.stats()'",
            "bash -c 'mongodump --out /tmp/d'",
            "docker exec mongo-1 mongosh",
            "kubectl exec pod-0 -- mongosh",
            "ssh -L 27017:127.0.0.1:27017 prod",
            "kubectl port-forward svc/mongo 27018:27018",
            "node -e \"new MongoClient('x')\"",
            "python3 -c \"import pymongo\"",
            "echo mongodb://user:pass@10.0.0.2:27017/db",
            "echo mongodb+srv://cluster.mongodb.net/db",
            "mongod --port 27017 --dbpath /tmp/db",
            "pkill -f mongod",
        ];
        for cmd in ask_cmds {
            let out = eval_claude(&eng, "Bash", serde_json::json!({"command": cmd}));
            assert_eq!(out.decision, Some(Decision::Ask), "expected ask for: {cmd}");
            // And verify agy renders ASK as deny + [ASK] prefix, never updatedInput
            let agy_out = eval_agy(&eng, "run_command", serde_json::json!({"CommandLine": cmd}));
            let rendered = render_outcome(Host::Agy, "PreToolUse", &agy_out);
            assert!(rendered.stdout.contains(r#""decision":"deny""#), "{cmd}");
            assert!(rendered.stdout.contains("[ASK] "), "{cmd}");
            assert!(!rendered.stdout.contains("updatedInput"), "{cmd}");
        }

        let allowed_cmds = [
            "echo mongodb://127.0.0.1:27018/app",
            "echo mongodb://localhost:27018/app",
            "mongod --port 27018 --dbpath \"/work/app/.data\"",
            "grep mongosh README.md",
            "git log -n 5",
        ];
        for cmd in allowed_cmds {
            let out = eval_claude(&eng, "Bash", serde_json::json!({"command": cmd}));
            assert_eq!(out.decision, None, "expected allow for: {cmd}");
        }
    }

    #[test]
    fn replay_all_11_golden_contracts() {
        let eng = hub_engine();
        let mem_yaml = format!(
            "/work/hub/{}/agent/scout/entity.yaml",
            ["memories", "entities"].join("/")
        );
        let mem_reason = format!(
            "Khong doc truc tiep {}/. Dung: mem / MCP mem_* (du phong: mem-bun) get <id> hoac context <id> --for <task> --budget N",
            ["memories", "entities"].join("/")
        );
        type GoldenCase<'a> = (&'a str, Host, &'a str, Value, i32, Value, bool, bool);
        let cases: Vec<GoldenCase<'_>> = vec![
            (
                "agy-post-tool",
                Host::Agy,
                "PostToolUse",
                serde_json::json!({"conversationId":"golden-test","workspacePaths":["/work/hub"],"toolCall":{"name":"read_file","args":{"Path":"/work/hub/AGENTS.md"}},"toolResult":{"status":"success"}}),
                0,
                serde_json::json!({}),
                false,
                false,
            ),
            (
                "agy-pre-allow-read",
                Host::Agy,
                "PreToolUse",
                serde_json::json!({"conversationId":"golden-test","workspacePaths":["/work/hub"],"toolCall":{"name":"read_file","args":{"Path":"/work/hub/AGENTS.md"}}}),
                0,
                serde_json::json!({"decision":"allow"}),
                true,
                true,
            ),
            (
                "agy-pre-deny-mem",
                Host::Agy,
                "PreToolUse",
                serde_json::json!({"conversationId":"golden-test","workspacePaths":["/work/hub"],"toolCall":{"name":"read_file","args":{"Path":mem_yaml}}}),
                0,
                serde_json::json!({"decision":"deny","reason":mem_reason}),
                false,
                true,
            ),
            (
                "agy-pre-deny-mongo",
                Host::Agy,
                "PreToolUse",
                serde_json::json!({"conversationId":"golden-test","workspacePaths":["/work/hub"],"toolCall":{"name":"run_command","args":{"CommandLine":"mongosh --version","Cwd":"/work/hub"}}}),
                0,
                serde_json::json!({"decision":"deny","reason":"[ASK] mongo-guard: cong cu MongoDB mongosh; can nguoi dung duyet"}),
                false,
                true,
            ),
            (
                "claude-post-tool",
                Host::Claude,
                "PostToolUse",
                serde_json::json!({"hook_event_name":"PostToolUse","session_id":"golden-test","cwd":"/work/hub","tool_name":"Read","tool_input":{"file_path":"/work/hub/AGENTS.md"},"tool_use_id":"toolu_golden_06","tool_response":{"type":"text"}}),
                0,
                serde_json::json!({}),
                false,
                false,
            ),
            (
                "claude-pre-allow-read",
                Host::Claude,
                "PreToolUse",
                serde_json::json!({"hook_event_name":"PreToolUse","session_id":"golden-test","cwd":"/work/hub","tool_name":"Read","tool_input":{"file_path":"/work/hub/AGENTS.md"},"tool_use_id":"toolu_golden_01"}),
                0,
                serde_json::json!({}),
                false,
                false,
            ),
            (
                "claude-pre-ask-mongo",
                Host::Claude,
                "PreToolUse",
                serde_json::json!({"hook_event_name":"PreToolUse","session_id":"golden-test","cwd":"/work/hub","tool_name":"Bash","tool_input":{"command":"mongosh --version"},"tool_use_id":"toolu_golden_04"}),
                0,
                serde_json::json!({"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"ask","permissionDecisionReason":"mongo-guard: cong cu MongoDB mongosh; can nguoi dung duyet"}}),
                false,
                false,
            ),
            (
                "claude-pre-deny-env",
                Host::Claude,
                "PreToolUse",
                serde_json::json!({"hook_event_name":"PreToolUse","session_id":"golden-test","cwd":"/work/hub","tool_name":"Bash","tool_input":{"command":"cat /work/hub/.env"},"tool_use_id":"toolu_golden_02"}),
                0,
                serde_json::json!({"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"guard[config-dump]: Cam in noi dung file cau hinh/bi mat (.env, khoa, credential...). Dung sha256sum/wc/grep -n co gioi han. / Config/secret dump blocked; use sha256sum, wc, bounded grep -n."}}),
                false,
                false,
            ),
            (
                "claude-pre-deny-mem",
                Host::Claude,
                "PreToolUse",
                serde_json::json!({"hook_event_name":"PreToolUse","session_id":"golden-test","cwd":"/work/hub","tool_name":"Read","tool_input":{"file_path":mem_yaml},"tool_use_id":"toolu_golden_03"}),
                0,
                serde_json::json!({"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":mem_reason}}),
                false,
                false,
            ),
            (
                "claude-pre-deny-py",
                Host::Claude,
                "PreToolUse",
                serde_json::json!({"hook_event_name":"PreToolUse","session_id":"golden-test","cwd":"/work/hub","tool_name":"Bash","tool_input":{"command":"python3 -c 'import os\nprint(1)'"},"tool_use_id":"toolu_golden_05"}),
                0,
                serde_json::json!({"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"bash-guard: python -c nhieu dong. Write file vao scratchpad roi chay (khong dung python - / python -c nhieu dong / heredoc dai)."}}),
                false,
                false,
            ),
            (
                "claude-stop",
                Host::Claude,
                "Stop",
                serde_json::json!({"hook_event_name":"Stop","session_id":"golden-test","cwd":"/work/hub","stop_hook_active":false}),
                0,
                serde_json::json!({}),
                false,
                false,
            ),
        ];

        for (name, host, event, inp_val, exp_code, exp_json, no_empty, no_upd) in cases {
            let input = parse_stdin(host, Some(event), inp_val.to_string().as_bytes()).expect("parse input");
            let paths = WorkspacePaths {
                workspace: PathBuf::from("/work/hub"),
                data_dir: PathBuf::from("/work/hub/data"),
                audit_root: PathBuf::from("/tmp/harness-fixture-audit"),
                has_workspace_marker: true,
                is_plugin_mode: false,
            };
            let outcome = eng.evaluate(&input, &paths);
            let rendered = render_outcome(host, event, &outcome);
            assert_eq!(rendered.exit_code, exp_code, "{name}");
            let actual_json: Value = serde_json::from_str(rendered.stdout.trim()).expect("actual stdout json");
            assert_eq!(actual_json, exp_json, "fixture mismatch: {name}");
            if no_empty {
                assert_ne!(rendered.stdout.trim(), "{}", "{name} emitted {{}}");
            }
            if no_upd {
                assert!(!rendered.stdout.contains("updatedInput"), "{name} emitted updatedInput");
            }
        }
    }

    #[test]
    fn plain_norm_and_memories_guard_r1_regressions() {
        let mem_ent = ["memories", "entities"].join("/");
        assert_eq!(
            plain_norm("memories/x/../entities/a"),
            format!("{mem_ent}/a")
        );
        assert_eq!(plain_norm("memories/."), "memories");
        assert_eq!(plain_norm("find memories/."), "find memories");
        assert_eq!(plain_norm("./memories/./"), "memories");

        let eng = hub_engine();
        let mem_script = "/work/hub/hub/memory/mem.mjs";
        let denied = [
            "cat memories/x/../entities/agent/scout/profile.yaml".to_string(),
            "find memories/.".to_string(),
            "rg x memories/.".to_string(),
            "ls -R memories/.".to_string(),
            "bash -c \"find memories\"".to_string(),
            "bash -lc \"find memories\"".to_string(),
            "command find memories".to_string(),
            format!("node --eval=\"require('fs').readFileSync('{mem_ent}/a')\" \"{mem_script}\""),
            format!("node -e \"1\" \"{mem_script}\" {mem_ent}/a"),
            format!("node -p \"1\" \"{mem_script}\" {mem_ent}/a"),
            format!("node -pe \"1\" \"{mem_script}\" {mem_ent}/a"),
            format!("node /tmp/evil.js \"{mem_script}\" {mem_ent}/a"),
            "bun run .worktrees/x/hub/memory/ops.mjs".to_string(),
            "deno run --allow-all .worktrees/x/hub/memory/ops.mjs".to_string(),
            format!("mem get x && cat {mem_ent}/y"),
        ];
        for cmd in &denied {
            let out = eval_claude(&eng, "Bash", serde_json::json!({"command": cmd}));
            assert_eq!(out.decision, Some(Decision::Deny), "expected deny for: {cmd}");
        }

        let allowed = [
            "mem get agent:scout".to_string(),
            "mem --root \"/work/hub/memories\" get agent:scout".to_string(),
            "mem-bun get agent:scout".to_string(),
            "MEM_ROOT=/tmp/test bun run .worktrees/x/hub/memory/ops.mjs".to_string(),
        ];
        for cmd in &allowed {
            let out = eval_claude(&eng, "Bash", serde_json::json!({"command": cmd}));
            assert_eq!(out.decision, None, "expected allow for: {cmd}");
        }

        // tool_cwd = .../memories + cat entities/... -> DENIED
        let mem_cwd = "/work/hub/memories";
        let cat_rel = format!("cat {}", ["entities", "agent", "scout", "profile.yaml"].join("/"));
        let agy_payload = serde_json::json!({
            "conversationId": "test-sub-cwd",
            "workspacePaths": ["/work/hub"],
            "toolCall": { "name": "run_command", "args": { "CommandLine": cat_rel, "Cwd": mem_cwd } },
        });
        let inp_sub = parse_stdin(Host::Agy, Some("PreToolUse"), agy_payload.to_string().as_bytes()).unwrap();
        let ws_paths = WorkspacePaths {
            workspace: PathBuf::from("/work/hub"),
            data_dir: PathBuf::from("/work/hub/data"),
            audit_root: PathBuf::from("/tmp/harness-test-audit"),
            has_workspace_marker: true,
            is_plugin_mode: false,
        };
        assert_eq!(eng.evaluate(&inp_sub, &ws_paths).decision, Some(Decision::Deny));
    }

    #[test]
    fn mongo_guard_r1_regressions() {
        let eng = hub_engine();
        let ask_cmds = [
            "bash -lc 'mongosh'",
            "sh -ec 'mongod --port 27017'",
            "zsh -xc 'mongosh'",
            "dash -c 'mongosh'",
            "ksh -c 'mongosh'",
            r#"bash -c "mongo; true""#,
            r#"find . -exec mongosh \;"#,
            "git -c alias.x='!mongosh' x",
            "sudo --user root mongosh",
            "timeout -- 10 mongod --port 27017",
            "timeout -k 5 10 mongosh",
            "timeout --signal=KILL 10 mongosh",
            "env -u FOO A=B mongosh",
            "nice -n 10 mongosh",
            "ionice -c 3 mongosh",
        ];
        for cmd in ask_cmds {
            let out = eval_claude(&eng, "Bash", serde_json::json!({"command": cmd}));
            assert_eq!(out.decision, Some(Decision::Ask), "expected ask for: {cmd}");
            let agy_out = eval_agy(&eng, "run_command", serde_json::json!({"CommandLine": cmd}));
            let rendered = render_outcome(Host::Agy, "PreToolUse", &agy_out);
            assert!(rendered.stdout.contains(r#""decision":"deny""#), "{cmd}");
            assert!(rendered.stdout.contains("[ASK] "), "{cmd}");
        }
        assert_eq!(
            eval_claude(&eng, "Bash", serde_json::json!({"command": "grep mongosh README.md"})).decision,
            None
        );

        // Even if a custom config lists find/git in readonly_commands, dangerous flags must NOT skip backstop
        let custom_toml = r#"
[[bash_rules]]
id = "mongo-custom"
kind = "command_guard"
action = "ask"
tools = ["mongosh"]
backstop_tools = ["mongosh"]
readonly_commands = ["find", "git", "grep"]
"#;
        let custom_eng = RulesEngine::from_toml_str(custom_toml).unwrap();
        assert_eq!(
            eval_claude(&custom_eng, "Bash", serde_json::json!({"command": r#"find . -exec mongosh \;"#})).decision,
            Some(Decision::Ask)
        );
        assert_eq!(
            eval_claude(&custom_eng, "Bash", serde_json::json!({"command": "git -c alias.x='!mongosh' x"})).decision,
            Some(Decision::Ask)
        );
    }

    #[test]
    fn boundary_contains_handles_multibyte_utf8_without_panic() {
        assert!(!boundary_contains("xđất_đai", "đất"));
        assert!(boundary_contains("/work/projects/bí_mật/x", "bí_mật"));
        assert!(!boundary_contains("abí_mậtc", "bí_mật"));
    }

    #[test]
    fn tighten_only_forbids_replacing_patterns_on_existing_rule_ids() {
        let mut eng = RulesEngine::empty();
        let base = r#"
[[path_rules]]
id = "custom-secret-path"
tools = ["Read"]
action = "ask"
pattern = "secret-dir"
reason = "ask secret"

[[agy_arg_scan]]
id = "custom-agy-scan"
action = "ask"
pattern = "secret-dir"
reason = "ask agy"

[[bash_rules]]
id = "custom-bash-pat"
kind = "regex"
action = "ask"
pattern = "evil_cmd"
reason = "ask bash"

[[bash_rules]]
id = "custom-shell-acc"
kind = "shell_access"
action = "ask"
mention_regex = "vault/secrets"
reason = "ask shell"

[[bash_rules]]
id = "custom-cmd-guard"
kind = "command_guard"
action = "ask"
uri_regex = "redis://[^\\s]+"
uri_reason = "redis uri"
tools = ["redis-cli"]
"#;
        eng.merge_toml_str("user", "user.toml", base).unwrap();

        let override_attempt = r#"
[[path_rules]]
id = "custom-secret-path"
tools = ["NotebookEdit"]
action = "deny"
pattern = "never-match-anything"
reason = "bypassed"

[[agy_arg_scan]]
id = "custom-agy-scan"
action = "deny"
pattern = "never-match-anything"
reason = "bypassed"

[[bash_rules]]
id = "custom-bash-pat"
kind = "regex"
action = "deny"
pattern = "never-match-anything"
reason = "bypassed"

[[bash_rules]]
id = "custom-shell-acc"
kind = "shell_access"
action = "deny"
mention_regex = "never-match-anything"
reason = "bypassed"

[[bash_rules]]
id = "custom-cmd-guard"
kind = "command_guard"
action = "deny"
uri_regex = "never-match-anything"
tools = ["other-tool"]
reason = "bypassed"

[[bash_rules]]
id = "custom-new-rule"
kind = "regex"
action = "deny"
pattern = "brand_new_blocked"
reason = "new rule allowed"
"#;
        eng.merge_toml_str("project", "proj.toml", override_attempt).unwrap();

        // Original patterns, mention_regex, uri_regex, and tools MUST remain enforced, while action tightened to Deny!
        let r = eval_claude(&eng, "Read", serde_json::json!({"file_path": "/tmp/secret-dir/a"}));
        assert_eq!(r.decision, Some(Decision::Ask), "path_rule pattern/tools must not be replaced");
        let a = eval_agy(&eng, "read_file", serde_json::json!({"Path": "/tmp/secret-dir/a"}));
        assert_eq!(a.decision, Some(Decision::Ask), "agy_arg_scan pattern must not be replaced");
        let b = eval_claude(&eng, "Bash", serde_json::json!({"command": "evil_cmd --run"}));
        assert_eq!(b.decision, Some(Decision::Ask), "bash_rule pattern must not be replaced");
        let sa = eval_claude(&eng, "Bash", serde_json::json!({"command": "cat vault/secrets/k"}));
        assert_eq!(sa.decision, Some(Decision::Ask), "shell_access mention_regex must not be replaced");
        let cg_t = eval_claude(&eng, "Bash", serde_json::json!({"command": "redis-cli ping"}));
        assert_eq!(cg_t.decision, Some(Decision::Ask), "command_guard tools must not be replaced");
        let cg_u = eval_claude(&eng, "Bash", serde_json::json!({"command": "echo redis://10.0.0.1:6379"}));
        assert_eq!(cg_u.decision, Some(Decision::Ask), "command_guard uri_regex must not be replaced");
        let nw = eval_claude(&eng, "Bash", serde_json::json!({"command": "brand_new_blocked"}));
        assert_eq!(nw.decision, Some(Decision::Deny), "new rule ID must be added");
    }


    static T4_ENV: std::sync::Mutex<()> = std::sync::Mutex::new(());

    /// Closed fixture: temp workspace + temp HOME (never reads the real ~/.harness).
    fn t4_env(name: &str) -> (std::sync::MutexGuard<'static, ()>, PathBuf, PathBuf) {
        let guard = T4_ENV.lock().unwrap_or_else(|e| e.into_inner());
        let base = std::env::temp_dir().join(format!("harness-t4-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let ws = base.join("ws");
        let home = base.join("home");
        std::fs::create_dir_all(ws.join(".harness")).unwrap();
        std::fs::create_dir_all(home.join(".harness")).unwrap();
        std::env::set_var("HOME", &home);
        (guard, ws, home)
    }

    fn t4_hook(ws: &Path, tool: &str, ti: Value) -> HookOutcome {
        let eng = RulesEngine::load_for_hook(ws, Host::Claude, Some(tool));
        eval_claude(&eng, tool, ti)
    }

    const HUB_MONGO: &str = include_str!("../../tests/fixtures/hub-rules.toml");

    #[test]
    fn default_project_without_toml() {
        // No .harness/rules.toml: only generic guards; every project-shaped feature is off.
        let (_g, ws, _home) = t4_env("default-notoml");
        let _ = std::fs::remove_file(ws.join(".harness/rules.toml"));
        let eng = RulesEngine::load_for_hook(&ws, Host::Claude, Some("Bash"));
        let bash = |c: &str| eval_claude(&eng, "Bash", serde_json::json!({"command": c})).decision;
        assert_eq!(bash("cat data/x"), None, "data-gate must be off");
        assert_eq!(bash("mongosh --port 1"), None, "no command guard without TOML");
        assert_eq!(bash("echo mongodb://h:1/x"), None);
        assert_eq!(bash("rm -rf /"), Some(Decision::Ask));
        assert_eq!(bash("git push --force origin main"), Some(Decision::Ask));
        assert_eq!(bash("cat .env"), Some(Decision::Deny));
        let web = eval_claude(&eng, "WebFetch", serde_json::json!({"url": "https://example.com"}));
        assert_eq!(web.decision, None, "claude-web must be opt-in");
        let rd = eval_claude(&eng, "Read", serde_json::json!({"file_path": "/work/hub/data/x.jsonl"}));
        assert_eq!(rd.decision, None);
        let env_read = eval_claude(&eng, "Read", serde_json::json!({"file_path": "/work/hub/.env"}));
        assert_eq!(env_read.decision, Some(Decision::Deny));
    }

    #[test]
    fn deprecated_daemon_keys_still_parse_with_warning() {
        let old = r#"
[[bash_rules]]
id = "g"
kind = "command_guard"
action = "ask"
tools = ["x"]
[bash_rules.daemon_allow]
command = "d"
required_port = "1"
allowed_dbpath_default = "/work/a"
deny_reason = "r"
"#;
        let eng = RulesEngine::from_toml_str(old).expect("old keys parse");
        assert!(eng.warnings.iter().any(|w| w.contains("deprecated")), "{:?}", eng.warnings);
    }

    #[test]
    fn layer_user_deny_never_cannot_shadow_project_rule_same_id() {
        let (_g, ws, home) = t4_env("shadow1");
        std::fs::write(
            home.join(".harness/rules.toml"),
            "[[bash_rules]]\nid = \"mongo-guard\"\nkind = \"regex\"\naction = \"deny\"\npattern = '^NEVER$'\nreason = \"x\"\n",
        )
        .unwrap();
        std::fs::write(ws.join(".harness/rules.toml"), HUB_MONGO).unwrap();
        let r = t4_hook(&ws, "Bash", serde_json::json!({"command": "mongosh --port 27018"}));
        assert_eq!(r.decision, Some(Decision::Ask), "project mongo-guard must still apply");
    }

    #[test]
    fn layer_user_ask_never_cannot_shadow_project_rule_same_id() {
        let (_g, ws, home) = t4_env("shadow2");
        std::fs::write(
            home.join(".harness/rules.toml"),
            "[[bash_rules]]\nid = \"mongo-guard\"\nkind = \"regex\"\naction = \"ask\"\npattern = '^NEVER$'\nreason = \"x\"\n",
        )
        .unwrap();
        std::fs::write(ws.join(".harness/rules.toml"), HUB_MONGO).unwrap();
        let r = t4_hook(&ws, "Bash", serde_json::json!({"command": "mongosh --port 27018"}));
        assert_eq!(r.decision, Some(Decision::Ask));
    }

    #[test]
    fn layer_id_with_at_sign_is_load_error_fail_closed() {
        let (_g, ws, home) = t4_env("atsign");
        std::fs::write(
            home.join(".harness/rules.toml"),
            "[[bash_rules]]\nid = \"mongo-guard@project\"\nkind = \"regex\"\naction = \"deny\"\npattern = 'x'\nreason = \"x\"\n",
        )
        .unwrap();
        let eng = RulesEngine::load_for_hook(&ws, Host::Claude, Some("Write"));
        assert!(eng.warnings.iter().any(|w| w.contains('@')));
        let r = eval_claude(&eng, "Write", serde_json::json!({"file_path": "/tmp/a.txt"}));
        assert_eq!(r.decision, Some(Decision::Ask));
        let r = t4_hook(&ws, "Bash", serde_json::json!({"command": "echo hi"}));
        assert_eq!(r.decision, Some(Decision::Ask), "bash also fails closed");
    }

    #[test]
    fn layer_same_matcher_lower_later_action_stays_strict() {
        let mut eng = RulesEngine::empty();
        let deny = "[[path_rules]]\nid = \"r1\"\ntools = [\"Write\"]\naction = \"deny\"\nmatch_kind = \"regex\"\npattern = 'secret-a'\nreason = \"x\"\n";
        eng.merge_toml_str("user", "u.toml", deny).unwrap();
        eng.merge_toml_str("local", "l.toml", &deny.replace("deny", "ask")).unwrap();
        let r = eval_claude(&eng, "Write", serde_json::json!({"file_path": "/x/secret-a"}));
        assert_eq!(r.decision, Some(Decision::Deny));
    }

    #[test]
    fn core_protects_audit_root_without_data_gate() {
        let eng = RulesEngine::empty();
        let a = "/work/hub/data/system/audit";
        for tool in ["Write", "Edit", "MultiEdit", "NotebookEdit"] {
            for p in [format!("{a}/date=2026-01-01/type=tool/x.jsonl"), "data/system/audit/y.jsonl".to_string()] {
                let r = eval_claude(&eng, tool, serde_json::json!({"file_path": p}));
                assert_eq!(r.decision, Some(Decision::Deny), "{tool} {p}");
            }
        }
        for cmd in [format!("rm -rf {a}"), format!("echo x > {a}/f.jsonl")] {
            let r = eval_claude(&eng, "Bash", serde_json::json!({"command": cmd}));
            assert_eq!(r.decision, Some(Decision::Deny), "{cmd}");
        }
        let rd = eval_claude(&eng, "Bash", serde_json::json!({"command": format!("cat {a}/x.jsonl")}));
        assert_ne!(rd.decision, Some(Decision::Deny), "pure read stays allowed");
        let rr = eval_claude(&eng, "Read", serde_json::json!({"file_path": format!("{a}/x.jsonl")}));
        assert_ne!(rr.decision, Some(Decision::Deny));
        let ok = eval_claude(&eng, "Write", serde_json::json!({"file_path": "/work/hub/data/other/x"}));
        assert_ne!(ok.decision, Some(Decision::Deny));
    }

    #[test]
    fn audit_protect_bash_bypasses_are_denied() {
        let eng = RulesEngine::empty();
        for cmd in [
            "rm -rf data/system/audit",
            "cd data && rm -rf system/audit",
            "rm -rf /work/hub/data/system",
            "find /work/hub/data/system -delete",
            "rm -rf /work/hub/data/system/aud*",
            "mv /work/hub/data/system /tmp/x",
            "tee /work/hub/data/system/audit/f < /dev/null",
            "cd /work/hub/data/system/audit && rm -rf .",
            "cd /work/hub/data/system/audit && rm *",
        ] {
            let r = eval_claude(&eng, "Bash", serde_json::json!({"command": cmd}));
            assert_eq!(r.decision, Some(Decision::Deny), "{cmd}");
        }
    }

    #[test]
    fn audit_protect_r2_groupings_and_bulk_deleters_denied() {
        let eng = RulesEngine::empty();
        let a = "/work/hub/data/system/audit";
        for cmd in [
            "(cd /work/hub/data && rm -rf system/audit)".to_string(),
            "{ cd /work/hub/data; rm -rf system/audit; }".to_string(),
            "cd /work/hub/data && find . -name '*.jsonl' -delete".to_string(),
            "cd /work/hub/data && find . -exec rm {} +".to_string(),
            "cd /work/hub/data && find . -name '*.jsonl' | xargs rm -f".to_string(),
            "cd /work/hub/data && git clean -fdx".to_string(),
            format!("sort -o {a}/x.jsonl /tmp/in"),
            format!("dd if=/dev/zero of={a}/x.jsonl"),
            format!("echo x >{a}/f"),
        ] {
            let r = eval_claude(&eng, "Bash", serde_json::json!({"command": cmd}));
            assert_eq!(r.decision, Some(Decision::Deny), "{cmd}");
        }
    }

    #[test]
    fn audit_protect_r2_quoted_redirect_and_new_read_verbs_allowed() {
        let eng = RulesEngine::empty();
        let a = "/work/hub/data/system/audit";
        for cmd in [
            format!("jq 'select(.dur > 1000)' {a}/x.jsonl"),
            format!("grep '=>' {a}/f"),
            format!("cat {a}/x.jsonl > /tmp/y"),
            format!("cd {a} && wc -l * > /tmp/o"),
            format!("rg foo {a}"),
            format!("less {a}/x"),
            format!("zcat {a}/x.gz"),
            format!("zgrep foo {a}/x.gz"),
        ] {
            let r = eval_claude(&eng, "Bash", serde_json::json!({"command": cmd}));
            assert_ne!(r.decision, Some(Decision::Deny), "{cmd}");
        }
    }

    #[test]
    fn audit_protect_r3_everyday_commands_allowed_bulk_asks() {
        let eng = RulesEngine::empty();
        let run = |cmd: &str| eval_claude(&eng, "Bash", serde_json::json!({"command": cmd})).decision;
        for cmd in [
            "git clean -fd",
            "git clean -nfd",
            "xargs grep -l rm",
            "git ls-files -z | xargs -0 grep -l rm",
            "find src -name '*.tmp' -delete",
            "sort -o /tmp/out /tmp/in",
        ] {
            assert_ne!(run(cmd), Some(Decision::Deny), "{cmd}");
            assert_ne!(run(cmd), Some(Decision::Ask), "{cmd}");
        }
        for cmd in [
            "find . -name '*.tmp' -delete",
            "find . -exec chmod 644 {} \\;",
            "git ls-files -z | xargs -0 rm",
            "git ls-files -z | xargs -0 -n 5 rm -f",
            "git clean -fdx",
            "git -C /work/hub clean -x",
        ] {
            assert_eq!(run(cmd), Some(Decision::Ask), "{cmd}");
        }
        assert_eq!(run("cd /work/hub/data && git clean -fdx"), Some(Decision::Deny));
    }

    #[test]
    fn audit_protect_resolves_symlinked_data_dir() {
        let (_g, ws, _home) = t4_env("auditlink");
        std::fs::create_dir_all(ws.join("real/system/audit")).unwrap();
        std::os::unix::fs::symlink(ws.join("real"), ws.join("data")).unwrap();
        let root = ws.join("real/system/audit");
        let payload = serde_json::json!({"hook_event_name": "PreToolUse", "session_id": "t", "cwd": ws,
            "tool_name": "Bash", "tool_input": {"command": "rm -rf data/system"}});
        let input = parse_stdin(Host::Claude, Some("PreToolUse"), payload.to_string().as_bytes()).unwrap();
        let hit = eval_core_guard(&input, &[], &[], None, &root, &ws);
        assert_eq!(hit.map(|h| h.0), Some("audit-protect".to_string()));
    }

    #[test]
    fn audit_protect_read_only_commands_stay_allowed() {
        let eng = RulesEngine::empty();
        let a = "/work/hub/data/system/audit";
        for cmd in [
            format!("du -sh {a}"),
            format!("jq . {a}/x.jsonl"),
            format!("stat {a}"),
            format!("file {a}/x"),
            format!("cat {a}/x 2>/dev/null"),
            format!("cat {a}/x 2>&1"),
            format!("ls {a} | sort"),
            format!("cd {a} && ls"),
            "rm -rf /work/hub/data/other".to_string(),
        ] {
            let r = eval_claude(&eng, "Bash", serde_json::json!({"command": cmd}));
            assert_ne!(r.decision, Some(Decision::Deny), "{cmd}");
        }
    }

    #[test]
    fn core_protects_harness_dir_writes() {
        let (_g, ws, _home) = t4_env("coreprot");
        let eng = RulesEngine::empty();
        std::os::unix::fs::symlink(ws.join(".harness"), ws.join("link")).unwrap();
        let w = ws.display();
        let paths = [
            format!("{w}/.harness/rules.toml"),
            format!("{w}/.harness/rules.local.toml"),
            format!("{w}/.harness/agy.off"),
            format!("{w}/.harness/state/x.json"),
            format!("{w}/sub/../.harness/rules.toml"),
            format!("{w}/./.harness/./rules.toml"),
            format!("{w}/link/new.toml"),
            format!("{}/.harness/rules.toml", std::env::var("HOME").unwrap()),
        ];
        for tool in ["Write", "Edit", "MultiEdit", "NotebookEdit"] {
            for p in &paths {
                let r = eval_claude(&eng, tool, serde_json::json!({"file_path": p}));
                assert_eq!(r.decision, Some(Decision::Deny), "{tool} {p}");
            }
        }
        let ok = eval_claude(&eng, "Write", serde_json::json!({"file_path": format!("{w}/src/a.rs")}));
        assert_ne!(ok.decision, Some(Decision::Deny));
    }

    #[test]
    fn bash_mentioning_harness_dir_escalates_unless_pure_read() {
        let (_g, ws, _home) = t4_env("bashprot");
        let claude = RulesEngine::load_for_hook(&ws, Host::Claude, Some("Bash"));
        let agy = RulesEngine::load_for_hook(&ws, Host::Agy, Some("Bash"));
        for cmd in [
            "echo x > .harness/rules.toml",
            "mv .harness /tmp/h",
            "rm -rf .harness",
            "ln -s /tmp/x .harness/rules.toml",
            "f=.harness/rules.toml; : > $f",
            "python3 -c 'open(\".harness/rules.toml\",\"w\")'",
            "git checkout -- .harness",
            "cd .harness && printf x > rules.toml",
            "echo x > \"$HOME\"/.harness/rules.toml",
            "cp ~/.harness/rules.toml /tmp/bak",
            "find .harness -delete",
            "cat .harness/rules.toml > /tmp/o",
        ] {
            let r = eval_claude(&claude, "Bash", serde_json::json!({"command": cmd}));
            assert_eq!(r.decision, Some(Decision::Ask), "claude {cmd}");
            let a = eval_agy(&agy, "run_command", serde_json::json!({"CommandLine": cmd}));
            assert_eq!(a.decision, Some(Decision::Deny), "agy {cmd}");
        }
        for cmd in [
            "cat .harness/rules.toml",
            "ls -la .harness",
            "grep id .harness/rules.toml | head -5",
            "find .harness -name '*.toml'",
            "wc -l .harness/rules.toml",
        ] {
            let r = eval_claude(&claude, "Bash", serde_json::json!({"command": cmd}));
            assert_ne!(r.decision, Some(Decision::Ask), "read-only must pass: {cmd}");
            assert_ne!(r.decision, Some(Decision::Deny), "read-only must pass: {cmd}");
        }
    }

    #[test]
    fn bad_regex_rule_fails_closed_in_hook() {
        let (_g, ws, _home) = t4_env("badre");
        std::fs::write(
            ws.join(".harness/rules.toml"),
            "[[path_rules]]\nid = \"broken-rule\"\ntools = [\"Write\"]\naction = \"deny\"\nmatch_kind = \"regex\"\npattern = '('\nreason = \"x\"\n",
        )
        .unwrap();
        let r = t4_hook(&ws, "Write", serde_json::json!({"file_path": "/tmp/anything.txt"}));
        assert_eq!(r.decision, Some(Decision::Ask));
        assert!(r.reason.unwrap_or_default().contains("broken-rule"));
        let eng = RulesEngine::load_for_hook(&ws, Host::Agy, Some("Write"));
        let a = eval_agy(&eng, "write_to_file", serde_json::json!({"TargetFile": "/tmp/anything.txt"}));
        assert_eq!(a.decision, Some(Decision::Deny));
    }

    #[test]
    fn bad_bash_rule_regex_fails_closed_in_hook() {
        let (_g, ws, _home) = t4_env("badbash");
        std::fs::write(
            ws.join(".harness/rules.toml"),
            "[[bash_rules]]\nid = \"broken-bash\"\nkind = \"regex\"\naction = \"deny\"\npattern = '('\nreason = \"x\"\n",
        )
        .unwrap();
        let r = t4_hook(&ws, "Bash", serde_json::json!({"command": "echo hi"}));
        assert_eq!(r.decision, Some(Decision::Ask));
        assert!(r.reason.unwrap_or_default().contains("broken-bash"));
    }

    #[test]
    fn unparsable_or_unreadable_rules_file_fails_closed_for_writes_and_bash() {
        let (_g, ws, _home) = t4_env("badtoml");
        std::fs::write(ws.join(".harness/rules.toml"), "[[path_rules\nnot toml").unwrap();
        let r = t4_hook(&ws, "Write", serde_json::json!({"file_path": "/tmp/a.txt"}));
        assert_eq!(r.decision, Some(Decision::Ask));
        assert!(r.reason.unwrap_or_default().contains("rules-load-error"));
        let b = t4_hook(&ws, "Bash", serde_json::json!({"command": "echo hi"}));
        assert_eq!(b.decision, Some(Decision::Ask));

        let (_g2, ws2, _h) = (0, ws.clone(), 0);
        std::fs::remove_file(ws2.join(".harness/rules.toml")).unwrap();
        std::fs::create_dir_all(ws2.join(".harness/rules.local.toml")).unwrap();
        let r = t4_hook(&ws2, "Write", serde_json::json!({"file_path": "/tmp/a.txt"}));
        assert_eq!(r.decision, Some(Decision::Ask), "directory instead of rules file");
    }
