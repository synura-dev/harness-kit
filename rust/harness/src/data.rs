use crate::config::{normalize_slashes, WorkspacePaths};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{BTreeMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant, SystemTime};

const EMBEDDED_REGISTRY_JSON: &str = include_str!("../adapters/registry.json");
const VALID_ZONES: &[&str] = &["system", "knowledge", "workspaces", "external", "_inbox"];
const VALID_CLASSES: &[&str] = &["log", "cache", "artifact", "durable"];
const MAX_WALK_FILES: usize = 20_000;
const WALK_TIMEOUT_MS: u64 = 10_000;

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct RegistryEntry {
    pub zone: Option<String>,
    #[serde(rename = "class")]
    pub class_name: Option<String>,
    pub owner: Option<String>,
    #[serde(rename = "retentionDays")]
    pub retention_days: Option<u64>,
    pub target: Option<String>,
    pub path: Option<String>,
    pub note: Option<String>,
    pub caps: Option<EntryCaps>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct EntryCaps {
    #[serde(rename = "maxFiles")]
    pub max_files: Option<usize>,
    #[serde(rename = "maxDepth")]
    pub max_depth: Option<usize>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct DataRegistry {
    #[serde(default)]
    pub enforce: String,
    #[serde(default)]
    pub entries: BTreeMap<String, RegistryEntry>,
    #[serde(default)]
    pub reserved: Vec<String>,
}

pub fn load_registry(ws: &Path) -> Result<(DataRegistry, String), String> {
    let ws_reg = ws
        .join("harness")
        .join("observe")
        .join("storage")
        .join("registry.json");
    if ws_reg.is_file() {
        let raw = fs::read_to_string(&ws_reg).map_err(|e| e.to_string())?;
        let reg: DataRegistry = serde_json::from_str(&raw).map_err(|e| e.to_string())?;
        return Ok((reg, normalize_slashes(&ws_reg.to_string_lossy())));
    }
    let reg: DataRegistry =
        serde_json::from_str(EMBEDDED_REGISTRY_JSON).map_err(|e| e.to_string())?;
    Ok((reg, "embedded:registry.json".to_string()))
}

pub fn run_data(
    paths: &WorkspacePaths,
    action: &str,
    zone_filter: Option<&str>,
) -> Result<Value, String> {
    run_data_budget(paths, action, zone_filter, Duration::from_millis(WALK_TIMEOUT_MS))
}

pub fn run_data_budget(
    paths: &WorkspacePaths,
    action: &str,
    zone_filter: Option<&str>,
    budget: Duration,
) -> Result<Value, String> {
    let deadline = Instant::now() + budget;
    if let Some(z) = zone_filter {
        if !VALID_ZONES.contains(&z) {
            return Err(format!("invalid zone '{z}' (expected {})", VALID_ZONES.join("|")));
        }
    }
    let (reg, source) = load_registry(&paths.workspace)?;
    match action {
        "ls" => Ok(action_ls(paths, &reg, &source, zone_filter)),
        "stat" => Ok(action_stat(paths, &reg, &source, zone_filter, deadline)),
        "scan" => Ok(action_scan(paths, &reg, &source, zone_filter, deadline)),
        "retention" => Ok(action_retention(paths, &reg, &source, zone_filter, deadline)),
        other => Err(format!(
            "invalid action '{other}' (expected ls|stat|scan|retention)"
        )),
    }
}

fn effective_rel(key: &str, ent: &RegistryEntry) -> String {
    ent.path
        .as_deref()
        .or(ent.target.as_deref())
        .unwrap_or(key)
        .to_string()
}

/// Registry paths are relative to the data dir (audit included: `system/audit`).
fn entry_abs(paths: &WorkspacePaths, _key: &str, rel: &str) -> std::path::PathBuf {
    paths.data_dir.join(rel)
}

fn default_retention(class_name: Option<&str>) -> Option<u64> {
    match class_name {
        Some("log") => Some(30),
        Some("cache") => Some(7),
        _ => None,
    }
}

fn class_caps(class_name: Option<&str>) -> (Option<usize>, Option<usize>) {
    match class_name {
        Some("log") => (Some(5000), Some(4)),
        Some("cache") => (Some(2000), Some(3)),
        Some("artifact") => (Some(2000), Some(5)),
        Some("durable") => (Some(5000), Some(6)),
        _ => (None, None),
    }
}

fn known_top_names(reg: &DataRegistry) -> HashSet<String> {
    let mut set: HashSet<String> = reg.reserved.iter().cloned().collect();
    for z in VALID_ZONES {
        set.insert((*z).to_string());
    }
    for (k, e) in &reg.entries {
        let p = effective_rel(k, e);
        set.insert(p.clone());
        if let Some(top) = p.split('/').next() {
            set.insert(top.to_string());
        }
    }
    set
}

fn action_ls(
    paths: &WorkspacePaths,
    reg: &DataRegistry,
    source: &str,
    zone_filter: Option<&str>,
) -> Value {
    let mut entries = Vec::new();
    for (k, e) in &reg.entries {
        if let Some(z) = zone_filter {
            if e.zone.as_deref() != Some(z) {
                continue;
            }
        }
        let rel = effective_rel(k, e);
        let abs = entry_abs(paths, k, &rel);
        entries.push(serde_json::json!({
            "key": k,
            "zone": e.zone,
            "class": e.class_name,
            "path": rel,
            "owner": e.owner,
            "retention_days": e.retention_days.or_else(|| default_retention(e.class_name.as_deref())),
            "exists": abs.exists(),
        }));
    }

    let mut top_dirs = Vec::new();
    if let Ok(rd) = fs::read_dir(&paths.data_dir) {
        for d in rd.flatten() {
            if let Some(name) = d.file_name().to_str() {
                if let Some(z) = zone_filter {
                    if name != z {
                        continue;
                    }
                }
                top_dirs.push(name.to_string());
            }
        }
        top_dirs.sort();
    }

    serde_json::json!({
        "action": "ls",
        "data_root": normalize_slashes(&paths.data_dir.to_string_lossy()),
        "registry_source": source,
        "zone_filter": zone_filter,
        "entries": entries,
        "top_level": top_dirs,
    })
}

fn action_stat(
    paths: &WorkspacePaths,
    reg: &DataRegistry,
    source: &str,
    zone_filter: Option<&str>,
    deadline: Instant,
) -> Value {
    let known = known_top_names(reg);
    let mut rows = Vec::new();
    let mut total_files = 0usize;
    let mut total_bytes = 0u64;
    let mut truncated = false;

    if let Some(z) = zone_filter {
        let dir = paths.data_dir.join(z);
        if dir.exists() {
            let w = walk_bounded(&dir, deadline);
            if w.truncated {
                truncated = true;
            }
            total_files += w.files.len();
            total_bytes += w.bytes;
            rows.push(serde_json::json!({
                "name": z,
                "files": w.files.len(),
                "bytes": w.bytes,
                "max_depth": w.max_depth,
                "registered": known.contains(z),
            }));
        }
    } else if let Ok(rd) = fs::read_dir(&paths.data_dir) {
        let mut names: Vec<PathBuf> = rd.flatten().map(|e| e.path()).collect();
        names.sort();
        for p in names {
            let name = p
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("")
                .to_string();
            let w = walk_bounded(&p, deadline);
            if w.truncated {
                truncated = true;
            }
            total_files += w.files.len();
            total_bytes += w.bytes;
            rows.push(serde_json::json!({
                "name": name,
                "files": w.files.len(),
                "bytes": w.bytes,
                "max_depth": w.max_depth,
                "registered": known.contains(&name),
            }));
        }
    }

    serde_json::json!({
        "action": "stat",
        "data_root": normalize_slashes(&paths.data_dir.to_string_lossy()),
        "registry_source": source,
        "total_files": total_files,
        "total_bytes": total_bytes,
        "truncated": truncated,
        "rows": rows,
    })
}

fn action_scan(
    paths: &WorkspacePaths,
    reg: &DataRegistry,
    source: &str,
    zone_filter: Option<&str>,
    deadline: Instant,
) -> Value {
    let known = known_top_names(reg);
    let mut warnings = Vec::new();
    let mut entry_stats = BTreeMap::new();
    let mut total_files = 0usize;
    let mut truncated = false;
    let now = SystemTime::now();

    if zone_filter.is_none() {
        if let Ok(rd) = fs::read_dir(&paths.data_dir) {
            for ent in rd.flatten() {
                let name = ent.file_name().to_string_lossy().to_string();
                if !known.contains(&name) {
                    warnings.push(serde_json::json!({
                        "rule": "unregistered",
                        "path": name,
                        "key": name,
                        "detail": "top-level entry outside registry",
                    }));
                }
            }
        }
    }

    for (k, e) in &reg.entries {
        if let Some(z) = zone_filter {
            if e.zone.as_deref() != Some(z) {
                continue;
            }
        }
        if e.zone.as_deref().is_none_or(|z| !VALID_ZONES.contains(&z)) {
            warnings.push(serde_json::json!({
                "rule": "missing-field",
                "path": k,
                "key": k,
                "detail": "invalid or missing zone",
            }));
        }
        if e.class_name
            .as_deref()
            .is_none_or(|c| !VALID_CLASSES.contains(&c))
        {
            warnings.push(serde_json::json!({
                "rule": "missing-field",
                "path": k,
                "key": k,
                "detail": "invalid or missing class",
            }));
        }
        let rel = effective_rel(k, e);
        let abs = entry_abs(paths, k, &rel);
        if !abs.exists() {
            continue;
        }
        let w = walk_bounded(&abs, deadline);
        if w.truncated {
            truncated = true;
        }
        total_files += w.files.len();
        entry_stats.insert(
            k.clone(),
            serde_json::json!({
                "zone": e.zone,
                "class": e.class_name,
                "files": w.files.len(),
                "bytes": w.bytes,
                "depth": w.max_depth,
            }),
        );

        let (def_files, def_depth) = class_caps(e.class_name.as_deref());
        let max_files = e.caps.as_ref().and_then(|c| c.max_files).or(def_files);
        let max_depth = e.caps.as_ref().and_then(|c| c.max_depth).or(def_depth);
        if let Some(mf) = max_files {
            if w.files.len() > mf {
                warnings.push(serde_json::json!({
                    "rule": "over-caps",
                    "path": rel,
                    "key": k,
                    "detail": format!("{}/{} files", w.files.len(), mf),
                }));
            }
        }
        if let Some(md) = max_depth {
            if w.max_depth > md {
                warnings.push(serde_json::json!({
                    "rule": "over-caps",
                    "path": rel,
                    "key": k,
                    "detail": format!("depth {}/{}", w.max_depth, md),
                }));
            }
        }
        if let Some(days) = e
            .retention_days
            .or_else(|| default_retention(e.class_name.as_deref()))
        {
            let cutoff = now
                .checked_sub(Duration::from_secs(days * 86_400))
                .unwrap_or(SystemTime::UNIX_EPOCH);
            let expired = w.files.iter().filter(|f| f.mtime < cutoff).count();
            if expired > 0 {
                warnings.push(serde_json::json!({
                    "rule": "retention",
                    "path": rel,
                    "key": k,
                    "detail": format!("{expired} files older than {days}d"),
                }));
            }
        }
    }

    serde_json::json!({
        "action": "scan",
        "ok": warnings.is_empty() && !truncated,
        "data_root": normalize_slashes(&paths.data_dir.to_string_lossy()),
        "registry_source": source,
        "total_files": total_files,
        "truncated": truncated,
        "entries": entry_stats,
        "warnings": warnings,
    })
}

fn action_retention(
    paths: &WorkspacePaths,
    reg: &DataRegistry,
    source: &str,
    zone_filter: Option<&str>,
    deadline: Instant,
) -> Value {
    let now = SystemTime::now();
    let mut items = Vec::new();
    let mut total_expired_files = 0usize;
    let mut total_expired_bytes = 0u64;
    let mut truncated = false;

    for (k, e) in &reg.entries {
        if let Some(z) = zone_filter {
            if e.zone.as_deref() != Some(z) {
                continue;
            }
        }
        let days = e
            .retention_days
            .or_else(|| default_retention(e.class_name.as_deref()));
        let rel = effective_rel(k, e);
        let abs = entry_abs(paths, k, &rel);
        let (expired_files, expired_bytes) = if let (Some(d), true) = (days, abs.exists()) {
            let w = walk_bounded(&abs, deadline);
            if w.truncated {
                truncated = true;
            }
            let cutoff = now
                .checked_sub(Duration::from_secs(d * 86_400))
                .unwrap_or(SystemTime::UNIX_EPOCH);
            let mut cnt = 0usize;
            let mut bytes = 0u64;
            for f in w.files {
                if f.mtime < cutoff {
                    cnt += 1;
                    bytes += f.size;
                }
            }
            (cnt, bytes)
        } else {
            (0, 0)
        };
        total_expired_files += expired_files;
        total_expired_bytes += expired_bytes;
        items.push(serde_json::json!({
            "key": k,
            "zone": e.zone,
            "class": e.class_name,
            "path": rel,
            "retention_days": days,
            "expired_files": expired_files,
            "expired_bytes": expired_bytes,
        }));
    }

    serde_json::json!({
        "action": "retention",
        "dry_run": true,
        "data_root": normalize_slashes(&paths.data_dir.to_string_lossy()),
        "registry_source": source,
        "total_expired_files": total_expired_files,
        "total_expired_bytes": total_expired_bytes,
        "truncated": truncated,
        "items": items,
    })
}

struct FileStat {
    size: u64,
    mtime: SystemTime,
}

struct WalkResult {
    files: Vec<FileStat>,
    bytes: u64,
    max_depth: usize,
    truncated: bool,
}

/// `deadline` is shared by every walk of one run_data call, so the timeout is a total budget.
fn walk_bounded(root: &Path, deadline: Instant) -> WalkResult {
    let mut files = Vec::new();
    let mut bytes = 0u64;
    let mut max_depth = 0usize;
    let mut truncated = false;
    if Instant::now() >= deadline {
        return WalkResult {
            files,
            bytes,
            max_depth,
            truncated: true,
        };
    }

    let Ok(meta) = fs::symlink_metadata(root) else {
        return WalkResult {
            files,
            bytes,
            max_depth,
            truncated,
        };
    };
    if meta.file_type().is_symlink() {
        return WalkResult {
            files,
            bytes,
            max_depth,
            truncated,
        };
    }
    if meta.is_file() {
        files.push(FileStat {
            size: meta.len(),
            mtime: meta.modified().unwrap_or(SystemTime::UNIX_EPOCH),
        });
        return WalkResult {
            files,
            bytes: meta.len(),
            max_depth: 1,
            truncated,
        };
    }

    let mut stack: Vec<(PathBuf, usize)> = vec![(root.to_path_buf(), 0)];
    while let Some((dir, depth)) = stack.pop() {
        if Instant::now() >= deadline || files.len() >= MAX_WALK_FILES {
            truncated = true;
            break;
        }
        let Ok(rd) = fs::read_dir(&dir) else {
            continue;
        };
        for ent in rd.flatten() {
            let Ok(ft) = ent.file_type() else {
                continue;
            };
            if ft.is_symlink() {
                continue;
            }
            let p = ent.path();
            if ft.is_dir() {
                stack.push((p, depth + 1));
            } else if ft.is_file() {
                if files.len() >= MAX_WALK_FILES {
                    truncated = true;
                    break;
                }
                if let Ok(m) = ent.metadata() {
                    let sz = m.len();
                    bytes += sz;
                    let d = depth + 1;
                    if d > max_depth {
                        max_depth = d;
                    }
                    files.push(FileStat {
                        size: sz,
                        mtime: m.modified().unwrap_or(SystemTime::UNIX_EPOCH),
                    });
                }
            }
        }
    }

    WalkResult {
        files,
        bytes,
        max_depth,
        truncated,
    }
}

pub fn format_data_summary(v: &Value) -> String {
    serde_json::to_string_pretty(v).unwrap_or_else(|_| v.to_string())
}

/// `--json`: compact single-line JSON; otherwise the pretty summary.
pub fn format_data(v: &Value, json: bool) -> String {
    if json {
        v.to_string()
    } else {
        format_data_summary(v)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_paths(tag: &str) -> WorkspacePaths {
        let root = std::env::temp_dir().join(format!("harness-data-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let data = root.join("data");
        for d in ["knowledge/a", "system/b", "workspaces/c"] {
            fs::create_dir_all(data.join(d)).unwrap();
            fs::write(data.join(d).join("f.txt"), "x").unwrap();
        }
        let (reg, _) = load_registry(&root).unwrap();
        for (k, e) in &reg.entries {
            let d = entry_abs(
                &WorkspacePaths {
                    workspace: root.clone(),
                    data_dir: data.clone(),
                    audit_root: root.join("audit"),
                    has_workspace_marker: false,
                    is_plugin_mode: false,
                },
                k,
                &effective_rel(k, e),
            );
            if fs::create_dir_all(&d).is_ok() {
                let _ = fs::write(d.join("f.txt"), "x");
            }
        }
        WorkspacePaths {
            workspace: root.clone(),
            data_dir: data,
            audit_root: root.join("audit"),
            has_workspace_marker: false,
            is_plugin_mode: false,
        }
    }

    #[test]
    fn zero_budget_truncates_whole_stat_and_scan() {
        let p = tmp_paths("budget");
        for action in ["stat", "scan", "retention"] {
            let v = run_data_budget(&p, action, None, Duration::ZERO).unwrap();
            assert_eq!(v["truncated"], serde_json::json!(true), "{action}: {v}");
        }
        let v = run_data_budget(&p, "scan", None, Duration::ZERO).unwrap();
        assert_eq!(v["ok"], serde_json::json!(false), "truncated scan is not ok: {v}");
        let v = run_data_budget(&p, "stat", None, Duration::from_secs(10)).unwrap();
        assert_eq!(v["truncated"], serde_json::json!(false), "{v}");
        assert!(v["total_files"].as_u64().unwrap() >= 3);
    }

    #[test]
    fn scan_reports_ok_flag_from_warnings() {
        let p = tmp_paths("ok");
        fs::create_dir_all(p.data_dir.join("stray-unregistered")).unwrap();
        let v = run_data_budget(&p, "scan", None, Duration::from_secs(10)).unwrap();
        assert!(!v["warnings"].as_array().unwrap().is_empty(), "{v}");
        assert_eq!(v["ok"], serde_json::json!(false));
    }

    #[test]
    fn format_data_json_is_single_line() {
        let v = serde_json::json!({"a": 1});
        assert_eq!(format_data(&v, true), "{\"a\":1}");
        assert!(format_data(&v, false).contains('\n'));
    }
}
