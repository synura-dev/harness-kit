use super::*;

// ============================================================================
// Declarative Shell Rules (memories-guard, worktree-script, mongo-guard)
// ============================================================================

pub(super) fn lexical_norm_path_chunk(chunk: &str) -> String {
    if !chunk.contains('/') {
        return chunk.to_string();
    }
    let is_abs = chunk.starts_with('/');
    let mut stack: Vec<&str> = Vec::new();
    for seg in chunk.split('/') {
        match seg {
            "" | "." => {}
            ".." => {
                if let Some(&top) = stack.last() {
                    if top != ".." {
                        stack.pop();
                    } else if !is_abs {
                        stack.push("..");
                    }
                } else if !is_abs {
                    stack.push("..");
                }
            }
            other => stack.push(other),
        }
    }
    if stack.is_empty() {
        if is_abs {
            "/".to_string()
        } else {
            ".".to_string()
        }
    } else if is_abs {
        format!("/{}", stack.join("/"))
    } else {
        stack.join("/")
    }
}

/// Unquoted `\x` -> `x` (shell escape removal) except escaped whitespace, which stays so
/// tokenization is unchanged. Guards run on both the raw and this form, so `memo\ries`
/// is seen as `memories` while Windows `C:\a\b` is still checked raw.
pub(super) fn unescape_shell_bs(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut quote: Option<char> = None;
    let mut it = s.chars().peekable();
    while let Some(c) = it.next() {
        match quote {
            Some(q) => {
                if c == q {
                    quote = None;
                }
            }
            None if c == '\'' || c == '"' => quote = Some(c),
            None if c == '\\' => {
                if let Some(&n) = it.peek() {
                    if !n.is_whitespace() {
                        out.push(n);
                        it.next();
                        continue;
                    }
                }
            }
            None => {}
        }
        out.push(c);
    }
    out
}

pub(super) fn plain_norm(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut chunk = String::new();
    let mut quote: Option<char> = None;

    let flush_chunk = |chunk: &mut String, out: &mut String| {
        if chunk.is_empty() {
            return;
        }
        let mut t = chunk.replace('\\', "/");
        while t.contains("//") {
            t = t.replace("//", "/");
        }
        out.push_str(&lexical_norm_path_chunk(&t));
        chunk.clear();
    };

    for ch in s.chars() {
        if let Some(q) = quote {
            if ch == q {
                quote = None;
            } else {
                chunk.push(ch);
            }
            continue;
        }
        if ch == '\'' || ch == '"' {
            quote = Some(ch);
        } else if ch.is_whitespace()
            || matches!(ch, ';' | '|' | '&' | '>' | '<' | '(' | ')' | '=')
        {
            flush_chunk(&mut chunk, &mut out);
            out.push(ch);
        } else {
            chunk.push(ch);
        }
    }
    flush_chunk(&mut chunk, &mut out);
    out
}

pub(super) fn split_shell_segments(cmd: &str) -> Vec<String> {
    let chars: Vec<char> = cmd.chars().collect();
    let mut segs: Vec<String> = Vec::new();
    let mut cur = String::new();
    let mut quote: Option<char> = None;
    let mut stack: Vec<(String, char)> = Vec::new();
    let mut i = 0;

    let push_seg = |segs: &mut Vec<String>, cur: &mut String| -> Option<String> {
        let s = std::mem::take(cur);
        let hdoc = regex_cached(
            r#"^\s*(?:\w+=\S*\s+)*(?:timeout\s+\S+\s+|nice\s+(?:-n\s*\d+\s+)?)*git\s[^\n]*<<-?\s*['"]?(\w+)"#,
        )
        .and_then(|r| r.captures(&s))
        .and_then(|c| c.get(1).map(|m| m.as_str().to_string()));
        segs.push(s);
        hdoc
    };

    while i < chars.len() {
        let c = chars[i];
        if let Some(q) = quote {
            if c == q {
                quote = None;
                cur.push(c);
                i += 1;
                continue;
            }
            // Inside double quotes, $(...) and `...` STILL execute!
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

        if c == '\'' || c == '"' {
            quote = Some(c);
            cur.push(c);
            i += 1;
        } else if c == '\n' {
            let heredoc = push_seg(&mut segs, &mut cur);
            i += 1;
            if let Some(tag) = heredoc {
                let rest: String = chars[i..].iter().collect();
                if let Some(idx) = find_heredoc_end(&rest, &tag) {
                    i += rest[..idx].chars().count();
                } else {
                    i = chars.len();
                }
            }
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
        } else if c == ';' || c == '|' || c == ')' {
            if c == '|' && i + 1 < chars.len() && chars[i + 1] == '|' {
                i += 1;
            }
            let _ = push_seg(&mut segs, &mut cur);
            i += 1;
        } else if c == '&' {
            if i + 1 < chars.len() && chars[i + 1] == '&' {
                i += 2;
                let _ = push_seg(&mut segs, &mut cur);
            } else {
                let prev_gt = i > 0 && chars[i - 1] == '>';
                let next_gt = i + 1 < chars.len() && chars[i + 1] == '>';
                if prev_gt || next_gt {
                    cur.push(c);
                } else {
                    let _ = push_seg(&mut segs, &mut cur);
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

pub(super) fn find_heredoc_end(rest: &str, tag: &str) -> Option<usize> {
    let mut offset = 0;
    for line in rest.split_inclusive('\n') {
        offset += line.len();
        if line.trim() == tag {
            return Some(offset);
        }
    }
    None
}

pub(super) fn extract_command_subs(c: &str) -> Vec<String> {
    let bytes = c.as_bytes();
    let mut out = Vec::new();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'$' && i + 1 < bytes.len() && bytes[i + 1] == b'(' {
            let mut d = 1usize;
            let mut j = i + 2;
            while j < bytes.len() && d > 0 {
                if bytes[j] == b'(' {
                    d += 1;
                } else if bytes[j] == b')' {
                    d -= 1;
                }
                j += 1;
            }
            let end = if d == 0 { j - 1 } else { j };
            out.push(c[i + 2..end].to_string());
            i = j;
        } else if bytes[i] == b'`' {
            let j = c[i + 1..].find('`').map_or(bytes.len(), |p| i + 1 + p);
            out.push(c[i + 1..j].to_string());
            i = j + 1;
        } else {
            i += 1;
        }
    }
    out
}

pub(super) fn shell_tokens(seg: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut in_tok = false;
    let mut q: Option<char> = None;
    let mut chars = seg.chars().peekable();

    while let Some(c) = chars.next() {
        if let Some(quote) = q {
            if c == quote {
                q = None;
            } else if quote == '"' && c == '\\' {
                if let Some(&next) = chars.peek() {
                    if matches!(next, '"' | '\\' | '$' | '`') {
                        cur.push(next);
                        chars.next();
                    } else {
                        cur.push(c);
                    }
                } else {
                    cur.push(c);
                }
            } else {
                cur.push(c);
            }
            in_tok = true;
        } else if c == '\'' || c == '"' {
            q = Some(c);
            in_tok = true;
        } else if c == '\\' {
            if let Some(&next) = chars.peek() {
                if next.is_whitespace() || matches!(next, '\'' | '"' | '\\' | '$' | '`') {
                    cur.push(next);
                    chars.next();
                } else {
                    cur.push(c);
                }
                in_tok = true;
            }
        } else if c.is_whitespace() {
            if in_tok {
                out.push(std::mem::take(&mut cur));
                in_tok = false;
            }
        } else {
            cur.push(c);
            in_tok = true;
        }
    }
    if q.is_some() {
        return seg
            .split_whitespace()
            .map(|t| t.trim_matches(['"', '\'']).to_string())
            .collect();
    }
    if in_tok {
        out.push(cur);
    }
    out
}

pub(super) fn is_shell_c_flag(tok: &str) -> bool {
    tok.starts_with('-')
        && !tok.starts_with("--")
        && tok.len() >= 2
        && tok[1..].chars().all(|ch| ch.is_ascii_alphabetic())
        && tok[1..].contains('c')
}

pub(super) struct UnwrappedPrefix {
    pub(super) rest: Vec<String>,
    pub(super) env_assigns: Vec<(String, String)>,
    pub(super) env_scripts: Vec<String>,
    pub(super) had_env_or_assign: bool,
}

pub(super) fn unwrap_shell_prefix(toks: &[String]) -> UnwrappedPrefix {
    let mut t = toks.to_vec();
    let mut env_assigns = Vec::new();
    let mut env_scripts = Vec::new();
    let mut had_env_or_assign = false;

    for _ in 0..32 {
        let Some(first) = t.first().cloned() else {
            break;
        };
        if is_env_assign(&first) {
            had_env_or_assign = true;
            if let Some((k, v)) = first.split_once('=') {
                env_assigns.push((k.to_string(), v.to_string()));
            }
            t.remove(0);
            continue;
        }
        let base = basename(&first).to_string();
        match base.as_str() {
            "command" | "builtin" | "nohup" => {
                t.remove(0);
                while let Some(arg) = t.first() {
                    if arg == "--" {
                        t.remove(0);
                        break;
                    }
                    if arg.starts_with('-') {
                        t.remove(0);
                    } else {
                        break;
                    }
                }
            }
            "env" => {
                had_env_or_assign = true;
                t.remove(0);
                while let Some(arg) = t.first().cloned() {
                    if arg == "--" {
                        t.remove(0);
                        break;
                    }
                    if matches!(
                        arg.as_str(),
                        "-u" | "--unset" | "-C" | "--chdir" | "-a" | "--argv0"
                    ) {
                        t.remove(0);
                        if !t.is_empty() {
                            t.remove(0);
                        }
                    } else if arg == "-S" || arg == "--split-string" {
                        t.remove(0);
                        if !t.is_empty() {
                            env_scripts.push(t.remove(0));
                        }
                    } else if let Some(s) = arg.strip_prefix("--split-string=") {
                        env_scripts.push(s.to_string());
                        t.remove(0);
                    } else if arg.starts_with('-') {
                        t.remove(0);
                    } else if is_env_assign(&arg) {
                        if let Some((k, v)) = arg.split_once('=') {
                            env_assigns.push((k.to_string(), v.to_string()));
                        }
                        t.remove(0);
                    } else {
                        break;
                    }
                }
            }
            "sudo" => {
                t.remove(0);
                let mut i = skip_val_flags(&t, 0, val_flags_for("sudo"));
                i = i.min(t.len());
                t.drain(..i);
            }
            "timeout" => {
                t.remove(0);
                let mut i = skip_val_flags(&t, 0, val_flags_for("timeout"));
                if i < t.len() && !t[i].starts_with('-') {
                    i += 1; // duration argument
                }
                i = i.min(t.len());
                t.drain(..i);
            }
            "nice" | "ionice" | "time" | "exec" => {
                t.remove(0);
                let mut i = skip_val_flags(&t, 0, val_flags_for(&base));
                i = i.min(t.len());
                t.drain(..i);
            }
            _ => break,
        }
    }

    UnwrappedPrefix {
        rest: t,
        env_assigns,
        env_scripts,
        had_env_or_assign,
    }
}

pub(super) fn is_forbidden_runtime_flag(arg: &str) -> bool {
    if matches!(
        arg,
        "-e" | "-p"
            | "-pe"
            | "-ep"
            | "--eval"
            | "--print"
            | "-r"
            | "--require"
            | "--import"
            | "--preload"
            | "--loader"
            | "--experimental-loader"
            | "-c"
            | "--check"
    ) {
        return true;
    }
    if arg.starts_with("--eval=")
        || arg.starts_with("--print=")
        || arg.starts_with("--require=")
        || arg.starts_with("--import=")
        || arg.starts_with("--preload=")
        || arg.starts_with("--loader=")
        || arg.starts_with("--experimental-loader=")
    {
        return true;
    }
    arg.starts_with('-')
        && !arg.starts_with("--")
        && arg.len() >= 2
        && arg[1..].chars().all(|c| c.is_ascii_alphabetic())
        && (arg[1..].contains('e') || arg[1..].contains('p'))
}

pub(super) fn extract_runtime_main_script(cmd_base: &str, args: &[String]) -> Option<String> {
    let runtime = cmd_base.strip_suffix(".exe").unwrap_or(cmd_base);
    if !matches!(runtime, "node" | "bun" | "deno") {
        return None;
    }
    if args.iter().any(|a| {
        matches!(a.as_str(), "--eval" | "--print" | "-pe" | "-ep")
            || a.starts_with("--eval=")
            || a.starts_with("--print=")
    }) {
        return None;
    }

    let mut seen_run = false;
    let mut after_double_dash = false;
    for arg in args {
        if after_double_dash {
            return Some(arg.clone());
        }
        if arg == "--" {
            after_double_dash = true;
            continue;
        }
        if arg.starts_with('-') {
            if is_forbidden_runtime_flag(arg) {
                return None;
            }
            // Known safe runtime value-less flags or --flag=val are skipped;
            // unknown separate-arg value flags aren't skipped blindly so extra args can't spoof script.
            continue;
        }
        if !seen_run && matches!(runtime, "bun" | "deno") && arg == "run" {
            seen_run = true;
            continue;
        }
        if runtime == "deno" && arg == "eval" {
            return None;
        }
        return Some(arg.clone());
    }
    None
}

pub(super) fn token_path_candidates(cur_cwd: &Path, raw_tok: &str) -> Vec<String> {
    let mut out = Vec::new();
    let stripped = raw_tok.trim_matches(['"', '\'']);
    if stripped.is_empty() {
        return out;
    }
    out.push(plain_norm(stripped));
    for res in resolve_posix_and_real(cur_cwd, stripped) {
        if !out.contains(&res) {
            out.push(res);
        }
    }
    if let Some((_, val)) = stripped.split_once('=') {
        if !val.is_empty() {
            let pv = plain_norm(val);
            if !out.contains(&pv) {
                out.push(pv);
            }
            for res in resolve_posix_and_real(cur_cwd, val) {
                if !out.contains(&res) {
                    out.push(res);
                }
            }
        }
    }
    out
}

pub(super) fn shlex_split(s: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut in_tok = false;
    let mut q: Option<char> = None;
    let mut chars = s.chars().peekable();

    while let Some(c) = chars.next() {
        if let Some(quote) = q {
            if c == quote {
                q = None;
            } else if quote == '"' && c == '\\' {
                if let Some(&next) = chars.peek() {
                    if matches!(next, '"' | '\\' | '$' | '`') {
                        cur.push(next);
                        chars.next();
                    } else {
                        cur.push(c);
                    }
                } else {
                    cur.push(c);
                }
            } else {
                cur.push(c);
            }
            in_tok = true;
        } else if c == '\'' || c == '"' {
            q = Some(c);
            in_tok = true;
        } else if c == '\\' {
            if let Some(next) = chars.next() {
                cur.push(next);
                in_tok = true;
            }
        } else if c.is_whitespace() {
            if in_tok {
                out.push(std::mem::take(&mut cur));
                in_tok = false;
            }
        } else {
            cur.push(c);
            in_tok = true;
        }
    }
    if q.is_some() {
        // Fallback to whitespace split on unclosed quotes (matches mongo-guard.py)
        return s.split_whitespace().map(ToString::to_string).collect();
    }
    if in_tok {
        out.push(cur);
    }
    out
}

pub(super) fn is_env_assign(s: &str) -> bool {
    let Some((k, _)) = s.split_once('=') else {
        return false;
    };
    !k.is_empty() && k.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
}

pub(super) fn basename(p: &str) -> &str {
    p.rsplit(['/', '\\']).next().unwrap_or(p)
}

pub(super) fn collapse_line_continuations(cmd: &str) -> String {
    regex_cached(r"\\\r?\n|`\r?\n")
        .map(|r| r.replace_all(cmd, " ").into_owned())
        .unwrap_or_else(|| cmd.to_string())
}

pub(super) fn has_word(haystack: &str, word: &str) -> bool {
    let hb = haystack.as_bytes();
    let mut start = 0;
    while let Some(pos) = haystack[start..].find(word) {
        let abs = start + pos;
        let left = abs == 0 || !hb[abs - 1].is_ascii_alphanumeric();
        let right = abs + word.len();
        let right_ok = right >= hb.len() || !hb[right].is_ascii_alphanumeric();
        if left && right_ok {
            return true;
        }
        start = abs
            + haystack[abs..]
                .chars()
                .next()
                .map(|c| c.len_utf8())
                .unwrap_or(1);
    }
    false
}

/// Scan `git` args (after the `git` token) for options that can run external code:
/// `-c k=v`, `-ck=v`, `--config-env`, `--exec-path`. Returns (unsafe, nested scripts):
/// every `-c` value (alias `!cmd` with the `!` stripped, core.pager/editor/sshCommand, ...)
/// is returned so the caller can scan it recursively like a nested shell.
pub(super) fn git_exec_scan(args: &[String]) -> (bool, Vec<String>) {
    let mut unsafe_flag = false;
    let mut scripts = Vec::new();
    let mut k = 0;
    while k < args.len() {
        let tok = &args[k];
        let val = if tok == "-c" || tok == "--config-env" {
            unsafe_flag = true;
            k += 1;
            args.get(k).map(String::as_str)
        } else if let Some(rest) = tok.strip_prefix("--config-env=") {
            unsafe_flag = true;
            Some(rest)
        } else if tok == "--exec-path" || tok.starts_with("--exec-path=") {
            unsafe_flag = true;
            None
        } else if let Some(rest) = tok
            .strip_prefix("-c")
            .filter(|r| !r.is_empty() && !tok.starts_with("--"))
        {
            unsafe_flag = true;
            Some(rest)
        } else {
            None
        };
        if let Some((_, rhs)) = val.and_then(|kv| kv.split_once('=')) {
            scripts.push(rhs.strip_prefix('!').unwrap_or(rhs).to_string());
        }
        k += 1;
    }
    (unsafe_flag, scripts)
}

/// git is trusted (skips the mention check) only for plain read/commit-style use:
/// no env assigns, real binary path, global options from a small allowlist, and a
/// subcommand that cannot run user-supplied commands. Anything else is scanned normally.
pub(super) fn git_is_trusted(toks: &[String], env_assigns: &[(String, String)]) -> bool {
    if !matches!(
        toks.first().map(String::as_str),
        Some("git" | "/usr/bin/git" | "/bin/git" | "/usr/local/bin/git")
    ) || env_assigns.iter().any(|(k, _)| {
        !matches!(
            k.as_str(),
            "GIT_OPTIONAL_LOCKS" | "GIT_TERMINAL_PROMPT" | "LC_ALL" | "LANG" | "TZ"
        )
    }) {
        return false;
    }
    let mut i = 1;
    while i < toks.len() && toks[i].starts_with('-') {
        match toks[i].as_str() {
            "-C" => i += 2,
            "-c" => {
                let Some(kv) = toks.get(i + 1) else {
                    return false;
                };
                let key = kv.split('=').next().unwrap_or("").to_ascii_lowercase();
                let ok = matches!(
                    key.as_str(),
                    "safe.directory"
                        | "core.quotepath"
                        | "core.autocrlf"
                        | "core.safecrlf"
                        | "init.defaultbranch"
                ) || ["user.", "color.", "advice."]
                    .iter()
                    .any(|p| key.starts_with(p));
                if !ok {
                    return false;
                }
                i += 2;
            }
            "--no-pager" | "--no-optional-locks" => i += 1,
            _ => return false,
        }
    }
    // Subcommand allowlist: anything not listed (rebase, fetch, clone, submodule, grep,
    // difftool, bisect, ...) may run user-supplied commands via abbreviated flags.
    let Some(sub) = toks.get(i).map(String::as_str) else {
        return true;
    };
    let rest = toks.get(i + 1..).unwrap_or(&[]);
    match sub {
        "status" | "log" | "diff" | "show" | "add" | "commit" | "switch" | "checkout"
        | "restore" | "branch" | "tag" | "merge" | "stash" | "reset" | "rm" | "mv"
        | "ls-files" | "ls-tree" | "rev-parse" | "rev-list" | "worktree" | "blame"
        | "cat-file" | "describe" | "shortlog" | "reflog" => true,
        "config" => {
            rest.iter()
                .any(|a| matches!(a.as_str(), "--get" | "--get-all" | "--list" | "-l"))
                && !rest.iter().any(|a| {
                    ["--file", "-f", "--add", "--unset", "--replace", "--edit", "-e", "--blob"]
                        .iter()
                        .any(|p| a.starts_with(p))
                })
        }
        _ => false,
    }
}

/// Env assignments that make git run a command (GIT_PAGER, GIT_SSH_COMMAND, ...).
pub(super) fn git_env_exec_scripts(assigns: &[(String, String)]) -> (bool, Vec<String>) {
    let mut unsafe_flag = false;
    let mut scripts = Vec::new();
    for (k, v) in assigns {
        let k = k.to_ascii_uppercase();
        if matches!(
            k.as_str(),
            "GIT_PAGER"
                | "GIT_EDITOR"
                | "GIT_SEQUENCE_EDITOR"
                | "GIT_SSH"
                | "GIT_SSH_COMMAND"
                | "GIT_EXTERNAL_DIFF"
                | "GIT_ASKPASS"
                | "GIT_PROXY_COMMAND"
                | "GIT_EXEC_PATH"
        ) || k.starts_with("GIT_CONFIG")
        {
            unsafe_flag = true;
            scripts.push(v.clone());
        }
    }
    (unsafe_flag, scripts)
}

