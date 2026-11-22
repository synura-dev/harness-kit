use super::*;

#[allow(clippy::too_many_arguments)]
pub(super) fn check_shell_access(
    cmd: &str,
    tool_cwd: &Path,
    mention_re: &Regex,
    dir_re: Option<&Regex>,
    allow_commands: &HashSet<String>,
    allow_subcommands: &[(String, String)],
    allow_scripts: &[String],
    redirect_re: Option<&Regex>,
    search_cmds: &HashSet<String>,
    recursive_ls_flag: bool,
) -> bool {
    let unescaped = unescape_shell_bs(cmd);
    let mut forms = vec![cmd];
    if unescaped != cmd {
        forms.push(&unescaped);
    }
    forms.into_iter().any(|c| {
        check_shell_access_inner(
            c,
            tool_cwd,
            0,
            mention_re,
            dir_re,
            allow_commands,
            allow_subcommands,
            allow_scripts,
            redirect_re,
            search_cmds,
            recursive_ls_flag,
        )
    })
}

#[allow(clippy::too_many_arguments)]
pub(super) fn check_shell_access_inner(
    cmd: &str,
    initial_cwd: &Path,
    depth: usize,
    mention_re: &Regex,
    dir_re: Option<&Regex>,
    allow_commands: &HashSet<String>,
    allow_subcommands: &[(String, String)],
    allow_scripts: &[String],
    redirect_re: Option<&Regex>,
    search_cmds: &HashSet<String>,
    recursive_ls_flag: bool,
) -> bool {
    if depth > 6 {
        return false;
    }
    let func_def = regex_cached(r"(^|[;&|\s])(function\s+[\w-]+|[\w-]+\s*\(\s*\)\s*\{)");
    let p_full = plain_norm(cmd);
    if func_def.is_some_and(|r| r.is_match(cmd)) && mention_re.is_match(&p_full) {
        return true;
    }

    let ls_r_re = regex_cached(r"^-\w*R");
    let mut cur_cwd = initial_cwd.to_path_buf();

    for seg in split_shell_segments(cmd) {
        let raw_toks = shell_tokens(&seg);
        if raw_toks.is_empty() {
            continue;
        }
        let p = plain_norm(&seg);

        if let Some(rr) = redirect_re {
            if has_unquoted_redirect_matching(&seg, &cur_cwd, rr) {
                return true;
            }
        }

        let unwrapped = unwrap_shell_prefix(&raw_toks);
        for env_script in &unwrapped.env_scripts {
            if check_shell_access_inner(
                env_script,
                &cur_cwd,
                depth + 1,
                mention_re,
                dir_re,
                allow_commands,
                allow_subcommands,
                allow_scripts,
                redirect_re,
                search_cmds,
                recursive_ls_flag,
            ) {
                return true;
            }
        }

        let toks = unwrapped.rest;
        let cmd_tok = toks.first().map(String::as_str).unwrap_or("");
        let cmd_base = basename(cmd_tok);

        if matches!(cmd_base, "sh" | "bash" | "zsh" | "dash" | "ksh") {
            let mut k = 1usize;
            while k < toks.len() {
                let tok = &toks[k];
                if tok == "--" {
                    break;
                }
                if tok == "-o" || tok == "+o" {
                    k += 2;
                    continue;
                }
                if is_shell_c_flag(tok) {
                    if let Some(inner) = toks.get(k + 1) {
                        if check_shell_access_inner(
                            inner,
                            &cur_cwd,
                            depth + 1,
                            mention_re,
                            dir_re,
                            allow_commands,
                            allow_subcommands,
                            allow_scripts,
                            redirect_re,
                            search_cmds,
                            recursive_ls_flag,
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
        }

        // git is trusted only as the real binary and without options/env that run code
        // (-c alias.*=!..., core.pager/editor/sshCommand, GIT_PAGER, ...). Those payloads
        // are scanned like a nested shell; the command itself loses its allow status.
        let mut git_untrusted = false;
        if cmd_base == "git" {
            let (_, mut payloads) = git_exec_scan(toks.get(1..).unwrap_or(&[]));
            let (_, p2) = git_env_exec_scripts(&unwrapped.env_assigns);
            payloads.extend(p2);
            git_untrusted = !git_is_trusted(&toks, &unwrapped.env_assigns);
            for payload in &payloads {
                if check_shell_access_inner(
                    payload,
                    &cur_cwd,
                    depth + 1,
                    mention_re,
                    dir_re,
                    allow_commands,
                    allow_subcommands,
                    allow_scripts,
                    redirect_re,
                    search_cmds,
                    recursive_ls_flag,
                ) {
                    return true;
                }
            }
        }

        let is_allowed_cmd = allow_commands.contains(cmd_base)
            && !git_untrusted
            && !(unwrapped.had_env_or_assign && matches!(cmd_base, "mem" | "mem-bun"));
        let mut is_allowed_sub = !unwrapped.had_env_or_assign
            && allow_subcommands
                .iter()
                .any(|(c, s)| cmd_base == c && toks.get(1).is_some_and(|t| t == s));

        if !unwrapped.had_env_or_assign && !allow_scripts.is_empty() && toks.len() > 1 {
            if let Some(script_arg) = extract_runtime_main_script(cmd_base, &toks[1..]) {
                let norm_s = normalize_slashes(&script_arg);
                let plain_s = plain_norm(&script_arg);
                let script_matches = allow_scripts.contains(&norm_s)
                    || resolve_posix_and_real(&cur_cwd, &script_arg)
                        .iter()
                        .any(|r| allow_scripts.contains(r));
                if script_matches && !mention_re.is_match(&plain_s) {
                    is_allowed_sub = true;
                }
            }
        }

        let allowed = is_allowed_cmd || is_allowed_sub;
        if allowed {
            continue;
        }

        if mention_re.is_match(&p) {
            return true;
        }

        // Check resolved tokens relative to cur_cwd against mention_re
        for tok in toks.iter().skip(1) {
            if tok.starts_with('-') && !tok.contains('=') {
                continue;
            }
            for cand in token_path_candidates(&cur_cwd, tok) {
                if mention_re.is_match(&cand) {
                    return true;
                }
            }
        }

        if let Some(dr) = dir_re {
            let has_ls_r = recursive_ls_flag
                && cmd_base == "ls"
                && toks.iter().any(|t| ls_r_re.is_some_and(|r| r.is_match(t)));
            if cmd_base == "cd" || search_cmds.contains(cmd_base) || has_ls_r {
                let mut had_path_arg = false;
                for a in toks.iter().skip(1) {
                    if a.starts_with('-') && !a.contains('=') {
                        continue;
                    }
                    had_path_arg = true;
                    for cand in token_path_candidates(&cur_cwd, a) {
                        if dr.is_match(&cand) || mention_re.is_match(&cand) {
                            return true;
                        }
                    }
                }
                if !had_path_arg && cmd_base != "cd" {
                    for cand in resolve_posix_and_real(&cur_cwd, ".") {
                        if dr.is_match(&cand) || mention_re.is_match(&cand) {
                            return true;
                        }
                    }
                }
            }
        }

        if cmd_base == "cd" {
            if let Some(target) = toks
                .iter()
                .skip(1)
                .find(|x| !x.starts_with('-') && !x.eq_ignore_ascii_case("/d"))
            {
                cur_cwd = lexical_path(&cur_cwd, target);
            }
        }
    }
    false
}

pub(super) fn has_unquoted_redirect_matching(seg: &str, cur_cwd: &Path, rr: &Regex) -> bool {
    let chars: Vec<char> = seg.chars().collect();
    let mut i = 0;
    let mut quote: Option<char> = None;
    while i < chars.len() {
        let c = chars[i];
        if let Some(q) = quote {
            if c == q {
                quote = None;
            }
            i += 1;
            continue;
        }
        if c == '\'' || c == '"' {
            quote = Some(c);
            i += 1;
            continue;
        }
        if c == '>' {
            i += 1;
            while i < chars.len() && (chars[i] == '>' || chars[i] == '&') {
                i += 1;
            }
            while i < chars.len() && chars[i].is_whitespace() {
                i += 1;
            }
            let mut target = String::new();
            let mut tq: Option<char> = None;
            while i < chars.len() {
                let tc = chars[i];
                if let Some(q) = tq {
                    if tc == q {
                        tq = None;
                    } else {
                        target.push(tc);
                    }
                    i += 1;
                } else if tc == '\'' || tc == '"' {
                    tq = Some(tc);
                    i += 1;
                } else if tc.is_whitespace() || matches!(tc, ';' | '|' | '&') {
                    break;
                } else {
                    target.push(tc);
                    i += 1;
                }
            }
            if !target.is_empty()
                && (rr.is_match(&plain_norm(&target))
                    || resolve_posix_and_real(cur_cwd, &target)
                        .iter()
                        .any(|r| rr.is_match(r)))
            {
                return true;
            }
            continue;
        }
        i += 1;
    }
    false
}

// ============================================================================
// Command Guard (declarative command guard)
// ============================================================================

pub(super) fn check_command_guard(cmd: &str, cg: &CompiledCommandGuard) -> Option<String> {
    check_command_guard_depth(cmd, cg, 0)
}

pub(super) fn check_command_guard_depth(
    cmd: &str,
    cg: &CompiledCommandGuard,
    depth: usize,
) -> Option<String> {
    if depth > 6 {
        return None;
    }
    if let Some(uri_pat) = cg.uri_pat.as_deref() {
        if let Some(re) = regex_dyn_cached(uri_pat) {
            for caps in re.captures_iter(cmd) {
                let srv = caps.get(1).is_some_and(|m| !m.as_str().is_empty());
                let host = caps.get(2).map_or("", |m| m.as_str());
                let host_ok = cg
                    .uri_allow_host_pat
                    .as_deref()
                    .and_then(regex_dyn_cached)
                    .is_some_and(|hr| hr.is_match(host));
                if srv || !host_ok {
                    return Some(cg.uri_reason.clone());
                }
            }
        }
    }

    if let (Some(exec_pat), Some(kw_pat)) = (
        cg.inline_exec_pat.as_deref(),
        cg.inline_keyword_pat.as_deref(),
    ) {
        if regex_dyn_cached(exec_pat).is_some_and(|r| r.is_match(cmd))
            && regex_dyn_cached(kw_pat).is_some_and(|r| r.is_match(cmd))
        {
            return Some(cg.inline_reason.clone());
        }
    }

    for seg in split_cmd_segments(cmd) {
        let t = shlex_split(&seg);
        if t.is_empty() {
            continue;
        }
        for (pf_pat, pf_reason) in &cg.port_forward_rules {
            if regex_dyn_cached(pf_pat).is_some_and(|r| r.is_match(&seg)) {
                return Some(pf_reason.clone());
            }
        }
        if let Some(r) = check_wrapped_command(&t, depth, cg) {
            return Some(r);
        }
        let first = t
            .iter()
            .find(|x| !is_env_assign(x))
            .map(|x| basename(x))
            .unwrap_or("");
        // rg --pre / --hostname-bin run an external program: not read-only
        let disallow_readonly_skip = (first == "rg"
            && t.iter().any(|tok| {
                tok == "--pre"
                    || tok.starts_with("--pre=")
                    || tok == "--hostname-bin"
                    || tok.starts_with("--hostname-bin=")
            }))
            || (matches!(first, "man" | "ag")
                && t.iter().any(|tok| {
                    tok == "--pager"
                        || tok.starts_with("--pager=")
                        || (first == "man" && tok.starts_with("-P"))
                }))
            || (first == "find"
            && t.iter()
                .any(|tok| matches!(tok.as_str(), "-exec" | "-execdir" | "-ok" | "-okdir")))
            || (first == "git"
                && t.iter().any(|tok| {
                    tok == "-c"
                        || (tok.starts_with("-c") && !tok.starts_with("--") && tok.len() > 2)
                        || tok == "--exec-path"
                        || tok.starts_with("--exec-path=")
                        || tok == "--config-env"
                        || tok.starts_with("--config-env=")
                }));
        if disallow_readonly_skip || !cg.readonly_commands.contains(first) {
            if let Some(bp) = cg.backstop_pat.as_deref() {
                let any_tool = cg.backstop_tools.iter().any(|bt| has_ascii_ci(&seg, bt));
                if any_tool && regex_dyn_cached(bp).is_some_and(|r| r.is_match(&seg)) {
                    return Some(format!("{} trong lenh", cg.tool_reason));
                }
            }
        }
    }
    None
}

pub(super) fn split_cmd_segments(cmd: &str) -> Vec<String> {
    let chars: Vec<char> = cmd.chars().collect();
    let mut segs: Vec<String> = Vec::new();
    let mut cur = String::new();
    let mut quote: Option<char> = None;
    let mut stack: Vec<(String, char)> = Vec::new();
    let mut i = 0;

    while i < chars.len() {
        let c = chars[i];
        if let Some(q) = quote {
            if q == '"' && c == '\\' && i + 1 < chars.len() {
                cur.push(c);
                cur.push(chars[i + 1]);
                i += 2;
                continue;
            }
            if c == q {
                quote = None;
                cur.push(c);
                i += 1;
                continue;
            }
            if q == '"' && c == '$' && i + 1 < chars.len() && chars[i + 1] == '(' {
                stack.push((std::mem::take(&mut cur), '('));
                i += 2;
                continue;
            }
            if q == '"' && c == '`' {
                if stack.last().is_some_and(|(_, kind)| *kind == '`') {
                    segs.push(std::mem::take(&mut cur));
                    if let Some((outer, _)) = stack.pop() {
                        cur = outer;
                    }
                } else {
                    stack.push((std::mem::take(&mut cur), '`'));
                }
                i += 1;
                continue;
            }
            cur.push(c);
            i += 1;
            continue;
        }

        if c == '\\' && i + 1 < chars.len() {
            cur.push(c);
            cur.push(chars[i + 1]);
            i += 2;
        } else if c == '\'' || c == '"' {
            quote = Some(c);
            cur.push(c);
            i += 1;
        } else if c == '$' && i + 1 < chars.len() && chars[i + 1] == '(' {
            stack.push((std::mem::take(&mut cur), '('));
            i += 2;
        } else if c == '`' {
            if stack.last().is_some_and(|(_, kind)| *kind == '`') {
                segs.push(std::mem::take(&mut cur));
                if let Some((outer, _)) = stack.pop() {
                    cur = outer;
                }
            } else {
                stack.push((std::mem::take(&mut cur), '`'));
            }
            i += 1;
        } else if c == ')' && stack.last().is_some_and(|(_, kind)| *kind == '(') {
            segs.push(std::mem::take(&mut cur));
            if let Some((outer, _)) = stack.pop() {
                cur = outer;
            }
            i += 1;
        } else if c == ';' || c == '|' || c == '\n' || c == '(' || c == ')' {
            if c == '|' && i + 1 < chars.len() && chars[i + 1] == '|' {
                i += 1;
            }
            segs.push(std::mem::take(&mut cur));
            i += 1;
        } else if c == '&' {
            if i + 1 < chars.len() && chars[i + 1] == '&' {
                segs.push(std::mem::take(&mut cur));
                i += 2;
            } else {
                let prev_gt = i > 0 && chars[i - 1] == '>';
                let next_gt = i + 1 < chars.len() && chars[i + 1] == '>';
                if prev_gt || next_gt {
                    cur.push(c);
                } else {
                    segs.push(std::mem::take(&mut cur));
                }
                i += 1;
            }
        } else {
            cur.push(c);
            i += 1;
        }
    }
    segs.push(cur);
    while let Some((outer, _)) = stack.pop() {
        segs.push(outer);
    }
    segs
}

pub(super) fn check_wrapped_command(
    tokens: &[String],
    depth: usize,
    cg: &CompiledCommandGuard,
) -> Option<String> {
    if depth > 6 {
        return None;
    }
    let mut t = tokens.to_vec();
    let mut i = 0;

    while i < t.len() {
        let x = &t[i];
        let name = basename(x).to_string();
        if is_env_assign(x) {
            i += 1;
        } else if name == "env" {
            let mut k = i + 1;
            while k < t.len() {
                let tok = &t[k];
                if tok == "--" {
                    k += 1;
                    break;
                }
                if tok == "-S" || tok == "--split-string" {
                    if let Some(s) = t.get(k + 1) {
                        if let Some(hit) = check_command_guard_depth(s, cg, depth + 1) {
                            return Some(hit);
                        }
                        k += 2;
                        continue;
                    }
                    k += 1;
                    continue;
                }
                if let Some(s) = tok.strip_prefix("--split-string=") {
                    if let Some(hit) = check_command_guard_depth(s, cg, depth + 1) {
                        return Some(hit);
                    }
                    k += 1;
                    continue;
                }
                if val_flags_for("env").contains(&tok.as_str()) {
                    k = (k + 2).min(t.len());
                } else if tok.starts_with('-') {
                    k += 1;
                } else {
                    break;
                }
            }
            i = k;
        } else if matches!(
            name.as_str(),
            "sudo"
                | "nice"
                | "ionice"
                | "nohup"
                | "exec"
                | "time"
                | "command"
                | "builtin"
                | "npx"
                | "bunx"
                | "xargs"
        ) {
            i = skip_val_flags(&t, i + 1, val_flags_for(&name));
        } else if name == "timeout" {
            i = skip_val_flags(&t, i + 1, val_flags_for("timeout"));
            if i < t.len() && !t[i].starts_with('-') {
                i += 1; // duration argument
            }
        } else if name == "ssh" || name == "autossh" {
            i = skip_val_flags(&t, i + 1, val_flags_for("ssh")) + 1; // skip host
            if i < t.len() {
                let joined = t[i..].join(" ");
                if let Some(hit) = check_command_guard_depth(&joined, cg, depth + 1) {
                    return Some(hit);
                }
                if t.len() - i == 1 {
                    let expanded = shlex_split(&t[i]);
                    t.splice(i.., expanded);
                }
            }
        } else if matches!(name.as_str(), "sh" | "bash" | "zsh" | "dash" | "ksh") {
            let mut k = i + 1;
            while k < t.len() {
                let tok = &t[k];
                if tok == "--" {
                    break;
                }
                if tok == "-o" || tok == "+o" {
                    k += 2;
                    continue;
                }
                if is_shell_c_flag(tok) {
                    if let Some(script) = t.get(k + 1) {
                        return check_command_guard_depth(script, cg, depth + 1);
                    }
                    return None;
                }
                if !tok.starts_with('-') && !tok.starts_with('+') {
                    break;
                }
                k += 1;
            }
            break;
        } else if matches!(
            name.as_str(),
            "docker" | "podman" | "docker-compose" | "kubectl"
        ) {
            let mut rest_idx = i + 1;
            if t.get(rest_idx).is_some_and(|s| s == "compose") {
                rest_idx += 1;
            }
            if t.get(rest_idx).map(String::as_str) != Some("exec") {
                return None;
            }
            if name == "kubectl" {
                let dd = t[rest_idx..].iter().position(|s| s == "--")?;
                i = rest_idx + dd + 1;
            } else {
                i = skip_val_flags(&t, rest_idx + 1, val_flags_for("exec")) + 1;
            }
        } else {
            break;
        }
    }

    if i >= t.len() {
        return None;
    }
    let name = basename(&t[i]);
    if cg.kill_tools.contains(name)
        && !cg.kill_arg_contains.is_empty()
        && t[i + 1..].iter().any(|a| a.contains(&cg.kill_arg_contains))
    {
        return Some(cg.kill_reason.clone());
    }
    if let Some(da) = cg.allow_daemons.as_ref() {
        if name == da.command {
            return if daemon_is_allowed(&t[i..], da) {
                None
            } else {
                Some(da.deny_reason.clone())
            };
        }
    }
    if name == "find" {
        let mut k = i + 1;
        while k < t.len() {
            if matches!(t[k].as_str(), "-exec" | "-execdir" | "-ok" | "-okdir") {
                let start = k + 1;
                let end = t[start..]
                    .iter()
                    .position(|tok| tok == ";" || tok == "+")
                    .map_or(t.len(), |p| start + p);
                if start < end {
                    if let Some(hit) = check_wrapped_command(&t[start..end], depth + 1, cg) {
                        return Some(hit);
                    }
                }
                k = end + 1;
            } else {
                k += 1;
            }
        }
    }
    if name == "git" {
        let mut k = i + 1;
        while k < t.len() {
            let tok = &t[k];
            let val = if tok == "-c" || tok == "--config-env" {
                k += 1;
                t.get(k).map(String::as_str)
            } else if let Some(rest) = tok.strip_prefix("-c").filter(|r| !r.is_empty() && !tok.starts_with("--")) {
                Some(rest)
            } else {
                tok.strip_prefix("--config-env=")
            };
            if let Some(kv) = val {
                if let Some((_, rhs)) = kv.split_once('=') {
                    if let Some(bang) = rhs.strip_prefix('!') {
                        if let Some(hit) = check_command_guard_depth(bang, cg, depth + 1) {
                            return Some(hit);
                        }
                    }
                }
            }
            k += 1;
        }
    }
    if cg.tools.contains(name) {
        return Some(format!("{} {name}", cg.tool_reason));
    }
    None
}

pub(super) fn daemon_is_allowed(tokens: &[String], da: &DaemonAllowSpec) -> bool {
    let mut port: Option<&str> = None;
    let mut data_path: Option<&str> = None;
    let mut idx = 0;
    while idx < tokens.len() {
        let tok = &tokens[idx];
        if tok == "--port" {
            if let Some(next) = tokens.get(idx + 1) {
                port = Some(next.as_str());
                idx += 1;
            }
        } else if let Some(val) = tok.strip_prefix("--port=") {
            port = Some(val);
        } else if *tok == da.path_flag {
            if let Some(next) = tokens.get(idx + 1) {
                data_path = Some(next.as_str());
                idx += 1;
            }
        } else if let Some(val) = tok
            .strip_prefix(da.path_flag.as_str())
            .and_then(|r| r.strip_prefix('='))
        {
            data_path = Some(val);
        }
        idx += 1;
    }
    if port != Some(da.required_port.as_str()) {
        return false;
    }
    let Some(raw_path) = data_path else {
        return false;
    };
    let allowed_raw = da
        .allowed_paths_env
        .as_deref()
        .and_then(|k| env::var(k).ok())
        .filter(|v| !v.trim().is_empty())
        .or_else(|| da.allowed_paths.clone());
    let Some(allowed) = allowed_raw else {
        return false;
    };
    let base = normalize_slashes(&lexical_path(Path::new("/"), &allowed).to_string_lossy());
    let p = normalize_slashes(&lexical_path(Path::new("/"), raw_path).to_string_lossy());
    is_inside_posix(&p, &base)
}

pub(super) fn skip_val_flags(t: &[String], mut i: usize, vals: &[&str]) -> usize {
    while i < t.len() && t[i].starts_with('-') {
        if t[i] == "--" {
            i += 1;
            break;
        }
        if vals.contains(&t[i].as_str()) {
            i = (i + 2).min(t.len());
        } else {
            i += 1;
        }
    }
    i
}

pub(super) fn val_flags_for(name: &str) -> &'static [&'static str] {
    match name {
        "sudo" => &[
            "-u", "-g", "-h", "-p", "-C", "-D", "-R", "-T", "-U", "--user", "--group", "--host",
            "--prompt", "--close-from", "--chdir", "--chroot", "--command-timeout", "--other-user",
        ],
        "env" => &[
            "-u", "--unset", "-C", "--chdir", "-S", "--split-string", "-a", "--argv0",
        ],
        "timeout" => &["-s", "-k", "--signal", "--kill-after"],
        "nice" => &["-n", "--adjustment"],
        "ionice" => &[
            "-c", "-n", "-p", "-P", "-u", "--class", "--classdata", "--pid", "--pgid", "--uid",
        ],
        "time" => &["-f", "-o", "--format", "--output"],
        "xargs" => &["-n", "-I", "-P", "-L", "-d", "-E", "-s", "-a"],
        "ssh" => &[
            "-p", "-i", "-l", "-o", "-L", "-J", "-F", "-b", "-c", "-D", "-E", "-e", "-O", "-R",
            "-S", "-W", "-w",
        ],
        "exec" => &["-a", "-e", "-u", "-w", "--env", "--user", "--workdir", "-c"],
        _ => &[],
    }
}

