use super::*;

pub(super) fn extract_tool_paths(tool: &str, ti: &Value) -> Vec<String> {
    let mut out = Vec::new();
    match tool {
        "Read" | "Write" | "Edit" | "MultiEdit" | "NotebookEdit" => {
            if let Some(p) = ti
                .get("file_path")
                .or_else(|| ti.get("notebook_path"))
                .or_else(|| ti.get("path"))
                .and_then(Value::as_str)
            {
                if !p.is_empty() {
                    out.push(p.to_string());
                }
            }
        }
        "Grep" | "Glob" => {
            if let Some(p) = ti.get("path").and_then(Value::as_str) {
                if !p.is_empty() {
                    out.push(p.to_string());
                }
            }
            let pat_key = if tool == "Glob" { "pattern" } else { "glob" };
            if let Some(g) = ti.get(pat_key).and_then(Value::as_str) {
                let base = glob_base(g);
                if !base.is_empty() {
                    out.push(base.to_string());
                }
            }
        }
        _ => {}
    }
    out
}

pub(super) fn collect_arg_strings(v: &Value, key: &str, out: &mut Vec<(String, String)>) {
    match v {
        Value::String(s) => out.push((key.to_string(), s.clone())),
        Value::Array(arr) => {
            for item in arr {
                collect_arg_strings(item, key, out);
            }
        }
        Value::Object(map) => {
            for (k, val) in map {
                collect_arg_strings(val, k, out);
            }
        }
        _ => {}
    }
}

// ============================================================================
// Core Guard (guard/hook.mjs)
// ============================================================================

pub(super) fn eval_core_guard(
    input: &HookInput,
    protected_paths: &[String],
    sensitive_names: &[String],
    claude_web: Option<&str>,
    audit_root: &Path,
    tool_cwd: &Path,
) -> Option<(String, String)> {
    let tool = input.tool_name.as_deref()?;
    if let (Some(reason), Host::Claude, "WebSearch" | "WebFetch") = (claude_web, input.host, tool) {
        return Some(("claude-web".to_string(), reason.to_string()));
    }

    if matches!(tool, "Write" | "Edit" | "MultiEdit" | "NotebookEdit") {
        let fp = input
            .tool_input
            .get("file_path")
            .or_else(|| input.tool_input.get("notebook_path"))
            .and_then(Value::as_str)
            .unwrap_or("");
        if !fp.is_empty() {
            let np = fp.replace('\\', "/");
            if is_rules_file(&np) {
                return Some(("rules-protect".to_string(), RULES_PROTECT_REASON.to_string()));
            }
            if in_audit_root(&np, audit_root, tool_cwd) {
                return Some(("audit-protect".to_string(), AUDIT_PROTECT_REASON.to_string()));
            }
            if is_launcher_file(&np) {
                return Some((
                    "launcher-protect".to_string(),
                    "guard[launcher-protect]: Cam sua launcher bin/harness.mjs va config/launcher.local.json (co the tro sang plugin gia); chi nguoi dung sua. / Launcher files are protected; the human edits them.".to_string(),
                ));
            }
            if is_plugin_file(&np) {
                return Some((
                    "launcher-protect".to_string(),
                    "guard[launcher-protect]: Cam sua so dang ky plugin (installed_plugins.json/known_marketplaces.json) va thu muc plugin guard; chi nguoi dung sua (claude plugin ...). / Plugin registry and guard plugin files are protected; the human changes them.".to_string(),
                ));
            }
            if hit_protected_path(fp, protected_paths) {
                return Some((
                    "protected-path".to_string(),
                    "guard[protected-path]: Duong dan duoc bao ve (guard protectedPaths): khong doc/ghi truc tiep. / Protected path: raw shell/file access is blocked.".to_string(),
                ));
            }
        }
        return None;
    }

    if matches!(tool, "Read" | "Grep" | "Glob") {
        for key in ["file_path", "path", "pattern", "glob"] {
            if let Some(s) = input.tool_input.get(key).and_then(Value::as_str) {
                if !s.is_empty() && hit_protected_path(s, protected_paths) {
                    return Some((
                        "protected-path".to_string(),
                        "guard[protected-path]: Duong dan duoc bao ve (guard protectedPaths): khong doc/ghi truc tiep. / Protected path: raw shell/file access is blocked.".to_string(),
                    ));
                }
            }
        }
        return None;
    }

    if tool == "Bash" || tool == "PowerShell" {
        let cmd = input
            .tool_input
            .get("command")
            .and_then(Value::as_str)
            .unwrap_or("");
        if cmd.trim().is_empty() {
            return None;
        }
        if cmd.chars().count() > MAX_COMMAND_CHARS {
            return Some((
                "command-too-long".to_string(),
                "guard[command-too-long]: Lenh qua dai (> maxCommandChars), khong the kiem; chia nho. / Command too long to inspect; split it.".to_string(),
            ));
        }
        if is_launcher_write_cmd(cmd) {
            return Some((
                "launcher-protect".to_string(),
                "guard[launcher-protect]: Cam sua launcher bin/harness.mjs va config/launcher.local.json (co the tro sang plugin gia); chi nguoi dung sua. / Launcher files are protected; the human edits them.".to_string(),
            ));
        }
        if is_plugin_write_cmd(cmd) {
            return Some((
                "launcher-protect".to_string(),
                "guard[launcher-protect]: Cam sua so dang ky plugin (installed_plugins.json/known_marketplaces.json) va thu muc plugin guard; chi nguoi dung sua (claude plugin ...). / Plugin registry and guard plugin files are protected; the human changes them.".to_string(),
            ));
        }
        let ncmd = collapse_line_continuations(cmd);
        if bash_touches_audit(&ncmd, audit_root, tool_cwd, 0) {
            return Some(("audit-protect".to_string(), AUDIT_PROTECT_REASON.to_string()));
        }
        if hit_protected_path(&ncmd, protected_paths) {
            return Some((
                "protected-path".to_string(),
                "guard[protected-path]: Duong dan duoc bao ve (guard protectedPaths): khong doc/ghi truc tiep. / Protected path: raw shell/file access is blocked.".to_string(),
            ));
        }
        if is_config_dump(&ncmd, cmd, sensitive_names) {
            return Some((
                "config-dump".to_string(),
                "guard[config-dump]: Cam in noi dung file cau hinh/bi mat (.env, khoa, credential...). Dung sha256sum/wc/grep -n co gioi han. / Config/secret dump blocked; use sha256sum, wc, bounded grep -n.".to_string(),
            ));
        }
    }

    None
}

pub(super) fn is_launcher_file(np: &str) -> bool {
    let l = np.to_ascii_lowercase();
    l == "bin/harness.mjs"
        || l.ends_with("/bin/harness.mjs")
        || l == "config/launcher.local.json"
        || l.ends_with("/config/launcher.local.json")
}

pub(super) fn is_plugin_file(np: &str) -> bool {
    let re = regex_cached(
        r"(?i)(?:^|/)\.claude/plugins/(?:(?:installed_plugins|known_marketplaces)\.json$|(?:cache|marketplaces)/(?:[^/]+/)*[^/]*(?:harness-kit|agent-guard-kit|harness-plugin)[^/]*(?:/|$))",
    );
    re.is_some_and(|r| r.is_match(np))
}

pub(super) fn is_readonly_cmd(cmd: &str) -> bool {
    if cmd
        .chars()
        .any(|c| matches!(c, ';' | '&' | '<' | '>' | '`' | '\n'))
        || cmd.contains("$(")
    {
        return false;
    }
    let seg_re = regex_cached(
        r"(?i)^\s*(?:git\s+(?:-c\s+\S+\s+)*(?:diff|log|show|blame|grep|status)|cat|rg|grep|egrep|fgrep|head|tail|less|more|type|Get-Content|gc|wc|ls|Select-String|sls|sort|uniq|nl)\b",
    );
    cmd.split('|')
        .all(|s| seg_re.is_some_and(|r| r.is_match(s)))
}

pub(super) fn has_ascii_ci(haystack: &str, needle: &str) -> bool {
    let nb = needle.as_bytes();
    if nb.is_empty() || haystack.len() < nb.len() {
        return false;
    }
    haystack
        .as_bytes()
        .windows(nb.len())
        .any(|w| w.eq_ignore_ascii_case(nb))
}

pub(super) fn is_launcher_write_cmd(cmd: &str) -> bool {
    if !has_ascii_ci(cmd, "harness.mjs") && !has_ascii_ci(cmd, "launcher.local.json") {
        return false;
    }
    let hit = regex_cached(
        r#"(?i)\b(?:rm|del|erase|mv|move|ren|rename|cp|copy|tee|truncate|ln|sed\s+-i\S*|perl\s+-p?i\S*|Set-Content|Add-Content|Out-File|Remove-Item|Move-Item|Copy-Item|Rename-Item|New-Item|Clear-Content|git\s+(?:checkout|restore|rm|mv|apply|stash))\b[^\n;|&]*?(?:bin[\\/]harness\.mjs|launcher\.local\.json)|>>?\s*["']?[^\s"']*(?:bin[\\/]harness\.mjs|launcher\.local\.json)|launcher\.local\.json|(?:writeFile|appendFile|rename|unlink|copyFile)(?:Sync)?\s*\([^)]*bin[\\/]harness\.mjs"#,
    )
    .is_some_and(|r| r.is_match(cmd));
    if !hit {
        return false;
    }
    let out_flag = regex_cached(r"(?i)\s(?:-o|--output)(?:[\s=]|$)")
        .is_some_and(|r| r.is_match(cmd));
    !(is_readonly_cmd(cmd) && !out_flag)
}

pub(super) fn is_plugin_write_cmd(cmd: &str) -> bool {
    if !has_ascii_ci(cmd, "installed_plugins.json")
        && !has_ascii_ci(cmd, "known_marketplaces.json")
        && !has_ascii_ci(cmd, "harness-kit")
        && !has_ascii_ci(cmd, "agent-guard-kit")
        && !has_ascii_ci(cmd, "harness-plugin")
    {
        return false;
    }
    regex_cached(
        r#"(?i)\b(?:rm|del|erase|mv|move|ren|rename|cp|copy|tee|truncate|ln|sed\s+-i\S*|perl\s+-p?i\S*|Set-Content|Add-Content|Out-File|Remove-Item|Move-Item|Copy-Item|Rename-Item|New-Item|Clear-Content|git\s+(?:checkout|restore|rm|mv|apply|stash))\b[^\n;|&]*?\.claude[\\/]+plugins[\\/]+(?:(?:installed_plugins|known_marketplaces)\.json|(?:cache|marketplaces)[\\/]+[^\s"';|&]*?(?:harness-kit|agent-guard-kit|harness-plugin))|>>?\s*["']?[^\s"']*\.claude[\\/]+plugins[\\/]+(?:(?:installed_plugins|known_marketplaces)\.json|(?:cache|marketplaces)[\\/]+[^\s"';|&]*?(?:harness-kit|agent-guard-kit|harness-plugin))|(?:writeFile|appendFile|rename|unlink|rm|rmdir|copyFile|cp)(?:Sync)?\s*\([^)]*\.claude[\\/]+plugins[\\/]+(?:(?:installed_plugins|known_marketplaces)\.json|(?:cache|marketplaces)[\\/]+[^\s"';|&]*?(?:harness-kit|agent-guard-kit|harness-plugin))"#,
    )
    .is_some_and(|r| r.is_match(cmd))
}

pub fn norm_path_text(s: &str, strip_spaces: bool) -> String {
    let mut t = s
        .to_ascii_lowercase()
        .replace('`', "")
        .replace('\\', "/");
    while t.contains("//") {
        t = t.replace("//", "/");
    }
    if let Some(re) = regex_cached(r#"(^|[\s"'=(,;])/(?:mnt|cygdrive)/([a-z])(?:/|$|[\s"'])"#) {
        // Replace carefully preserving trailing separator if it was '/'
        let mut out = String::with_capacity(t.len());
        let mut last = 0;
        for m in re.find_iter(&t) {
            out.push_str(&t[last..m.start()]);
            let caps = re.captures(&t[m.start()..m.end()]);
            if let Some(c) = caps {
                let pfx = c.get(1).map_or("", |g| g.as_str());
                let drv = c.get(2).map_or("", |g| g.as_str());
                out.push_str(pfx);
                out.push_str(drv);
                out.push(':');
                if m.as_str().ends_with('/') {
                    out.push('/');
                } else if let Some(ch) = m
                    .as_str()
                    .chars()
                    .last()
                    .filter(|ch| ch.is_whitespace() || *ch == '"' || *ch == '\'')
                {
                    out.push(ch);
                }
            }
            last = m.end();
        }
        out.push_str(&t[last..]);
        t = out;
    }
    if let Some(re) = regex_cached(r#"(^|[\s"'=(,;])/([a-z])(?:/|$|[\s"'])"#) {
        let mut out = String::with_capacity(t.len());
        let mut last = 0;
        for m in re.find_iter(&t) {
            out.push_str(&t[last..m.start()]);
            if let Some(c) = re.captures(&t[m.start()..m.end()]) {
                let pfx = c.get(1).map_or("", |g| g.as_str());
                let drv = c.get(2).map_or("", |g| g.as_str());
                out.push_str(pfx);
                out.push_str(drv);
                out.push(':');
                if m.as_str().ends_with('/') {
                    out.push('/');
                } else if let Some(ch) = m
                    .as_str()
                    .chars()
                    .last()
                    .filter(|ch| ch.is_whitespace() || *ch == '"' || *ch == '\'')
                {
                    out.push(ch);
                }
            }
            last = m.end();
        }
        out.push_str(&t[last..]);
        t = out;
    }
    while t.contains("/./") {
        t = t.replace("/./", "/");
    }
    // Collapse single-level /seg/../ up to 8 times
    if let Some(re) = regex_cached(r#"/[^/\s"']+/\.\.(?:/|$)"#) {
        for _ in 0..8 {
            let next = re
                .replace_all(&t, |caps: &regex::Captures<'_>| {
                    let s = caps.get(0).map_or("", |m| m.as_str());
                    if s.starts_with("/../") || s == "/.." {
                        s.to_string()
                    } else if s.ends_with('/') {
                        "/".to_string()
                    } else {
                        String::new()
                    }
                })
                .into_owned();
            if next == t {
                break;
            }
            t = next;
        }
    }
    // Strip trailing dots (and optionally spaces) from path segments
    let seg_re = if strip_spaces {
        regex_cached(r"([^\s/.])[. ]+/")
    } else {
        regex_cached(r"([^\s/.])\.+/")
    };
    if let Some(re) = seg_re {
        t = re.replace_all(&t, "$1/").into_owned();
    }
    if let Some(re) = regex_cached(r#"([^\s/.])\.+(?:$|[\s"'])"#) {
        t = re
            .replace_all(&t, |c: &regex::Captures<'_>| {
                let full = c.get(0).map_or("", |m| m.as_str());
                let ch = c.get(1).map_or("", |m| m.as_str());
                let tail = full.chars().last().filter(|x| !matches!(x, '.')).map(|x| x.to_string()).unwrap_or_default();
                format!("{ch}{tail}")
            })
            .into_owned();
    }
    t
}

pub(super) fn hit_protected_path(text: &str, protected_paths: &[String]) -> bool {
    if protected_paths.is_empty() || text.is_empty() {
        return false;
    }
    let normalized_targets = [norm_path_text(text, false), norm_path_text(text, true)];
    for raw in protected_paths {
        let p = norm_path_text(raw.trim(), false);
        let p = p.trim_end_matches('/');
        if p.len() < 3 {
            continue;
        }
        for target in &normalized_targets {
            if boundary_contains(target, p) {
                return true;
            }
        }
    }
    false
}

pub(super) fn boundary_contains(haystack: &str, needle: &str) -> bool {
    let is_word = |b: u8| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'.' | b'-');
    let hb = haystack.as_bytes();
    let mut start = 0;
    while let Some(pos) = haystack[start..].find(needle) {
        let abs = start + pos;
        let left_ok = abs == 0 || !is_word(hb[abs - 1]);
        let right = abs + needle.len();
        let right_ok = right >= hb.len() || !is_word(hb[right]);
        if left_ok && right_ok {
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


const RULES_PROTECT_REASON: &str = "guard[rules-protect]: Cam ghi vao .harness/ (luat, agy.off) hoac ~/.harness/; chi nguoi dung sua. / Writes under .harness/ are protected; the human edits them.";

/// Any path with a `.harness` component is protected (workspace and ~/.harness alike).
/// Normalizes `.`/`..` and resolves symlinks of the deepest existing ancestor.
pub(super) fn is_rules_file(np: &str) -> bool {
    let has_component = |s: &str| s.split('/').any(|c| c == ".harness");
    let n = norm_path_text(np, false);
    if has_component(&n) || n.starts_with("~/.harness") {
        return true;
    }
    let mut rest: Vec<String> = Vec::new();
    let mut cur = PathBuf::from(np);
    loop {
        if let Ok(real) = cur.canonicalize() {
            let mut full = real.to_string_lossy().replace('\\', "/");
            for r in rest.iter().rev() {
                full.push('/');
                full.push_str(r);
            }
            return has_component(&norm_path_text(&full, false));
        }
        match (cur.file_name().map(|f| f.to_string_lossy().into_owned()), cur.parent()) {
            (Some(name), Some(parent)) => {
                rest.push(name);
                cur = parent.to_path_buf();
            }
            _ => return false,
        }
    }
}

/// Bash: any command naming `.harness` that is not a pure read-only listing/reading is
/// escalated (ask on Claude, deny on agy). Mention-based, so mv/rm/ln -s/python/git checkout/
/// `cd .harness && ...`/"$HOME"/.harness are all covered without a verb denylist.
/// `rg` is not "pure read": `--pre`/`--pre-glob` run arbitrary programs. `find` only passes with
/// the harmless -name/-iname/-type/-maxdepth/-path predicates (-exec/-ok/-delete escalate).
/// shortcut: quote-split spellings like '.har''ness' are not caught.
const RO: &str = r"(?:(?:cat|ls|head|tail|grep|wc|stat)(?:\s[^;&|<>`$()\n]*)?|find(?:\s+(?:[^\s;&|<>`$()\n-][^\s;&|<>`$()\n]*|-(?:name|iname|type|maxdepth|path)\s+\S+))*)";

/// Resolve `p`: symlinks of the deepest existing ancestor (fail-open: returns `p` unchanged).
fn resolve_deep(p: &Path) -> PathBuf {
    let mut rest: Vec<std::ffi::OsString> = Vec::new();
    let mut cur = p.to_path_buf();
    loop {
        if let Ok(real) = cur.canonicalize() {
            return rest.iter().rev().fold(real, |a, r| a.join(r));
        }
        match (cur.file_name().map(|f| f.to_os_string()), cur.parent()) {
            (Some(n), Some(par)) => {
                rest.push(n);
                cur = par.to_path_buf();
            }
            _ => return p.to_path_buf(),
        }
    }
}

const READ_VERBS: &[&str] = &[
    "cat", "ls", "head", "tail", "grep", "wc", "stat", "du", "jq", "file", "sort", "uniq", "cut", "tr",
    "diff", "tree", "readlink", "realpath", "sha256sum", "md5sum", "basename", "dirname", "pwd", "echo", "true",
];
const DESTRUCTIVE_VERBS: &[&str] = &[
    "rm", "rmdir", "mv", "truncate", "tee", "chmod", "chown", "cp", "ln", "dd", "shred", "unlink", "install", "rsync",
];

/// Does one path token (resolved against `cwd`) hit the audit root? Inside always hits; the root
/// being inside the token (ancestor, or a glob matching root or one of its ancestors) hits only
/// when `destructive`.
fn audit_path_hit(tok: &str, cwd: &Path, root: &Path, destructive: bool) -> bool {
    let tok = tok.trim();
    // shortcut: variable indirection ($D, `cmd`) and ~ cannot be resolved statically; not caught.
    if tok.is_empty() || tok.starts_with('~') || tok.contains(['$', '`']) {
        return false;
    }
    let Some(gi) = tok.find(['*', '?', '[', '{']) else {
        let p = resolve_deep(&crate::config::lexical_path(cwd, tok));
        // ancestors count only down to the data dir (<data>/system/audit): wider ones (workspace, /)
        // are the job of rm-recursive-outside, not of this guard.
        let floor = if root.ends_with("system/audit") { root.ancestors().nth(2).unwrap_or(root) } else { root };
        return p.starts_with(root) || (destructive && root.starts_with(&p) && p.starts_with(floor));
    };
    // glob: resolve the literal directory part, keep the pattern tail
    let (dir_part, tail) = match tok[..gi].rfind('/') {
        Some(i) => (&tok[..=i], &tok[i + 1..]),
        None => ("", tok),
    };
    let dir = resolve_deep(&crate::config::lexical_path(cwd, if dir_part.is_empty() { "." } else { dir_part }));
    if dir.starts_with(root) {
        return true;
    }
    if !destructive {
        return false;
    }
    let pat = format!("{}/{}", dir.to_string_lossy().trim_end_matches('/'), tail);
    let Ok(g) = globset::GlobBuilder::new(&pat).literal_separator(true).build() else {
        return false;
    };
    let m = g.compile_matcher();
    let depth = if root.ends_with("system/audit") { 3 } else { 1 };
    root.ancestors().take(depth).any(|a| m.is_match(a))
}

/// Segment-wise: tracks `cd X` for the effective cwd; read-only verbs never hit; destructive verbs
/// hit on the audit root, anything below it, or an ancestor; unknown verbs hit on inside/verbatim mention.
fn bash_touches_audit(cmd: &str, audit_root: &Path, cwd: &Path, depth: usize) -> bool {
    if depth > 4 {
        return false;
    }
    let root = resolve_deep(audit_root);
    let audit_txt = audit_root.to_string_lossy().replace('\\', "/");
    let mut cwd = cwd.to_path_buf();
    for seg in split_shell_segments(cmd) {
        let raw = shell_tokens(&seg);
        if raw.is_empty() {
            continue;
        }
        let u = unwrap_shell_prefix(&raw);
        for s in &u.env_scripts {
            if bash_touches_audit(s, audit_root, &cwd, depth + 1) {
                return true;
            }
        }
        let toks = u.rest;
        let Some(first) = toks.first() else { continue };
        let verb = basename(first.trim_start_matches('\\'));
        if matches!(verb, "sh" | "bash" | "zsh" | "dash" | "ksh") {
            if let Some(k) = toks.iter().skip(1).position(|t| is_shell_c_flag(t)) {
                if let Some(inner) = toks.get(k + 2) {
                    if bash_touches_audit(inner, audit_root, &cwd, depth + 1) {
                        return true;
                    }
                }
            }
            continue;
        }
        if matches!(verb, "cd" | "pushd") {
            if let Some(t) = toks.get(1).filter(|t| !t.contains(['$', '`']) && !t.starts_with(['~', '-'])) {
                cwd = crate::config::lexical_path(&cwd, t);
            }
            continue;
        }
        let find_del = verb == "find"
            && toks.iter().any(|t| matches!(t.as_str(), "-delete" | "-exec" | "-execdir" | "-ok" | "-okdir" | "-fprint" | "-fls"));
        let is_dest = DESTRUCTIVE_VERBS.contains(&verb) || find_del;
        let mut destructive = is_dest;
        let mut cands: Vec<String> = Vec::new();
        if let Some(re) = regex_cached(r#">>?\s*([^\s;&|<>]+)"#) {
            for c in re.captures_iter(&seg) {
                let t = c[1].trim_matches(['"', '\'']).to_string();
                if t != "/dev/null" {
                    destructive = true;
                    cands.push(t);
                }
            }
        }
        if !destructive && (READ_VERBS.contains(&verb) || verb == "find") {
            continue;
        }
        // find: only the leading path operands, not -name patterns
        let args: Vec<&str> = if verb == "find" {
            toks[1..].iter().map(String::as_str).take_while(|t| !t.starts_with(['-', '(', '!'])).collect()
        } else {
            toks[1..].iter().map(String::as_str).filter(|t| !t.starts_with('-')).collect()
        };
        if matches!(verb, "cp" | "rsync" | "install") {
            cands.extend(args.last().map(|s| s.to_string()));
        } else {
            cands.extend(args.iter().map(|s| s.to_string()));
            if is_dest && args.is_empty() {
                cands.push(".".to_string());
            }
        }
        if cands.iter().any(|t| audit_path_hit(t, &cwd, &root, destructive)) {
            return true;
        }
        if !is_dest && hit_protected_path(&seg, std::slice::from_ref(&audit_txt)) {
            return true;
        }
    }
    false
}

const AUDIT_PROTECT_REASON: &str = "guard[audit-protect]: Cam ghi/xoa audit log (<data>/system/audit); chi doc qua harness observe. / The audit log is tamper-protected; read it via harness observe.";

/// True when `np` (absolute or relative to `cwd`) is the audit root or below it, symlinks of the
/// deepest existing ancestor resolved. Independent of the data_gate opt-in.
fn in_audit_root(np: &str, audit_root: &Path, cwd: &Path) -> bool {
    let target = resolve_deep(&crate::config::lexical_path(cwd, np));
    target.starts_with(resolve_deep(audit_root))
}

pub(super) fn rules_mention_bash_spec(action: RuleAction) -> BashRuleSpec {
    let unless = format!(r"^\s*{RO}(?:\|\s*{RO})*\s*$");
    serde_json::from_value(serde_json::json!({
        "id": "rules-protect",
        "kind": "regex",
        "action": action,
        "pattern": r"\.harness",
        "unless": unless,
        "reason": "guard[rules-protect]: lenh nhac toi .harness khong phai doc thuan; can nguoi dung duyet. / Command mentions .harness and is not read-only.",
    }))
    .expect("static bash rule spec")
}

// ============================================================================
// Default guards (no rules file needed): secret-files, rm-recursive-outside, git-force-push
// ============================================================================

/// Decision for a core-guard rule id: ask on Claude / deny on agy for the two "risky but
/// sometimes legitimate" shell guards, deny for everything else.
pub(super) fn core_rule_decision(rule: &str, host: Host) -> Decision {
    match rule {
        "rm-recursive-outside" | "git-force-push" if host == Host::Claude => Decision::Ask,
        _ => Decision::Deny,
    }
}

/// Single source of the default sensitive file names (basename match, case-insensitive).
/// shortcut: data_gate::is_config_dump keeps its own HINTS list (owned by another task); fold it
/// into this function later.
pub(super) fn is_sensitive_basename(name: &str, extra: &[String]) -> bool {
    let n = name.trim().to_ascii_lowercase();
    if n.is_empty() {
        return false;
    }
    if n == ".env" {
        return true;
    }
    if let Some(rest) = n.strip_prefix(".env.") {
        let first = rest.split('.').next().unwrap_or("");
        return !matches!(first, "example" | "sample" | "template" | "dist");
    }
    const EXT: &[&str] = &[".pem", ".key", ".p12", ".pfx", ".jks", ".keystore"];
    if EXT.iter().any(|e| n.ends_with(e)) {
        return true;
    }
    if ["id_rsa", "id_ed25519", "id_ecdsa", "id_dsa"]
        .iter()
        .any(|p| n.starts_with(p))
        && !n.ends_with(".pub")
    {
        return true;
    }
    if n == "credentials"
        || (n.starts_with("credentials") && n.ends_with(".json"))
        || (n.starts_with("service-account") && n.ends_with(".json"))
        || (n.starts_with("secrets.")
            && matches!(
                n.rsplit('.').next().unwrap_or(""),
                "json" | "yml" | "yaml" | "env" | "toml" | "ini"
            ))
        || matches!(n.as_str(), "secret.json" | "secret.yml" | "secret.yaml")
        || matches!(n.as_str(), ".npmrc" | ".netrc" | ".pgpass" | ".git-credentials")
    {
        return true;
    }
    // TOML-configured names apply to Read/Edit on purpose, but templates stay readable
    if n.contains(".example.") || n.contains(".sample.") {
        return false;
    }
    extra.iter().any(|e| {
        let e = e.trim().replace('\\', "/");
        let e = e.rsplit('/').next().unwrap_or("").to_ascii_lowercase();
        !e.is_empty() && e == n
    })
}

fn path_is_sensitive_file(p: &str, extra: &[String], cwd: &Path) -> bool {
    let np = p.replace('\\', "/");
    if np.is_empty() || np.ends_with('/') {
        return false;
    }
    let base = np.rsplit('/').next().unwrap_or("");
    if is_sensitive_basename(base, extra) {
        return true;
    }
    // symlink to a secret: judge the resolved basename too
    let pb = cwd.join(p);
    crate::config::canonicalize_with_tail(&pb)
        .and_then(|r| r.file_name().map(|f| f.to_string_lossy().into_owned()))
        .is_some_and(|b| is_sensitive_basename(&b, extra))
}

/// Grep `glob` that could match a secret file: keyword in the last component, or a leading-dot
/// wildcard (`.e*`). Only pure template globs (`*.env.example`) are exempt.
/// shortcut: keyword substring match, so `*environment*` is a known false positive.
fn glob_may_hit_secret(g: &str) -> bool {
    let g = g.replace('\\', "/").to_ascii_lowercase();
    let base = g.rsplit('/').next().unwrap_or("");
    if base.is_empty() || [".example", ".sample", ".template", ".dist"].iter().any(|s| base.ends_with(s)) {
        return false;
    }
    const KW: &[&str] = &["env", "pem", "key", "id_", "credential", "secret", "npmrc", "netrc", "pgpass"];
    KW.iter().any(|k| base.contains(k)) || (base.starts_with('.') && base.contains(['*', '?', '[']))
}

fn secret_files_hit(input: &HookInput, tool: &str, extra: &[String], cwd: &Path) -> bool {
    let get = |k: &str| input.tool_input.get(k).and_then(Value::as_str).unwrap_or("");
    match tool {
        "Read" | "Write" | "Edit" | "MultiEdit" | "NotebookEdit" => {
            ["file_path", "notebook_path", "path"]
                .iter()
                .any(|k| path_is_sensitive_file(get(k), extra, cwd))
        }
        "Grep" | "Glob" => {
            let p = get("path");
            if !p.is_empty() && !cwd.join(p).is_dir() && path_is_sensitive_file(p, extra, cwd) {
                return true;
            }
            tool == "Grep" && glob_may_hit_secret(get("glob"))
        }
        _ => false,
    }
}

pub(super) fn eval_default_guards(
    input: &HookInput,
    workspace: &Path,
    tool_cwd: &Path,
    sensitive_names: &[String],
) -> Option<(Decision, String, String)> {
    let tool = input.tool_name.as_deref()?;
    if secret_files_hit(input, tool, sensitive_names, tool_cwd) {
        return Some((
            Decision::Deny,
            "secret-files".to_string(),
            "guard[secret-files]: Cam doc/ghi file bi mat (.env, khoa, credential...). Dung .env.example hoac sha256sum/wc. / Secret files are blocked; use .env.example or hash/size checks.".to_string(),
        ));
    }
    if tool != "Bash" && tool != "PowerShell" {
        return None;
    }
    let cmd = input.tool_input.get("command").and_then(Value::as_str)?;
    if cmd.trim().is_empty() {
        return None;
    }
    let ncmd = collapse_line_continuations(cmd);
    let rule = scan_default_bash(&ncmd, workspace, tool_cwd, 0)?;
    let reason = if rule == "git-force-push" {
        "guard[git-force-push]: git push --force/-f/+refspec/--mirror/--delete co the ghi de/xoa lich su remote; can nguoi dung duyet. / Destructive git push needs approval."
    } else {
        "guard[rm-recursive-outside]: rm -rf nham / ~ $HOME .. hoac ngoai workspace; can nguoi dung duyet. / Recursive force delete outside the workspace needs approval."
    };
    Some((core_rule_decision(rule, input.host), rule.to_string(), reason.to_string()))
}

fn scan_default_bash(cmd: &str, ws: &Path, cwd: &Path, depth: usize) -> Option<&'static str> {
    if depth > 4 {
        return None;
    }
    let mut cwd = cwd.to_path_buf();
    for seg in split_shell_segments(cmd) {
        let raw = shell_tokens(&seg);
        if raw.is_empty() {
            continue;
        }
        let u = unwrap_shell_prefix(&raw);
        for s in &u.env_scripts {
            if let Some(r) = scan_default_bash(s, ws, &cwd, depth + 1) {
                return Some(r);
            }
        }
        let toks = u.rest;
        let Some(first) = toks.first() else { continue };
        let base = basename(first.trim_start_matches('\\'));
        match base {
            "sh" | "bash" | "zsh" | "dash" | "ksh" => {
                if let Some(k) = toks.iter().skip(1).position(|t| is_shell_c_flag(t)) {
                    if let Some(inner) = toks.get(k + 2) {
                        if let Some(r) = scan_default_bash(inner, ws, &cwd, depth + 1) {
                            return Some(r);
                        }
                    }
                }
            }
            "cd" | "pushd" => {
                // a cd we cannot prove stays in the workspace makes later relative paths unprovable
                let target = toks.get(1).map(String::as_str).unwrap_or("");
                let ok = !target.is_empty()
                    && !target.starts_with(['~', '-'])
                    && !target.contains(['$', '`'])
                    && !target.split('/').any(|c| c == "..");
                let next = if ok { lexical_join(&cwd, target) } else { PathBuf::from("/") };
                cwd = if next.starts_with(lexical_join(ws, ".")) { next } else { PathBuf::from("/") };
            }
            "rm" if rm_is_dangerous(&toks[1..], ws, &cwd) => return Some("rm-recursive-outside"),
            "git" if git_push_is_destructive(&toks[1..]) => return Some("git-force-push"),
            _ => {}
        }
    }
    None
}

fn rm_is_dangerous(args: &[String], ws: &Path, cwd: &Path) -> bool {
    let (mut rec, mut force, mut opts_done) = (false, false, false);
    let mut targets: Vec<&str> = Vec::new();
    for a in args {
        if !opts_done && a == "--" {
            opts_done = true;
        } else if !opts_done && a.starts_with("--") {
            // GNU long-option abbreviations
            rec |= a.len() >= 5 && "--recursive".starts_with(a.as_str());
            force |= a.len() >= 3 && "--force".starts_with(a.as_str());
        } else if !opts_done && a.starts_with('-') && a.len() > 1 {
            rec |= a.contains(['r', 'R']);
            force |= a.contains('f');
        } else {
            targets.push(a);
        }
    }
    rec && force && targets.iter().any(|t| rm_target_outside(t, ws, cwd))
}

fn rm_target_outside(t: &str, ws: &Path, cwd: &Path) -> bool {
    let t = t.trim();
    if t.is_empty() {
        return false;
    }
    // unresolved expansions ($HOME, $VAR, $(..), backticks) and ~ cannot be proven inside the workspace
    if t.starts_with('~') || t.contains(['$', '`']) {
        return true;
    }
    // shortcut: symlinks are not resolved (lexical check only).
    let full = lexical_join(cwd, t);
    let wsn = lexical_join(ws, ".");
    if !full.starts_with(&wsn) || full == wsn {
        return true;
    }
    // `*` / `.*` directly at the workspace root
    matches!(full.file_name().and_then(|f| f.to_str()), Some("*" | ".*"))
        && full.parent() == Some(wsn.as_path())
}

fn lexical_join(base: &Path, rel: &str) -> PathBuf {
    let mut out = if rel.starts_with('/') { PathBuf::from("/") } else { base.to_path_buf() };
    for comp in rel.split('/') {
        match comp {
            "" | "." => {}
            ".." => {
                out.pop();
            }
            c => out.push(c),
        }
    }
    out
}

fn git_push_is_destructive(args: &[String]) -> bool {
    let mut i = 0;
    while i < args.len() && args[i].starts_with('-') {
        i += if matches!(args[i].as_str(), "-C" | "-c" | "--git-dir" | "--work-tree" | "--namespace") {
            2
        } else {
            1
        };
    }
    if args.get(i).map(String::as_str) != Some("push") {
        return false;
    }
    let prefix_of = |a: &str, full: &str, min: usize| a.len() >= min && full.starts_with(a);
    for a in &args[i + 1..] {
        if let Some(long) = a.strip_prefix("--") {
            let flag = format!("--{}", long.split('=').next().unwrap_or(""));
            if prefix_of(&flag, "--force", 4)
                || flag.starts_with("--force-")
                || prefix_of(&flag, "--mirror", 4)
                || prefix_of(&flag, "--delete", 4)
            {
                return true;
            }
        } else if let Some(short) = a.strip_prefix('-') {
            if short.contains(['f', 'd']) {
                return true;
            }
        } else if a.starts_with('+') || a.contains(":+") || (a.starts_with(':') && a.len() > 1) {
            return true;
        }
    }
    false
}
