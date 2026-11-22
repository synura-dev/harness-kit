use super::*;

pub(super) fn is_config_dump(ncmd: &str, orig_cmd: &str, extra_names: &[String]) -> bool {
    const HINTS: &[&str] = &[
        ".env",
        ".pem",
        ".key",
        ".p12",
        ".pfx",
        ".jks",
        ".keystore",
        "id_",
        "credentials",
        ".npmrc",
        ".netrc",
        ".pgpass",
        ".git-credentials",
        "secret",
        "service-account",
    ];
    let has_hint = HINTS.iter().any(|h| has_ascii_ci(ncmd, h))
        || extra_names.iter().any(|n| has_ascii_ci(ncmd, n));
    if !has_hint {
        return false;
    }
    // Unless piped to sha256sum | md5sum | shasum | wc
    if regex_cached(r"(?i)\|\s*(sha256sum|md5sum|shasum|wc)\b")
        .is_some_and(|r| r.is_match(orig_cmd))
    {
        return false;
    }
    let dump_re = regex_cached(
        r"(?i)\b(?:cat|type|Get-Content|gc|less|more|bat|sed\s+-n|head|tail)\b[^|;&\n]*",
    );
    let Some(re) = dump_re else {
        return false;
    };
    let env_re = regex_cached(r#"(?i)(?:^|[\\/\s'"=])(\.env(?:\.[\w-]+)*)(?:$|[\s'"|;&)])"#);
    let tok_re = regex_cached(
        r#"(?i)(?:^|[\\/\s'"=])(?:[\w.-]*\.(?:pem|key|p12|pfx|jks|keystore)|id_(?:rsa|dsa|ecdsa|ed25519)|credentials(?:\.json)?|\.npmrc|\.netrc|\.pgpass|\.git-credentials|secrets?\.(?:json|ya?ml)|service-account[\w.-]*\.json)(?:$|[\s'"|;&)])"#,
    );
    let extra_re = build_extra_sensitive_regex(extra_names);

    for m in re.find_iter(ncmd) {
        let seg = m.as_str();
        if let Some(er) = env_re {
            for cap in er.captures_iter(seg) {
                if let Some(tok) = cap.get(1) {
                    let lower = tok.as_str().to_ascii_lowercase();
                    let exempt = [".env.example", ".env.sample", ".env.template", ".env.dist"]
                        .iter()
                        .any(|ex| lower == *ex || lower.starts_with(&format!("{ex}.")));
                    if !exempt {
                        return true;
                    }
                }
            }
        }
        if tok_re.is_some_and(|r| r.is_match(seg)) {
            return true;
        }
        if extra_re.as_ref().is_some_and(|r| r.is_match(seg)) {
            return true;
        }
    }
    false
}

pub(super) fn build_extra_sensitive_regex(extra: &[String]) -> Option<Regex> {
    let alts: Vec<String> = extra
        .iter()
        .map(|s| s.trim())
        .filter(|s| !s.is_empty() && *s != ".env")
        .map(regex::escape)
        .collect();
    if alts.is_empty() {
        return None;
    }
    let pat = format!(r#"(?i)(?:^|[\\/\s'"=])(?:{})(?:$|[\s'"|;&)])"#, alts.join("|"));
    Regex::new(&pat).ok()
}

// ============================================================================
// Core data-gate (data-gate/hook.mjs)
// ============================================================================

pub(super) fn eval_data_gate(input: &HookInput, paths: &WorkspacePaths, tool_cwd: &Path) -> Option<String> {
    if env::var("HARNESS_GATEWAY").ok().as_deref() == Some("1") {
        return None;
    }
    let tool = input.tool_name.as_deref()?;
    let cwd = tool_cwd;

    let data_bases = data_bases(paths);
    let in_data = |raw: &str, base_dir: &Path| -> bool {
        if raw.is_empty() {
            return false;
        }
        for candidate in resolve_posix_and_real(base_dir, raw) {
            if data_bases
                .iter()
                .any(|db| is_inside_posix(&candidate, db))
            {
                return true;
            }
        }
        false
    };

    let hit = match tool {
        "Read" | "Write" | "Edit" | "NotebookEdit" | "MultiEdit" => {
            let p = input
                .tool_input
                .get("file_path")
                .or_else(|| input.tool_input.get("notebook_path"))
                .or_else(|| input.tool_input.get("path"))
                .and_then(Value::as_str)
                .unwrap_or("");
            in_data(p, cwd)
        }
        "Glob" | "Grep" => {
            let p = input
                .tool_input
                .get("path")
                .and_then(Value::as_str)
                .unwrap_or("");
            if !p.is_empty() && in_data(p, cwd) {
                true
            } else {
                let pat_key = if tool == "Glob" { "pattern" } else { "glob" };
                let g = input
                    .tool_input
                    .get(pat_key)
                    .and_then(Value::as_str)
                    .map(glob_base)
                    .unwrap_or("");
                if !g.is_empty() {
                    let base_dir = if p.is_empty() {
                        cwd.to_path_buf()
                    } else {
                        lexical_path(cwd, p)
                    };
                    in_data(g, &base_dir)
                } else {
                    false
                }
            }
        }
        "Bash" | "PowerShell" => {
            let cmd = input
                .tool_input
                .get("command")
                .and_then(Value::as_str)
                .unwrap_or("");
            let cwd_posix = normalize_slashes(&cwd.to_string_lossy());
            let mut names: Vec<String> = data_bases
                .iter()
                .filter_map(|b| b.rsplit('/').find(|p| !p.is_empty()).map(str::to_string))
                .collect();
            if names.is_empty() {
                names.push("data".to_string());
            }
            let cwd_in_data = data_bases
                .iter()
                .any(|db| is_inside_posix(&cwd_posix, db));
            // path-level prefilter: protected dir name (quote-stripped) or .harness, never a bare word
            let hays = prefilter_haystacks(cmd);
            if !cwd_in_data
                && !hays.iter().any(|h| {
                    has_ascii_ci(h, ".harness") || names.iter().any(|n| has_ascii_ci(h, n))
                })
                && !cmd.contains("..")
            {
                false
            } else {
                bash_refs_data(cmd, cwd, &in_data, 0)
            }
        }
        _ => false,
    };

    if hit {
        let rel = data_gate_rel_label(paths);
        Some(format!(
            "data-gate: khong doc/ghi thang {rel}/. Dung cong: harness data ls|... hoac observe (co log)."
        ))
    } else {
        None
    }
}

pub(super) fn data_bases(paths: &WorkspacePaths) -> Vec<String> {
    let mut out = vec![normalize_slashes(&paths.data_dir.to_string_lossy())];
    if let Some(real) = crate::config::canonicalize_with_tail(&paths.data_dir) {
        let r = normalize_slashes(&real.to_string_lossy());
        if !out.contains(&r) {
            out.push(r);
        }
    }
    out
}

pub(super) fn data_gate_rel_label(paths: &WorkspacePaths) -> String {
    if let Ok(rel) = paths.data_dir.strip_prefix(&paths.workspace) {
        let s = normalize_slashes(&rel.to_string_lossy());
        if !s.is_empty() && s != "." {
            return s;
        }
    }
    normalize_slashes(&paths.data_dir.to_string_lossy())
}

pub(super) fn bash_refs_data<F>(cmd: &str, cwd: &Path, in_data: &F, depth: usize) -> bool
where
    F: Fn(&str, &Path) -> bool,
{
    if depth > 3 || cmd.trim().is_empty() {
        return false;
    }
    if depth == 0 {
        // terminates: the unescaped form is strictly shorter
        let unescaped = unescape_shell_bs(cmd);
        if unescaped != cmd && bash_refs_data(&unescaped, cwd, in_data, 0) {
            return true;
        }
    }
    let normalized = cmd.replace("\\ ", "\u{0001}").replace('\\', "/");
    for sub in extract_command_subs(&normalized) {
        if bash_refs_data(&sub, cwd, in_data, depth + 1) {
            return true;
        }
    }

    let mut cur = cwd.to_path_buf();
    for seg in split_shell_segments(&normalized) {
        let mut s = seg.trim().to_string();
        if s.is_empty() {
            continue;
        }
        if let Some(rest) = strip_cd_prefix(&s) {
            if let Some(target) = data_tokens(rest, true)
                .into_iter()
                .find(|x| !x.eq_ignore_ascii_case("/d") && !(x.starts_with('-') && x.len() == 2))
            {
                cur = lexical_path(&cur, &target);
            }
            continue;
        }
        if let Some(inner) = unwrap_shell_c(&s) {
            if bash_refs_data(&inner, &cur, in_data, depth + 1) {
                return true;
            }
        }
        if is_clean_harness_gateway_call(&s) {
            continue;
        }
        if is_node_bun_lead(&s)
            && data_tokens(&s, true)
                .into_iter()
                .any(|t| in_data(&t, &cur) || in_data(&t, cwd))
        {
            return true;
        }
        if is_textual_lead(&s) {
            s = strip_quoted_strings(&s);
        }
        if is_git_path_cmd(&s) {
            let hit = data_tokens(&s, true).into_iter().any(|t| {
                in_data(&t, &cur)
                    || in_data(&t, cwd)
                    || t.split_once(':')
                        .is_some_and(|(_, p)| in_data(p, &cur) || in_data(p, cwd))
            });
            if hit {
                return true;
            }
            continue;
        }
        if !has_data_verb(&s) {
            continue;
        }
        let is_grep = is_grep_lead(&s);
        let mut cands = data_tokens(&s, !is_grep);
        if is_grep {
            if let Some(e_idx) = cands.iter().position(|t| t == "-e") {
                if e_idx + 1 < cands.len() {
                    cands.remove(e_idx + 1);
                }
            } else if let Some(pat_idx) = cands
                .iter()
                .enumerate()
                .skip(1)
                .find(|(_, t)| !t.starts_with('-'))
                .map(|(i, _)| i)
            {
                cands.remove(pat_idx);
            }
        }
        if cands
            .into_iter()
            .any(|t| in_data(&t, &cur) || in_data(&t, cwd))
        {
            return true;
        }
    }
    false
}

pub(super) fn is_clean_harness_gateway_call(seg: &str) -> bool {
    let cleaned = regex_cached(r"(?i)\d*>&\d|\d*>>?\s*(?:/dev/null|nul)\b")
        .map(|r| r.replace_all(seg, "").into_owned())
        .unwrap_or_else(|| seg.to_string());
    if cleaned.contains("$(")
        || cleaned.contains('`')
        || cleaned.contains('<')
        || cleaned.contains('>')
    {
        return false;
    }
    let bin_re = regex_cached(
        r"(?i)^(?:\w+=\S*\s+)*(?:(?:timeout|nice)\s+(?:-\S+\s+)*\S+\s+)?harness(?:\.cmd|\.exe)?(?:\s|$)",
    );
    let gate_run_re = regex_cached(
        r#"(?i)^(?:\w+=\S*\s+)*(?:(?:timeout|nice)\s+(?:-\S+\s+)*\S+\s+)?(?:node|bun)(?:\.exe)?\s+(?:--?[\w-]+(?:=\S+)?\s+)*(?:"[^"]*(?:harness/|bin/harness(?:\.mjs)?)"|'[^']*(?:harness/|bin/harness(?:\.mjs)?)'|[^\s"']*(?:harness/\S*|bin/harness(?:\.mjs)?))(?:\s|$)"#,
    );
    bin_re.is_some_and(|r| r.is_match(seg)) || gate_run_re.is_some_and(|r| r.is_match(seg))
}

pub(super) fn is_node_bun_lead(seg: &str) -> bool {
    regex_cached(
        r"(?i)^(?:\w+=\S*\s+)*(?:(?:timeout|nice)\s+(?:-\S+\s+)*\S+\s+)?(?:node|bun)(?:\.exe)?\s+",
    )
    .is_some_and(|r| r.is_match(seg))
}

pub(super) fn is_textual_lead(seg: &str) -> bool {
    regex_cached(r"(?i)^(?:git\s+(?:commit|log|tag|notes)|echo|printf)(?:\s|$)")
        .is_some_and(|r| r.is_match(seg))
}

pub(super) fn is_git_path_cmd(seg: &str) -> bool {
    regex_cached(
        r"(?i)^git\s+(?:-C\s+\S+\s+|-\S+\s+)*(?:add|rm|mv|checkout|restore|clean|reset|update-index|stash|status|diff|log|show)(?:\s|$)",
    )
    .is_some_and(|r| r.is_match(seg))
}

pub(super) fn is_grep_lead(seg: &str) -> bool {
    regex_cached(r"(?i)^(?:grep|egrep|fgrep|rg)(?:\s|$)").is_some_and(|r| r.is_match(seg))
}

pub(super) fn has_data_verb(seg: &str) -> bool {
    regex_cached(
        r"(?i)(?:^|[\s;&|(`])(?:cat|type|head|tail|less|more|ls|dir|find|grep|rg|sed|awk|tee|rm|del|erase|rd|rmdir|mv|move|ren|cp|copy|xcopy|touch|mkdir|truncate|get-content|gc|set-content|add-content|out-file|remove-item|copy-item|move-item|get-childitem|gci|sort|wc|cut|od|xxd)(?:\s|$)|>|readfilesync|writefilesync|readdirsync|unlinksync|rmsync|open\(|node\s+-e|node\s+--eval|python",
    )
    .is_some_and(|r| r.is_match(seg))
}

pub(super) fn strip_cd_prefix(seg: &str) -> Option<&str> {
    let re = regex_cached(r"(?i)^(?:cd|pushd|chdir|set-location|sl)\s+(.*)$")?;
    re.captures(seg).and_then(|c| c.get(1).map(|m| m.as_str()))
}

pub(super) fn unwrap_shell_c(seg: &str) -> Option<String> {
    let re = regex_cached(
        r#"(?i)(?:^|[\s;&|(])(?:bash|sh|zsh|dash|pwsh|powershell|cmd)(?:\.exe)?\s+(?:-\S+\s+)*?(?:-\w*c|-command|/[ck])\s+("([^"]*)"|'([^']*)'|(.*))"#,
    )?;
    let caps = re.captures(seg)?;
    caps.get(2)
        .or_else(|| caps.get(3))
        .or_else(|| caps.get(4))
        .map(|m| m.as_str().to_string())
}

pub(super) fn strip_quoted_strings(s: &str) -> String {
    regex_cached(r#""[^"]*"|'[^']*'"#)
        .map(|r| r.replace_all(s, " ").into_owned())
        .unwrap_or_else(|| s.to_string())
}

pub(super) fn data_tokens(s: &str, split_inner: bool) -> Vec<String> {
    let mut out = Vec::new();
    let Some(re) = regex_cached(r#""([^"]*)"|'([^']*)'|([^\s"'()<>=,]+)"#) else {
        return out;
    };
    let Some(part_re) = regex_cached(r#"[^\s"'()<>=,]+"#) else {
        return out;
    };
    for caps in re.captures_iter(s) {
        let quoted = caps.get(3).is_none();
        if let Some(m) = caps.get(1).or_else(|| caps.get(2)).or_else(|| caps.get(3)) {
            let t = m.as_str().replace('\u{0001}', " ");
            out.push(t.clone());
            if split_inner && quoted {
                for pm in part_re.find_iter(&t) {
                    out.push(pm.as_str().to_string());
                }
            }
        }
    }
    out
}

pub(super) fn is_inside_posix(p: &str, dir: &str) -> bool {
    let np = p.trim_end_matches('/');
    let nd = dir.trim_end_matches('/');
    np == nd || np.starts_with(&format!("{nd}/"))
}

pub(super) fn glob_base(g: &str) -> &str {
    match g.find(['*', '?', '[', '{']) {
        Some(idx) => &g[..idx],
        None => g,
    }
}

