use crate::config::{discover_rule_files, home_dir, legacy_guard_files, normalize_slashes, WorkspacePaths};
use crate::data::load_registry;
use crate::rules::RulesEngine;
use serde::Serialize;
use serde_json::Value;
use std::fs;
use std::path::Path;
use std::io::Read;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

#[derive(Debug, Clone, Serialize)]
pub struct DoctorCheck {
    pub level: String, // "ok" | "warn" | "miss" | "na"
    pub name: String,
    pub detail: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct DoctorReport {
    pub ok: bool,
    pub version: String,
    pub binary_version: String,
    /// Source tree hash embedded at build time (T3); None for dev builds.
    pub src_tree: Option<String>,
    pub workspace: String,
    pub data_root: String,
    pub audit_root: String,
    pub checks: Vec<DoctorCheck>,
}

pub fn run_doctor(paths: &WorkspacePaths) -> DoctorReport {
    let mut checks = Vec::new();
    let mut all_ok = true;

    checks.push(DoctorCheck {
        level: "ok".to_string(),
        name: "harness".to_string(),
        detail: format!("v{} (native rust)", env!("CARGO_PKG_VERSION")),
    });

    checks.push(DoctorCheck {
        level: "ok".to_string(),
        name: "workspace".to_string(),
        detail: format!(
            "{} ({})",
            normalize_slashes(&paths.workspace.to_string_lossy()),
            if paths.has_workspace_marker {
                "hub/workspace"
            } else if paths.is_plugin_mode {
                "plugin"
            } else {
                "project"
            }
        ),
    });

    // Rules validation
    let rule_files = discover_rule_files(&paths.workspace);
    let eng = RulesEngine::load_for_workspace(&paths.workspace);
    if eng.warnings.is_empty() {
        checks.push(DoctorCheck {
            level: "ok".to_string(),
            name: "rules".to_string(),
            detail: format!("{} layer(s) active, 0 warnings", rule_files.len()),
        });
    } else {
        all_ok = false;
        checks.push(DoctorCheck {
            level: "miss".to_string(),
            name: "rules".to_string(),
            detail: eng.warnings.join("; "),
        });
    }

    let legacy = legacy_guard_files(&paths.workspace);
    if !legacy.is_empty() {
        all_ok = false;
        let names: Vec<String> = legacy
            .iter()
            .map(|p| normalize_slashes(&p.to_string_lossy()))
            .collect();
        checks.push(DoctorCheck {
            level: "miss".to_string(),
            name: "legacy-guard-json".to_string(),
            detail: format!(
                "{} no longer loaded; migrate to .harness/rules.toml and delete",
                names.join(", ")
            ),
        });
    }

    // Data registry
    match load_registry(&paths.workspace) {
        Ok((reg, src)) => checks.push(DoctorCheck {
            level: "ok".to_string(),
            name: "data-registry".to_string(),
            detail: format!("{} entries ({src})", reg.entries.len()),
        }),
        Err(e) => {
            all_ok = false;
            checks.push(DoctorCheck {
                level: "miss".to_string(),
                name: "data-registry".to_string(),
                detail: e,
            });
        }
    }

    // Claude settings / hooks check
    let claude_settings = paths.workspace.join(".claude").join("settings.json");
    if claude_settings.is_file() {
        match fs::read_to_string(&claude_settings)
            .ok()
            .and_then(|s| serde_json::from_str::<Value>(&s).ok())
        {
            Some(v) => {
                let has_hooks = v.get("hooks").is_some();
                checks.push(DoctorCheck {
                    level: "ok".to_string(),
                    name: "claude-settings".to_string(),
                    detail: format!(
                        ".claude/settings.json valid (hooks={has_hooks})"
                    ),
                });
            }
            None => {
                all_ok = false;
                checks.push(DoctorCheck {
                    level: "miss".to_string(),
                    name: "claude-settings".to_string(),
                    detail: ".claude/settings.json invalid JSON".to_string(),
                });
            }
        }
    } else {
        checks.push(DoctorCheck {
            level: "na".to_string(),
            name: "claude-settings".to_string(),
            detail: "no workspace .claude/settings.json (plugin mode)".to_string(),
        });
    }

    // agy hooks.json check
    let agy_hooks = paths.workspace.join(".agents").join("hooks.json");
    if agy_hooks.is_file() {
        match check_agy_hooks_file(&agy_hooks) {
            Ok(info) => checks.push(DoctorCheck {
                level: "ok".to_string(),
                name: "agy-hooks".to_string(),
                detail: info,
            }),
            Err(e) => {
                all_ok = false;
                checks.push(DoctorCheck {
                    level: "miss".to_string(),
                    name: "agy-hooks".to_string(),
                    detail: e,
                });
            }
        }
    } else if let Some(home) = home_dir() {
        let global_agy = home
            .join(".gemini")
            .join("config")
            .join("plugins")
            .join("harness-kit")
            .join("hooks.json");
        if global_agy.is_file() {
            match check_agy_hooks_file(&global_agy) {
                Ok(info) => checks.push(DoctorCheck {
                    level: "ok".to_string(),
                    name: "agy-plugin-hooks".to_string(),
                    detail: info,
                }),
                Err(e) => checks.push(DoctorCheck {
                    level: "warn".to_string(),
                    name: "agy-plugin-hooks".to_string(),
                    detail: e,
                }),
            }
        }
    }

    // Audit dir check: must be writable (or creatable), otherwise audit logging silently fails.
    let (audit_ok, audit_detail) = check_audit_root(&paths.audit_root, &paths.workspace);
    if !audit_ok {
        all_ok = false;
    }
    checks.push(DoctorCheck {
        level: if audit_ok { "ok" } else { "miss" }.to_string(),
        name: "audit-root".to_string(),
        detail: audit_detail,
    });

    // Optional external tool (the plugin itself is only this binary)
    let ver = tool_version("git");
    checks.push(DoctorCheck {
        level: if ver.is_some() { "ok" } else { "na" }.to_string(),
        name: "git".to_string(),
        detail: ver.unwrap_or_else(|| "not found (optional)".to_string()),
    });

    DoctorReport {
        ok: all_ok,
        version: env!("CARGO_PKG_VERSION").to_string(),
        binary_version: env!("CARGO_PKG_VERSION").to_string(),
        src_tree: option_env!("HARNESS_SRC_TREE").map(ToString::to_string),
        workspace: normalize_slashes(&paths.workspace.to_string_lossy()),
        data_root: normalize_slashes(&paths.data_dir.to_string_lossy()),
        audit_root: normalize_slashes(&paths.audit_root.to_string_lossy()),
        checks,
    }
}

fn check_agy_hooks_file(path: &Path) -> Result<String, String> {
    let raw = fs::read_to_string(path).map_err(|e| e.to_string())?;
    let val: Value = serde_json::from_str(&raw).map_err(|e| format!("invalid JSON: {e}"))?;
    let Some(obj) = val.as_object() else {
        return Err("root must be JSON object".to_string());
    };
    if obj.contains_key("hooks") {
        return Err("invalid agy layout: top-level key 'hooks' is Claude layout".to_string());
    }
    Ok(format!("{} hook group(s) valid", obj.len()))
}

const TOOL_TIMEOUT: Duration = Duration::from_secs(3);

fn tool_version(bin: &str) -> Option<String> {
    cmd_output_timeout(bin, &["--version"], TOOL_TIMEOUT)
}

/// Run `bin args`, return trimmed stdout if it exits 0 within `timeout`; kill it otherwise.
fn cmd_output_timeout(bin: &str, args: &[&str], timeout: Duration) -> Option<String> {
    let mut child = Command::new(bin)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let start = Instant::now();
    // Read stdout in a thread so a grandchild holding the pipe cannot block us past `timeout`.
    let mut stdout = child.stdout.take()?;
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let mut s = String::new();
        let _ = (&mut stdout).take(64 * 1024).read_to_string(&mut s);
        let _ = tx.send(s);
    });
    let out = rx.recv_timeout(timeout).ok();
    let status = loop {
        match child.try_wait() {
            Ok(Some(st)) if out.is_some() => break Some(st),
            Ok(None) if out.is_some() && start.elapsed() < timeout => {
                std::thread::sleep(Duration::from_millis(10));
            }
            _ => break None,
        }
    };
    if !status.is_some_and(|s| s.success()) {
        let _ = child.kill();
        let _ = child.wait();
        return None;
    }
    let s = out.unwrap_or_default().trim().to_string();
    if s.is_empty() {
        None
    } else {
        Some(s)
    }
}

/// Create+remove a probe file: the only reliable writability test (modes, ACLs, read-only mounts).
fn dir_writable(dir: &Path) -> bool {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.subsec_nanos());
    let probe = dir.join(format!(".harness-doctor-probe-{}-{nanos}", std::process::id()));
    match fs::OpenOptions::new().write(true).create_new(true).open(&probe) {
        Ok(_) => {
            let _ = fs::remove_file(&probe);
            true
        }
        Err(_) => false,
    }
}

/// Writability of an existing dir: probe-write inside the workspace only; outside it we never
/// write, so fall back to the permission bits and say so ("unverified").
fn dir_usable(dir: &Path, workspace: &Path) -> (bool, bool) {
    if dir.starts_with(workspace) {
        (dir_writable(dir), true)
    } else {
        let ro = fs::metadata(dir).map_or(true, |m| m.permissions().readonly());
        (!ro, false)
    }
}

fn check_audit_root(root: &Path, workspace: &Path) -> (bool, String) {
    let shown = normalize_slashes(&root.to_string_lossy());
    let note = |verified: bool| if verified { "" } else { " (unverified: outside workspace)" };
    if root.is_dir() {
        let (ok, verified) = dir_usable(root, workspace);
        return if ok {
            (true, format!("{shown}{}", note(verified)))
        } else {
            (false, format!("{shown} (not writable)"))
        };
    }
    if root.exists() {
        return (false, format!("{shown} (exists but is not a directory)"));
    }
    // Missing: usable iff the nearest existing ancestor is a writable directory.
    match root.ancestors().skip(1).find(|a| a.exists()) {
        Some(a) if a.is_dir() && dir_usable(a, workspace).0 => (
            true,
            format!("{shown} (will be created){}", note(dir_usable(a, workspace).1)),
        ),
        Some(a) => (
            false,
            format!(
                "{shown} (cannot be created under {})",
                normalize_slashes(&a.to_string_lossy())
            ),
        ),
        None => (false, format!("{shown} (no existing parent)")),
    }
}

pub fn format_doctor_summary(rep: &DoctorReport) -> String {
    let mut lines = Vec::with_capacity(rep.checks.len() + 2);
    lines.push(format!(
        "harness doctor v{} ({})",
        rep.version,
        if rep.ok { "OK" } else { "ISSUES" }
    ));
    for c in &rep.checks {
        let tag = match c.level.as_str() {
            "ok" => "[OK]  ",
            "miss" => "[MISS]",
            "warn" => "[WARN]",
            _ => "[--]  ",
        };
        lines.push(format!("{tag} {} - {}", c.name, c.detail));
    }
    lines.join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(tag: &str) -> std::path::PathBuf {
        let p = std::env::temp_dir().join(format!("harness-doctor-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&p);
        fs::create_dir_all(&p).unwrap();
        p
    }

    #[test]
    fn legacy_guard_json_reported() {
        let d = tmp("legacy");
        fs::create_dir_all(d.join("config/guard")).unwrap();
        fs::write(d.join("config/guard/local.json"), r#"{"protectedPaths":["x"]}"#).unwrap();
        let paths = WorkspacePaths {
            workspace: d.clone(),
            data_dir: d.join("data"),
            audit_root: d.join("audit"),
            has_workspace_marker: false,
            is_plugin_mode: true,
        };
        let rep = run_doctor(&paths);
        assert!(!rep.ok);
        let c = rep.checks.iter().find(|c| c.name == "legacy-guard-json").expect("check");
        assert_eq!(c.level, "miss");
        assert!(c.detail.contains("local.json") && c.detail.contains("rules.toml"), "{}", c.detail);
        // Never loaded any more.
        assert!(RulesEngine::load_for_workspace(&d).protected_paths.is_empty());
    }

    #[test]
    fn audit_root_that_is_a_file_fails() {
        let d = tmp("file");
        let f = d.join("audit");
        fs::write(&f, "x").unwrap();
        assert!(!check_audit_root(&f, &d).0);
        assert!(!check_audit_root(&f.join("sub"), &d).0);
    }

    #[test]
    fn audit_root_outside_workspace_is_never_written() {
        let ws = tmp("ws");
        let outside = tmp("outside");
        let (ok, detail) = check_audit_root(&outside, &ws);
        assert!(ok && detail.contains("unverified"), "{detail}");
        assert_eq!(fs::read_dir(&outside).unwrap().count(), 0, "probe leaked");
        let (_, detail) = check_audit_root(&outside.join("new"), &ws);
        assert!(detail.contains("unverified"), "{detail}");
        assert_eq!(fs::read_dir(&outside).unwrap().count(), 0, "probe leaked");
    }

    #[test]
    fn grandchild_holding_pipe_does_not_hang() {
        let t = Instant::now();
        let r = cmd_output_timeout("sh", &["-c", "sleep 5 & echo hi"], Duration::from_millis(300));
        assert!(r.is_none());
        assert!(t.elapsed() < Duration::from_secs(3), "{:?}", t.elapsed());
    }

    #[cfg(unix)]
    #[test]
    fn audit_root_missing_but_creatable_ok_and_readonly_fails() {
        let d = tmp("ro");
        assert!(check_audit_root(&d.join("new").join("audit"), &d).0);
        let ro = d.join("ro");
        fs::create_dir(&ro).unwrap();
        let mut perm = fs::metadata(&ro).unwrap().permissions();
        std::os::unix::fs::PermissionsExt::set_mode(&mut perm, 0o555);
        fs::set_permissions(&ro, perm).unwrap();
        let can_write = fs::write(ro.join("probe"), "x").is_ok(); // root ignores modes
        if !can_write {
            assert!(!check_audit_root(&ro, &d).0);
            assert!(!check_audit_root(&ro.join("audit"), &d).0);
        }
    }

    #[test]
    fn hung_tool_is_killed_by_timeout() {
        let t = Instant::now();
        assert!(cmd_output_timeout("sleep", &["5"], Duration::from_millis(200)).is_none());
        assert!(t.elapsed() < Duration::from_secs(3), "{:?}", t.elapsed());
        assert!(cmd_output_timeout("echo", &["hi"], Duration::from_secs(3)).is_some());
    }

    #[test]
    fn report_has_no_js_runtime_checks_and_has_binary_version() {
        let d = tmp("rep");
        let paths = WorkspacePaths {
            workspace: d.clone(),
            data_dir: d.join("data"),
            audit_root: d.join("audit"),
            has_workspace_marker: false,
            is_plugin_mode: true,
        };
        let rep = run_doctor(&paths);
        assert!(rep.checks.iter().all(|c| c.name != "bun" && c.name != "node"));
        assert_eq!(rep.binary_version, env!("CARGO_PKG_VERSION"));
    }
}
