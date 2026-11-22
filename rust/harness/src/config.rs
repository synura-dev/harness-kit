use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;
use std::env;
use std::fs;
use std::path::{Component, Path, PathBuf};

pub const DEFAULT_MAX_FILE_BYTES: u64 = 5_242_880;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelRoleConfig {
    pub model: Option<String>,
    pub effort: Option<String>,
    #[serde(default, rename = "allowOpus")]
    pub allow_opus: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelPolicyConfig {
    #[serde(default = "default_model_mode")]
    pub mode: String,
    #[serde(default, rename = "fillEffort")]
    pub fill_effort: bool,
    #[serde(default = "default_model_fallback")]
    pub default_model: String,
    #[serde(default, rename = "opusAllowed")]
    pub opus_allowed: Vec<String>,
    #[serde(default)]
    pub roles: BTreeMap<String, ModelRoleConfig>,
}

fn default_model_mode() -> String {
    "enforce".to_string()
}

fn default_model_fallback() -> String {
    "sonnet".to_string()
}

impl Default for ModelPolicyConfig {
    fn default() -> Self {
        Self {
            mode: "enforce".to_string(),
            fill_effort: false,
            default_model: "sonnet".to_string(),
            opus_allowed: Vec::new(),
            roles: BTreeMap::new(),
        }
    }
}

#[derive(Debug, Clone)]
pub struct WorkspacePaths {
    pub workspace: PathBuf,
    pub data_dir: PathBuf,
    pub audit_root: PathBuf,
    pub has_workspace_marker: bool,
    pub is_plugin_mode: bool,
}

pub fn home_dir() -> Option<PathBuf> {
    env::var_os("HOME")
        .or_else(|| env::var_os("USERPROFILE"))
        .filter(|s| !s.is_empty())
        .map(PathBuf::from)
}

pub fn is_plugin_mode(dir: &Path) -> bool {
    dir.join(".claude-plugin").join("plugin.json").is_file()
}

pub fn workspace_marker(ws: &Path) -> bool {
    if is_plugin_mode(ws) {
        return false;
    }
    ws.join("config")
        .join("workspace")
        .join("default.json")
        .is_file()
        || ws
            .join("config")
            .join("hub")
            .join("default.json")
            .is_file()
}

/// `.git` is a file `gitdir: <main>/.git/worktrees/<name>` in a linked worktree: the main repo.
fn worktree_main_repo(dir: &Path) -> Option<PathBuf> {
    let git = dir.join(".git");
    if !git.is_file() {
        return None;
    }
    let raw = fs::read_to_string(&git).ok()?;
    let target = raw.lines().next()?.strip_prefix("gitdir:")?.trim();
    let gitdir = lexical_path(dir, target);
    let wts = gitdir.parent()?;
    let dot_git = wts.parent()?;
    if wts.file_name()? != "worktrees" || dot_git.file_name()? != ".git" {
        return None;
    }
    let main = dot_git.parent()?;
    main.is_dir().then(|| main.to_path_buf())
}

pub fn find_workspace_root(start: &Path) -> PathBuf {
    let home = home_dir();
    for dir in start.ancestors() {
        if dir.parent().is_none() {
            break;
        }
        if let Some(main) = worktree_main_repo(dir) {
            return main;
        }
        if home.as_ref().is_some_and(|h| same_lexical_path(h, dir)) {
            continue;
        }
        if dir.join(".harness").join("rules.toml").is_file()
            || dir.join(".harness").join("rules.local.toml").is_file()
            || workspace_marker(dir)
            || dir.join(".git").exists()
        {
            return dir.to_path_buf();
        }
    }
    start.to_path_buf()
}

pub fn resolve_workspace(cwd_hint: Option<&str>) -> PathBuf {
    let base = env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    let raw = if let Some(hint) = cwd_hint.map(str::trim).filter(|s| !s.is_empty()) {
        lexical_path(&base, hint)
    } else {
        let mut env_dir = None;
        for key in ["HUB_DIR", "CLAUDE_PROJECT_DIR", "HARNESS_PROJECT_DIR"] {
            if let Ok(val) = env::var(key) {
                let trimmed = val.trim();
                if !trimmed.is_empty() {
                    env_dir = Some(lexical_path(&base, trimmed));
                    break;
                }
            }
        }
        env_dir.unwrap_or(base)
    };
    find_workspace_root(&raw)
}

pub fn resolve_paths(cwd_hint: Option<&str>) -> WorkspacePaths {
    let ws = resolve_workspace(cwd_hint);
    let plugin = is_plugin_mode(&ws);
    let marker = workspace_marker(&ws);
    let data_dir = match env::var("HUB_DATA_DIR") {
        Ok(val) if !val.trim().is_empty() => lexical_path(&ws, val.trim()),
        _ if marker => ws.join("data"),
        _ => ws.join(".harness").join("data"),
    };
    // Audit lives under the data layout: registry.json `audit` target (system/audit).
    let audit_root = data_dir.join("system").join("audit");
    WorkspacePaths {
        workspace: ws,
        data_dir,
        audit_root,
        has_workspace_marker: marker,
        is_plugin_mode: plugin,
    }
}

pub fn ensure_data_ignore(paths: &WorkspacePaths) {
    if let Ok(v) = env::var("HUB_DATA_DIR") {
        if !v.trim().is_empty() {
            return;
        }
    }
    if paths.has_workspace_marker || !paths.workspace.is_dir() {
        return;
    }
    let harness_dir = paths.workspace.join(".harness");
    let gitignore = harness_dir.join(".gitignore");
    if let Ok(cur) = fs::read_to_string(&gitignore) {
        if cur.lines().any(|l| l.trim() == "*") {
            return;
        }
        let prefix = if cur.is_empty() || cur.ends_with('\n') {
            ""
        } else {
            "\n"
        };
        let _ = fs::write(&gitignore, format!("{cur}{prefix}*\n"));
        return;
    }
    if fs::create_dir_all(&harness_dir).is_ok() {
        let _ = fs::write(&gitignore, "*\n");
    }
}

pub fn is_agy_enabled(ws: &Path) -> bool {
    if env::var("HARNESS_AGY").ok().as_deref() == Some("0") {
        return false;
    }
    if ws.parent().is_none() {
        return false;
    }
    if let Some(home) = home_dir() {
        if same_lexical_path(&home, ws) {
            return false;
        }
    }
    // A project `.harness/agy.off` is deliberately ignored (agents could create it): only the
    // HARNESS_AGY=0 env var turns agy guarding off.
    true
}

pub fn same_lexical_path(a: &Path, b: &Path) -> bool {
    normalize_slashes(a.to_string_lossy().as_ref())
        == normalize_slashes(b.to_string_lossy().as_ref())
}

pub fn normalize_slashes(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut prev_slash = false;
    for ch in s.chars() {
        let c = if ch == '\\' { '/' } else { ch };
        if c == '/' {
            if !prev_slash {
                out.push('/');
            }
            prev_slash = true;
        } else {
            out.push(c);
            prev_slash = false;
        }
    }
    if out.len() > 1 && out.ends_with('/') {
        out.pop();
    }
    out
}

pub fn lexical_path(base: &Path, raw: &str) -> PathBuf {
    let replaced = raw.replace('\\', "/");
    let candidate = Path::new(&replaced);
    let joined = if candidate.is_absolute() {
        candidate.to_path_buf()
    } else {
        base.join(candidate)
    };
    let mut stack: Vec<Component<'_>> = Vec::new();
    for comp in joined.components() {
        match comp {
            Component::CurDir => {}
            Component::ParentDir => {
                if matches!(stack.last(), Some(Component::Normal(_))) {
                    stack.pop();
                } else if !matches!(
                    stack.last(),
                    Some(Component::RootDir | Component::Prefix(_))
                ) {
                    stack.push(comp);
                }
            }
            other => stack.push(other),
        }
    }
    let mut res = PathBuf::new();
    for c in stack {
        res.push(c.as_os_str());
    }
    if res.as_os_str().is_empty() {
        PathBuf::from(".")
    } else {
        res
    }
}

pub fn resolve_posix_and_real(base: &Path, raw: &str) -> Vec<String> {
    let lex = lexical_path(base, raw);
    let mut out = Vec::with_capacity(2);
    out.push(normalize_slashes(&lex.to_string_lossy()));
    if let Some(real) = canonicalize_with_tail(&lex) {
        let r = normalize_slashes(&real.to_string_lossy());
        if !out.contains(&r) {
            out.push(r);
        }
    }
    out
}

pub fn canonicalize_with_tail(p: &Path) -> Option<PathBuf> {
    if let Ok(real) = fs::canonicalize(p) {
        return Some(real);
    }
    let mut cur = p;
    let mut tail = Vec::new();
    for _ in 0..64 {
        let name = cur.file_name()?;
        tail.push(name.to_os_string());
        cur = cur.parent()?;
        if let Ok(real_parent) = fs::canonicalize(cur) {
            let mut joined = real_parent;
            for seg in tail.into_iter().rev() {
                joined.push(seg);
            }
            return Some(joined);
        }
    }
    None
}

pub fn audit_max_file_bytes() -> u64 {
    env::var("CLAUDE_AUDIT_MAX_FILE_BYTES")
        .ok()
        .and_then(|v| v.trim().parse::<u64>().ok())
        .filter(|&n| n > 0)
        .unwrap_or(DEFAULT_MAX_FILE_BYTES)
}

/// Present in any form (file, directory, dangling symlink): an unreadable rules file must
/// reach the loader so it fails closed, not be skipped as if the layer did not exist.
fn layer_present(p: &Path) -> bool {
    std::fs::symlink_metadata(p).is_ok()
}

pub fn discover_rule_files(ws: &Path) -> Vec<(String, PathBuf)> {
    let mut files = Vec::new();
    if let Some(home) = home_dir() {
        if !same_lexical_path(&home, ws) {
            let user_rules = home.join(".harness").join("rules.toml");
            if layer_present(&user_rules) {
                files.push(("user".to_string(), user_rules));
            }
        }
    }
    let project_rules = ws.join(".harness").join("rules.toml");
    if layer_present(&project_rules) {
        files.push(("project".to_string(), project_rules));
    }
    let local_rules = ws.join(".harness").join("rules.local.toml");
    if layer_present(&local_rules) {
        files.push(("local".to_string(), local_rules));
    }
    files
}

/// Legacy `config/guard/*.json` overlays are no longer loaded; only detected so doctor can
/// tell the user to migrate them into `.harness/rules.toml`.
pub fn legacy_guard_files(ws: &Path) -> Vec<PathBuf> {
    let dir = ws.join("config").join("guard");
    let Ok(rd) = fs::read_dir(&dir) else {
        return Vec::new();
    };
    let mut out: Vec<PathBuf> = rd
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.extension().is_some_and(|x| x == "json"))
        .collect();
    out.sort();
    out
}

pub fn load_model_policy(ws: &Path) -> ModelPolicyConfig {
    // Opt-in: with no config file the policy stays in audit mode (no model rewriting).
    let mut cfg = ModelPolicyConfig { mode: "audit".to_string(), ..Default::default() };
    let mut found = false;
    let mut dirs = Vec::new();
    if let Ok(cdir) = env::var("HARNESS_CONFIG_DIR") {
        let t = cdir.trim();
        if !t.is_empty() {
            dirs.push(PathBuf::from(t).join("models"));
        }
    }
    dirs.push(ws.join("config").join("models"));
    let mut candidates = Vec::new();
    for d in dirs {
        candidates.push(d.join("default.json"));
        candidates.push(d.join("local.json"));
    }
    candidates.push(ws.join(".harness").join("models.json"));

    for f in candidates {
        if !f.is_file() {
            continue;
        }
        if let Ok(v) = read_json_object(&f) {
            if !found {
                found = true;
                cfg.mode = default_model_mode();
            }
            if let Some(m) = v.get("mode").and_then(Value::as_str) {
                cfg.mode = m.to_string();
            }
            if let Some(fe) = v.get("fillEffort").and_then(Value::as_bool) {
                cfg.fill_effort = fe;
            }
            if let Some(dm) = v
                .get("default")
                .and_then(|d| d.get("model"))
                .and_then(Value::as_str)
            {
                cfg.default_model = dm.to_string();
            }
            if let Some(arr) = v.get("opusAllowed").and_then(Value::as_array) {
                for item in arr {
                    if let Some(s) = item.as_str() {
                        if !cfg.opus_allowed.iter().any(|x| x == s) {
                            cfg.opus_allowed.push(s.to_string());
                        }
                    }
                }
            }
            if let Some(roles) = v.get("roles").and_then(Value::as_object) {
                for (k, rv) in roles {
                    if let Ok(rc) = serde_json::from_value::<ModelRoleConfig>(rv.clone()) {
                        cfg.roles.insert(k.clone(), rc);
                    }
                }
            }
        }
    }
    cfg
}

pub fn read_json_object(path: &Path) -> Result<Value, String> {
    let raw = fs::read_to_string(path).map_err(|e| e.to_string())?;
    let trimmed = raw.strip_prefix('\u{feff}').unwrap_or(&raw);
    let val: Value = serde_json::from_str(trimmed).map_err(|e| e.to_string())?;
    if !val.is_object() {
        return Err("root must be a JSON object".to_string());
    }
    Ok(val)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn find_workspace_root_walks_up_to_rules_or_git() {
        let base = std::env::temp_dir().join(format!("harness-cfg-root-{}", std::process::id()));
        let _ = fs::remove_dir_all(&base);
        let repo_rules = base.join("repo-rules");
        let sub_rules = repo_rules.join("a/b/c");
        fs::create_dir_all(repo_rules.join(".harness")).unwrap();
        fs::write(repo_rules.join(".harness/rules.toml"), "").unwrap();
        fs::create_dir_all(&sub_rules).unwrap();
        assert_eq!(find_workspace_root(&sub_rules), repo_rules);

        let repo_git = base.join("repo-git");
        let sub_git = repo_git.join("pkg/src");
        fs::create_dir_all(repo_git.join(".git")).unwrap();
        fs::create_dir_all(&sub_git).unwrap();
        assert_eq!(find_workspace_root(&sub_git), repo_git);

        let repo_wt = base.join("repo-wt");
        let sub_wt = repo_wt.join("nested");
        fs::create_dir_all(&sub_wt).unwrap();
        fs::write(repo_wt.join(".git"), "gitdir: /tmp/x").unwrap();
        assert_eq!(find_workspace_root(&sub_wt), repo_wt);

        let plain = base.join("plain/sub");
        fs::create_dir_all(&plain).unwrap();
        assert_eq!(find_workspace_root(&plain), plain);

        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn ws_git_worktree_maps_to_main() {
        let base = std::env::temp_dir().join(format!("harness-cfg-wt-{}", std::process::id()));
        let _ = fs::remove_dir_all(&base);
        let main = base.join("main");
        fs::create_dir_all(main.join(".git/worktrees/x")).unwrap();
        let wt = main.join(".worktrees/x");
        fs::create_dir_all(wt.join("src")).unwrap();
        fs::write(
            wt.join(".git"),
            format!("gitdir: {}/.git/worktrees/x\n", main.display()),
        )
        .unwrap();
        assert_eq!(find_workspace_root(&wt.join("src")), main);
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn agy_off_in_project_ignored() {
        let _g = crate::cli::AUDIT_ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let ws = std::env::temp_dir().join(format!("harness-cfg-agyoff-{}", std::process::id()));
        let _ = fs::remove_dir_all(&ws);
        fs::create_dir_all(ws.join(".harness")).unwrap();
        fs::write(ws.join(".harness/agy.off"), "").unwrap();
        std::env::remove_var("HARNESS_AGY");
        assert!(is_agy_enabled(&ws), "project agy.off must be ignored");
        std::env::set_var("HARNESS_AGY", "0");
        assert!(!is_agy_enabled(&ws));
        std::env::remove_var("HARNESS_AGY");
        let _ = fs::remove_dir_all(&ws);
    }

    #[test]
    fn audit_lives_under_data_dir_system_audit() {
        let _g = crate::cli::AUDIT_ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let ws = std::env::temp_dir().join(format!("harness-cfg-aud-{}", std::process::id()));
        let _ = fs::remove_dir_all(&ws);
        fs::create_dir_all(ws.join(".harness")).unwrap();
        fs::write(ws.join(".harness/rules.toml"), "").unwrap();
        std::env::remove_var("HUB_DATA_DIR");
        let p = resolve_paths(Some(&ws.to_string_lossy()));
        assert_eq!(p.audit_root, p.data_dir.join("system").join("audit"));
        std::env::set_var("HUB_DATA_DIR", ws.join("custom"));
        let p = resolve_paths(Some(&ws.to_string_lossy()));
        std::env::remove_var("HUB_DATA_DIR");
        assert_eq!(p.audit_root, ws.join("custom").join("system").join("audit"));
        let _ = fs::remove_dir_all(&ws);
    }
}
