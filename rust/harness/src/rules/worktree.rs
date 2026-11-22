use super::*;

pub(super) fn check_worktree_script(
    cmd: &str,
    tool_cwd: &Path,
    script_re: &Regex,
    exclude_re: Option<&Regex>,
    allow_env_vars: &[String],
    allow_tmp_prefixes: &[String],
    ignore_script_paths: &[String],
) -> bool {
    let unescaped = unescape_shell_bs(cmd);
    let mut forms = vec![cmd];
    if unescaped != cmd {
        forms.push(&unescaped);
    }
    forms.into_iter().any(|c| {
        wt_cmd(
            c,
            tool_cwd,
            0,
            &[],
            c,
            script_re,
            exclude_re,
            allow_env_vars,
            allow_tmp_prefixes,
            ignore_script_paths,
        )
    })
}

pub(super) fn extract_worktree_runtime_script(cmd_base: &str, args: &[String]) -> Option<String> {
    let runtime = cmd_base.strip_suffix(".exe").unwrap_or(cmd_base);
    if !matches!(runtime, "bun" | "node" | "deno") {
        return None;
    }
    let mut seen_run = false;
    let mut skip_next = false;
    for arg in args {
        if skip_next {
            skip_next = false;
            continue;
        }
        if arg == "--" {
            continue;
        }
        if arg.starts_with('-') {
            if matches!(
                arg.as_str(),
                "--cwd" | "--env-file" | "--config" | "-c" | "--conditions" | "--preload" | "-r"
            ) {
                skip_next = true;
            }
            continue;
        }
        if !seen_run && matches!(runtime, "bun" | "deno") && arg == "run" {
            seen_run = true;
            continue;
        }
        return Some(arg.clone());
    }
    None
}

#[allow(clippy::too_many_arguments)]
pub(super) fn wt_cmd(
    cmd: &str,
    initial_cwd: &Path,
    depth: usize,
    env_in: &[(String, String)],
    whole: &str,
    script_re: &Regex,
    exclude_re: Option<&Regex>,
    allow_env_vars: &[String],
    allow_tmp_prefixes: &[String],
    ignore_script_paths: &[String],
) -> bool {
    if depth > 6 {
        return false;
    }
    let mut exported = env_in.to_vec();
    if let Some(re) = regex_cached(r"(?:^|[;&|\s])export\s+([A-Za-z_]\w*=\S+)") {
        for caps in re.captures_iter(cmd) {
            if let Some(kv) = caps.get(1) {
                if let Some((k, v)) = kv.as_str().split_once('=') {
                    exported.push((k.to_string(), v.to_string()));
                }
            }
        }
    }
    let mut cur_cwd = initial_cwd.to_path_buf();
    for seg in split_shell_segments(cmd) {
        let toks = shell_tokens(&seg);
        if toks.is_empty() {
            continue;
        }
        let unwrapped = unwrap_shell_prefix(&toks);
        let mut local_env = exported.clone();
        local_env.extend(unwrapped.env_assigns);
        let rest = unwrapped.rest;
        let c_raw = rest.first().map(String::as_str).unwrap_or("");
        let c = basename(c_raw);
        if c == "cd" {
            if let Some(target) = rest
                .iter()
                .skip(1)
                .find(|x| !x.starts_with('-') && !x.eq_ignore_ascii_case("/d"))
            {
                cur_cwd = lexical_path(&cur_cwd, target);
            }
            continue;
        }
        if matches!(c, "bash" | "sh" | "zsh" | "dash" | "ksh") {
            let mut k = 1usize;
            while k < rest.len() {
                let tok = &rest[k];
                if tok == "--" {
                    break;
                }
                if tok == "-o" || tok == "+o" {
                    k += 2;
                    continue;
                }
                if is_shell_c_flag(tok) {
                    if let Some(inner) = rest.get(k + 1) {
                        if wt_cmd(
                            inner,
                            &cur_cwd,
                            depth + 1,
                            &local_env,
                            whole,
                            script_re,
                            exclude_re,
                            allow_env_vars,
                            allow_tmp_prefixes,
                            ignore_script_paths,
                        ) {
                            return true;
                        }
                    }
                    break;
                }
                if !tok.starts_with('-') && !tok.starts_with('+') {
                    break;
                }
                k += 1;
            }
            continue;
        }
        let Some(f) = extract_worktree_runtime_script(c, &rest[1..]) else {
            continue;
        };
        if f == "test" {
            continue;
        }
        let norm_f = plain_norm(&f);
        let mut candidates = vec![norm_f.clone()];
        for res in resolve_posix_and_real(&cur_cwd, &f) {
            if !candidates.contains(&res) {
                candidates.push(res);
            }
        }
        if !candidates.iter().any(|cand| script_re.is_match(cand)) {
            continue;
        }
        if exclude_re.is_some_and(|ex| candidates.iter().any(|cand| ex.is_match(cand))) {
            continue;
        }
        let abs_f = normalize_slashes(&lexical_path(&PathBuf::from("/"), &norm_f).to_string_lossy());
        if ignore_script_paths
            .iter()
            .any(|ign| ign == &norm_f || ign == &abs_f || candidates.iter().any(|cand| cand == ign))
        {
            continue;
        }
        let matched_vars: Vec<&str> = local_env
            .iter()
            .filter(|(k, _)| allow_env_vars.iter().any(|av| av == k))
            .map(|(_, v)| v.as_str())
            .collect();
        if matched_vars.is_empty() {
            return true;
        }
        let all_tmp = matched_vars.iter().all(|v| {
            let trimmed = v.trim_matches(|ch| ch == '"' || ch == '\'');
            if trimmed.is_empty() {
                return allow_env_vars
                    .iter()
                    .any(|av| whole.contains(&format!("{av}=$(mktemp")));
            }
            if !trimmed.starts_with('/') {
                return false;
            }
            let resolved = crate::config::canonicalize_with_tail(Path::new(trimmed))
                .unwrap_or_else(|| lexical_path(Path::new("/"), trimmed));
            let rs = normalize_slashes(&resolved.to_string_lossy());
            allow_tmp_prefixes
                .iter()
                .any(|pfx| rs == *pfx || rs.starts_with(&format!("{pfx}/")))
        });
        if !all_tmp {
            return true;
        }
    }
    false
}

// ============================================================================
// WorktreeCreate / WorktreeRemove (Claude Code compatibility)
// ============================================================================

pub(super) fn handle_worktree_create(input: &HookInput, paths: &WorkspacePaths, dir: &str) -> HookOutcome {
    let Some(raw_name) = input.raw.get("name").and_then(Value::as_str) else {
        return HookOutcome {
            block: true,
            block_reason: Some("thieu name trong stdin WorktreeCreate".to_string()),
            ..Default::default()
        };
    };
    let clean: String = raw_name
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '_' || c == '-' { c } else { '-' })
        .collect();
    let clean = clean.trim_matches('-');
    if clean.is_empty() {
        return HookOutcome {
            block: true,
            block_reason: Some("ten worktree khong hop le".to_string()),
            ..Default::default()
        };
    }
    let clean: String = clean.chars().take(80).collect();
    let wt_path = paths.workspace.join(dir).join(&clean);
    if wt_path.exists() {
        return HookOutcome {
            worktree_path: Some(wt_path.to_string_lossy().to_string()),
            ..Default::default()
        };
    }
    let branch = format!("wt-{clean}");
    let out = Command::new("git")
        .arg("-C")
        .arg(&paths.workspace)
        .args(["worktree", "add"])
        .arg(&wt_path)
        .args(["-b", &branch])
        .output();
    match out {
        Ok(o) if o.status.success() => HookOutcome {
            worktree_path: Some(wt_path.to_string_lossy().to_string()),
            ..Default::default()
        },
        Ok(o) => HookOutcome {
            block: true,
            block_reason: Some(format!(
                "git worktree add failed: {}",
                String::from_utf8_lossy(&o.stderr).trim()
            )),
            ..Default::default()
        },
        Err(e) => HookOutcome {
            block: true,
            block_reason: Some(format!("git worktree add error: {e}")),
            ..Default::default()
        },
    }
}

pub(super) fn handle_worktree_remove(input: &HookInput, paths: &WorkspacePaths, dir: &str) {
    let Some(p) = input
        .raw
        .get("worktree_path")
        .or_else(|| input.raw.get("path"))
        .and_then(Value::as_str)
    else {
        return;
    };
    let wt_base = paths.workspace.join(dir);
    if is_inside_posix(
        &normalize_slashes(p),
        &normalize_slashes(&wt_base.to_string_lossy()),
    ) {
        let _ = Command::new("git")
            .arg("-C")
            .arg(&paths.workspace)
            .args(["worktree", "remove", p])
            .output();
    }
}

