use crate::config::{
    discover_rule_files, lexical_path, load_model_policy,
    normalize_slashes, resolve_posix_and_real, WorkspacePaths,
};
use crate::host::{Decision, HookInput, HookOutcome, Host};
use globset::{Glob, GlobMatcher};
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::env;
use std::path::{Path, PathBuf};
use std::process::Command;

const MAX_COMMAND_CHARS: usize = 100_000;
const BASH_DEFAULT_TIMEOUT_MS: u64 = 120_000;
const MODEL_ALIASES: &[&str] = &["sonnet", "opus", "haiku", "fable"];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RuleAction {
    Ask,
    Deny,
}

impl RuleAction {
    fn to_decision(self) -> Decision {
        match self {
            RuleAction::Ask => Decision::Ask,
            RuleAction::Deny => Decision::Deny,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum PathMatchKind {
    #[default]
    ResolvedRegex,
    ResolvedGlob,
    Regex,
    Glob,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PathRuleSpec {
    pub id: String,
    #[serde(default)]
    pub tools: Vec<String>,
    #[serde(default = "default_deny_action")]
    pub action: RuleAction,
    #[serde(default)]
    pub match_kind: PathMatchKind,
    pub pattern: String,
    #[serde(default)]
    pub unless: Option<String>,
    pub reason: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AgyArgScanSpec {
    pub id: String,
    #[serde(default = "default_deny_action")]
    pub action: RuleAction,
    #[serde(default)]
    pub match_kind: PathMatchKind,
    pub pattern: String,
    #[serde(default)]
    pub exclude_keys: Vec<String>,
    #[serde(default)]
    pub skip_command_line_on: Vec<String>,
    pub reason: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum BashRuleKind {
    #[default]
    Regex,
    ShellAccess,
    WorktreeScript,
    CommandGuard,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PortForwardSpec {
    pub regex: String,
    pub reason: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DaemonAllowSpec {
    pub command: String,
    pub required_port: String,
    /// Flag carrying the storage path of the daemon (default `--path`).
    #[serde(default = "default_path_flag")]
    pub path_flag: String,
    #[serde(default, alias = "allowed_dbpath_env")]
    pub allowed_paths_env: Option<String>,
    #[serde(default, alias = "allowed_dbpath_default")]
    pub allowed_paths: Option<String>,
    pub deny_reason: String,
}

fn default_path_flag() -> String {
    "--path".to_string()
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BashRuleSpec {
    pub id: String,
    #[serde(default)]
    pub kind: BashRuleKind,
    #[serde(default = "default_deny_action")]
    pub action: RuleAction,
    #[serde(default)]
    pub reason: Option<String>,
    /// any-of substrings (ascii case-insensitive); rule runs only if the quote-stripped
    /// command (or cwd) contains one. Empty => always runs.
    #[serde(default)]
    pub prefilter: Vec<String>,

    // kind = regex
    #[serde(default)]
    pub pattern: Option<String>,
    #[serde(default)]
    pub unless: Option<String>,
    #[serde(default)]
    pub remote_only: bool,

    // kind = worktree_script
    #[serde(default)]
    pub script_regex: Option<String>,
    #[serde(default)]
    pub exclude_regex: Option<String>,
    #[serde(default)]
    pub allow_env_vars: Vec<String>,
    #[serde(default)]
    pub allow_tmp_prefixes: Vec<String>,
    #[serde(default)]
    pub ignore_script_paths: Vec<String>,

    // kind = shell_access
    #[serde(default)]
    pub mention_regex: Option<String>,
    #[serde(default)]
    pub dir_regex: Option<String>,
    #[serde(default)]
    pub allow_commands: Vec<String>,
    #[serde(default)]
    pub allow_subcommands: Vec<String>,
    #[serde(default)]
    pub allow_scripts: Vec<String>,
    #[serde(default)]
    pub redirect_target_regex: Option<String>,
    #[serde(default)]
    pub search_cmds: Vec<String>,
    #[serde(default)]
    pub recursive_ls_flag: bool,

    // kind = command_guard
    #[serde(default)]
    pub reason_prefix: Option<String>,
    #[serde(default)]
    pub reason_suffix: Option<String>,
    #[serde(default)]
    pub uri_regex: Option<String>,
    #[serde(default)]
    pub uri_allow_host_regex: Option<String>,
    #[serde(default)]
    pub uri_reason: Option<String>,
    #[serde(default)]
    pub inline_exec_regex: Option<String>,
    #[serde(default)]
    pub inline_keyword_regex: Option<String>,
    #[serde(default)]
    pub inline_reason: Option<String>,
    #[serde(default)]
    pub port_forward_rules: Vec<PortForwardSpec>,
    #[serde(default)]
    pub tools: Vec<String>,
    #[serde(default)]
    pub backstop_tools: Vec<String>,
    #[serde(default)]
    pub readonly_commands: Vec<String>,
    #[serde(default)]
    pub kill_tools: Vec<String>,
    #[serde(default)]
    pub kill_arg_contains: Option<String>,
    #[serde(default)]
    pub kill_reason: Option<String>,
    #[serde(default)]
    pub tool_reason: Option<String>,
    #[serde(default, alias = "daemon_allow")]
    pub allow_daemons: Option<DaemonAllowSpec>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct RulesFile {
    #[serde(default)]
    pub protected_paths: Vec<String>,
    #[serde(default)]
    pub remote_host_aliases: Vec<String>,
    #[serde(default)]
    pub sensitive_file_names: Vec<String>,
    #[serde(default)]
    pub path_rules: Vec<PathRuleSpec>,
    #[serde(default)]
    pub agy_arg_scan: Vec<AgyArgScanSpec>,
    #[serde(default)]
    pub bash_rules: Vec<BashRuleSpec>,
    /// Opt-in: protect a data directory from direct reads/writes (absent = gate off).
    #[serde(default)]
    pub data_gate: Option<DataGateSpec>,
    /// Opt-in: deny WebSearch/WebFetch on Claude with this reason (absent = allowed).
    #[serde(default)]
    pub claude_web: Option<ClaudeWebSpec>,
    /// Worktree hook directory, relative to the workspace (default `.worktrees`).
    #[serde(default)]
    pub worktree_dir: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct DataGateSpec {
    /// Directory (relative to the workspace or absolute); default = the resolved data dir.
    #[serde(default)]
    pub data_dir: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ClaudeWebSpec {
    #[serde(default)]
    pub reason: Option<String>,
}

fn default_deny_action() -> RuleAction {
    RuleAction::Deny
}

const CORE_PROTECTED_IDS: &[&str] = &[
    "config-dump",
    "launcher-protect",
    "plugin-protect",
    "protected-path",
    "command-too-long",
    "claude-web",
    "data-gate",
    "bash-guard",
    "model-policy",
    "rules-protect",
    "secret-files",
    "rm-recursive-outside",
    "git-force-push",
];

#[derive(Debug, Clone, Serialize)]
pub struct RuleLayerMeta {
    pub layer: String,
    pub path: String,
}

#[derive(Debug, Clone)]
enum CompiledMatcher {
    Regex(String),
    Glob(GlobMatcher),
}

impl CompiledMatcher {
    fn compile(kind: PathMatchKind, pat: &str, validate_eager: bool) -> Result<Self, String> {
        match kind {
            PathMatchKind::Regex | PathMatchKind::ResolvedRegex => {
                if validate_eager {
                    Regex::new(pat).map_err(|e| e.to_string())?;
                }
                Ok(CompiledMatcher::Regex(pat.to_string()))
            }
            PathMatchKind::Glob | PathMatchKind::ResolvedGlob => Glob::new(pat)
                .map(|g| CompiledMatcher::Glob(g.compile_matcher()))
                .map_err(|e| e.to_string()),
        }
    }

    fn is_resolved(&self, kind: PathMatchKind) -> bool {
        matches!(kind, PathMatchKind::ResolvedRegex | PathMatchKind::ResolvedGlob)
    }

    fn matches(&self, candidate: &str) -> bool {
        match self {
            CompiledMatcher::Regex(pat) => regex_dyn_cached(pat).is_some_and(|re| re.is_match(candidate)),
            CompiledMatcher::Glob(gm) => gm.is_match(candidate),
        }
    }
}

#[derive(Debug, Clone)]
struct CompiledPathRule {
    spec: PathRuleSpec,
    matcher: CompiledMatcher,
    unless: Option<Regex>,
}

#[derive(Debug, Clone)]
struct CompiledAgyScan {
    spec: AgyArgScanSpec,
    matcher: CompiledMatcher,
}

#[derive(Debug, Clone)]
struct CompiledCommandGuard {
    reason_prefix: String,
    reason_suffix: String,
    uri_pat: Option<String>,
    uri_allow_host_pat: Option<String>,
    uri_reason: String,
    inline_exec_pat: Option<String>,
    inline_keyword_pat: Option<String>,
    inline_reason: String,
    port_forward_rules: Vec<(String, String)>,
    tools: HashSet<String>,
    backstop_tools: Vec<String>,
    backstop_pat: Option<String>,
    readonly_commands: HashSet<String>,
    kill_tools: HashSet<String>,
    kill_arg_contains: String,
    kill_reason: String,
    tool_reason: String,
    allow_daemons: Option<DaemonAllowSpec>,
}

#[derive(Debug, Clone)]
enum CompiledBashKind {
    Regex {
        pattern: String,
        unless: Option<String>,
        remote_only: bool,
    },
    WorktreeScript {
        script_pat: String,
        exclude_pat: Option<String>,
        allow_env_vars: Vec<String>,
        allow_tmp_prefixes: Vec<String>,
        ignore_script_paths: Vec<String>,
    },
    ShellAccess {
        mention_pat: String,
        dir_pat: Option<String>,
        allow_commands: HashSet<String>,
        allow_subcommands: Vec<(String, String)>,
        allow_scripts: Vec<String>,
        redirect_pat: Option<String>,
        search_cmds: HashSet<String>,
        recursive_ls_flag: bool,
    },
    CommandGuard(Box<CompiledCommandGuard>),
}

#[derive(Debug, Clone)]
struct CompiledBashRule {
    id: String,
    action: RuleAction,
    reason: String,
    prefilter: Vec<String>,
    kind: CompiledBashKind,
}

#[derive(Debug, Clone)]
pub struct RulesEngine {
    pub layers: Vec<RuleLayerMeta>,
    pub warnings: Vec<String>,
    pub protected_paths: Vec<String>,
    pub remote_host_aliases: Vec<String>,
    pub sensitive_file_names: Vec<String>,
    path_rules: Vec<CompiledPathRule>,
    agy_arg_scans: Vec<CompiledAgyScan>,
    bash_rules: Vec<CompiledBashRule>,
    data_gate: Option<DataGateSpec>,
    claude_web: Option<String>,
    worktree_dir: Option<String>,
}

mod load;
mod core_guard;
mod data_gate;
mod shell_parse;
mod command_guard;
mod worktree;
#[cfg(test)]
mod tests;
#[cfg(test)]
mod tests_cmd;
#[cfg(test)]
mod tests_t6;
#[cfg(test)]
mod tests_t6b;
#[cfg(test)]
mod tests_data;
#[cfg(test)]
mod tests_t11;

use self::{core_guard::*, data_gate::*, shell_parse::*, command_guard::*, worktree::*};

impl RulesEngine {
    pub fn policy_dump(&self, ws: &Path) -> Value {
        serde_json::json!({
            "workspace": ws.to_string_lossy(),
            "tighten_only": true,
            "core_rules": CORE_PROTECTED_IDS,
            "layers": self.layers,
            "protected_paths": self.protected_paths,
            "remote_host_aliases": self.remote_host_aliases,
            "sensitive_file_names": self.sensitive_file_names,
            "path_rules": self.path_rules.iter().map(|r| serde_json::json!({
                "id": r.spec.id,
                "tools": r.spec.tools,
                "action": r.spec.action,
                "match_kind": r.spec.match_kind,
                "pattern": r.spec.pattern,
            })).collect::<Vec<_>>(),
            "agy_arg_scan": self.agy_arg_scans.iter().map(|r| serde_json::json!({
                "id": r.spec.id,
                "action": r.spec.action,
                "pattern": r.spec.pattern,
            })).collect::<Vec<_>>(),
            "bash_rules": self.bash_rules.iter().map(|r| serde_json::json!({
                "id": r.id,
                "action": r.action,
            })).collect::<Vec<_>>(),
            "warnings": self.warnings,
        })
    }

    fn worktree_dir(&self) -> &str {
        self.worktree_dir.as_deref().unwrap_or(".worktrees")
    }

    pub fn evaluate(&self, input: &HookInput, paths: &WorkspacePaths) -> HookOutcome {
        if input.event == "WorktreeCreate" {
            return handle_worktree_create(input, paths, self.worktree_dir());
        }
        if input.event == "WorktreeRemove" {
            handle_worktree_remove(input, paths, self.worktree_dir());
            return HookOutcome::default();
        }
        if input.event != "PreToolUse" {
            return HookOutcome::default();
        }

        let mut best: Option<(Decision, String, String, String)> = None;
        let record = |best: &mut Option<(Decision, String, String, String)>,
                      d: Decision,
                      rule: String,
                      hook: String,
                      reason: String| {
            let replace = match best {
                None => true,
                Some((cur, _, _, _)) => d > *cur,
            };
            if replace {
                *best = Some((d, rule, hook, reason));
            }
        };

        // 1. Built-in core guard
        let tool_cwd = effective_tool_cwd(input, &paths.workspace);
        let core = eval_core_guard(input, &self.protected_paths, &self.sensitive_file_names, self.claude_web.as_deref(), &paths.audit_root, &tool_cwd)
            .map(|(rule, reason)| (core_rule_decision(&rule, input.host), rule, reason))
            .or_else(|| {
                eval_default_guards(input, &paths.workspace, &tool_cwd, &self.sensitive_file_names)
            });
        if let Some((d, rule, reason)) = core {
            record(&mut best, d, rule, "guard".to_string(), reason);
        }

        // 2. Built-in data-gate (skips if HARNESS_GATEWAY=1)
        if best.as_ref().is_none_or(|b| b.0 != Decision::Deny) {
            let gated = self.data_gate.as_ref().and_then(|g| {
                let mut p = paths.clone();
                if let Some(d) = g.data_dir.as_deref().filter(|d| !d.trim().is_empty()) {
                    p.data_dir = lexical_path(&paths.workspace, d.trim());
                }
                eval_data_gate(input, &p, &tool_cwd)
            });
            if let Some(reason) = gated {
                record(
                    &mut best,
                    Decision::Deny,
                    "data-gate".to_string(),
                    "data-gate".to_string(),
                    reason,
                );
            }
        }

        // 3. Built-in bash-guard (python - / multiline python -c / heredoc > 3 lines)
        if best.as_ref().is_none_or(|b| b.0 != Decision::Deny) {
            if let Some(reason) = eval_bash_guard_deny(input) {
                record(
                    &mut best,
                    Decision::Deny,
                    "bash-guard".to_string(),
                    "bash-guard".to_string(),
                    reason,
                );
            }
        }

        // 4. Declarative path_rules
        if best.as_ref().is_none_or(|b| b.0 != Decision::Deny) {
            if let Some((d, rule, reason)) = self.eval_path_rules(input, &tool_cwd) {
                record(&mut best, d, rule.clone(), rule, reason);
            }
        }

        // 5. Declarative agy_arg_scan (only for agy)
        if input.host == Host::Agy && best.as_ref().is_none_or(|b| b.0 != Decision::Deny) {
            if let Some((d, rule, reason)) = self.eval_agy_arg_scans(input, &tool_cwd) {
                record(&mut best, d, rule.clone(), rule, reason);
            }
        }

        // 6. Declarative bash_rules
        if best.as_ref().is_none_or(|b| b.0 != Decision::Deny) {
            if let Some((d, rule, reason)) = self.eval_bash_rules(input, &tool_cwd) {
                record(&mut best, d, rule.clone(), rule, reason);
            }
        }

        if let Some((decision, rule_id, hook_name, reason)) = best {
            return HookOutcome {
                decision: Some(decision),
                reason: Some(reason),
                rule_id: Some(rule_id),
                hook_name: Some(hook_name),
                ..Default::default()
            };
        }

        // 7. Claude-only non-blocking enhancements (model-policy & bash-guard default timeout)
        if input.host == Host::Claude {
            if let Some(outcome) = eval_model_policy(input, &paths.workspace) {
                return outcome;
            }
            if let Some(updated) = eval_bash_default_timeout(input) {
                return HookOutcome {
                    updated_input: Some(updated),
                    ..Default::default()
                };
            }
        }

        HookOutcome::default()
    }

    fn eval_path_rules(&self, input: &HookInput, tool_cwd: &Path) -> Option<(Decision, String, String)> {
        let tool = input.tool_name.as_deref()?;
        let candidates = extract_tool_paths(tool, &input.tool_input);
        if candidates.is_empty() {
            return None;
        }
        let mut best: Option<(Decision, String, String)> = None;
        for rule in &self.path_rules {
            if !rule.spec.tools.is_empty()
                && !rule
                    .spec
                    .tools
                    .iter()
                    .any(|t| t == "*" || t.eq_ignore_ascii_case(tool))
            {
                continue;
            }
            let mut matched = false;
            for raw in &candidates {
                // `unless` sees the same normalized forms as `pattern`.
                let forms: Vec<String> = if rule.matcher.is_resolved(rule.spec.match_kind) {
                    resolve_posix_and_real(tool_cwd, raw)
                } else {
                    vec![normalize_slashes(raw)]
                };
                for form in &forms {
                    if rule.unless.as_ref().is_some_and(|u| u.is_match(form)) {
                        continue;
                    }
                    if rule.matcher.matches(form) {
                        matched = true;
                        break;
                    }
                }
                if matched {
                    break;
                }
            }
            if matched {
                let dec = rule.spec.action.to_decision();
                if best.as_ref().is_none_or(|b| dec > b.0) {
                    best = Some((dec, rule.spec.id.clone(), rule.spec.reason.clone()));
                }
                if dec == Decision::Deny {
                    break;
                }
            }
        }
        best
    }

    fn eval_agy_arg_scans(
        &self,
        input: &HookInput,
        tool_cwd: &Path,
    ) -> Option<(Decision, String, String)> {
        let raw_tool = input.raw_tool_name.as_deref().unwrap_or("");
        let mut pairs = Vec::new();
        collect_arg_strings(&input.raw_args, "", &mut pairs);
        if pairs.is_empty() {
            return None;
        }
        let mut best: Option<(Decision, String, String)> = None;
        for scan in &self.agy_arg_scans {
            let skip_cmd = scan
                .spec
                .skip_command_line_on
                .iter()
                .any(|t| t == raw_tool);
            let mut matched = false;
            for (k, v) in &pairs {
                if scan.spec.exclude_keys.iter().any(|ek| ek == k) {
                    continue;
                }
                if skip_cmd
                    && (k == "CommandLine" || k == "commandLine" || k == "command")
                {
                    continue;
                }
                if scan.matcher.is_resolved(scan.spec.match_kind) {
                    for res in resolve_posix_and_real(tool_cwd, v) {
                        if scan.matcher.matches(&res) {
                            matched = true;
                            break;
                        }
                    }
                } else if scan.matcher.matches(&normalize_slashes(v)) {
                    matched = true;
                }
                if matched {
                    break;
                }
            }
            if matched {
                let dec = scan.spec.action.to_decision();
                if best.as_ref().is_none_or(|b| dec > b.0) {
                    best = Some((dec, scan.spec.id.clone(), scan.spec.reason.clone()));
                }
                if dec == Decision::Deny {
                    break;
                }
            }
        }
        best
    }

    fn eval_bash_rules(&self, input: &HookInput, tool_cwd: &Path) -> Option<(Decision, String, String)> {
        let tool = input.tool_name.as_deref()?;
        if tool != "Bash" && tool != "PowerShell" {
            return None;
        }
        let cmd = input.tool_input.get("command").and_then(Value::as_str)?;
        if cmd.trim().is_empty() {
            return None;
        }
        let ncmd = collapse_line_continuations(cmd);
        let is_remote = self.is_remote_command(cmd);
        let cwd_paths = resolve_posix_and_real(tool_cwd, ".");
        let hays = prefilter_haystacks(cmd);
        let mut best: Option<(Decision, String, String)> = None;

        for rule in &self.bash_rules {
            if !rule.prefilter.is_empty()
                && !rule.prefilter.iter().any(|pf| {
                    hays.iter().any(|h| has_ascii_ci(h, pf))
                        || cwd_paths.iter().any(|p| has_ascii_ci(p, pf))
                })
            {
                continue;
            }
            let hit = match &rule.kind {
                CompiledBashKind::Regex {
                    pattern,
                    unless,
                    remote_only,
                } => {
                    if *remote_only && !is_remote {
                        None
                    } else if regex_dyn_cached(pattern).is_some_and(|r| r.is_match(&ncmd))
                        && !unless
                            .as_deref()
                            .and_then(regex_dyn_cached)
                            .is_some_and(|u| u.is_match(cmd))
                    {
                        Some(rule.reason.clone())
                    } else {
                        None
                    }
                }
                CompiledBashKind::WorktreeScript {
                    script_pat,
                    exclude_pat,
                    allow_env_vars,
                    allow_tmp_prefixes,
                    ignore_script_paths,
                } => {
                    if let Some(script_re) = regex_dyn_cached(script_pat) {
                        let exclude_re = exclude_pat.as_deref().and_then(regex_dyn_cached);
                        if check_worktree_script(
                            cmd,
                            tool_cwd,
                            script_re,
                            exclude_re,
                            allow_env_vars,
                            allow_tmp_prefixes,
                            ignore_script_paths,
                        ) {
                            Some(rule.reason.clone())
                        } else {
                            None
                        }
                    } else {
                        None
                    }
                }
                CompiledBashKind::ShellAccess {
                    mention_pat,
                    dir_pat,
                    allow_commands,
                    allow_subcommands,
                    allow_scripts,
                    redirect_pat,
                    search_cmds,
                    recursive_ls_flag,
                } => {
                    if let Some(mention_re) = regex_dyn_cached(mention_pat) {
                        let dir_re = dir_pat.as_deref().and_then(regex_dyn_cached);
                        let redirect_re = redirect_pat.as_deref().and_then(regex_dyn_cached);
                        if check_shell_access(
                            cmd,
                            tool_cwd,
                            mention_re,
                            dir_re,
                            allow_commands,
                            allow_subcommands,
                            allow_scripts,
                            redirect_re,
                            search_cmds,
                            *recursive_ls_flag,
                        ) {
                            Some(rule.reason.clone())
                        } else {
                            None
                        }
                    } else {
                        None
                    }
                }
                CompiledBashKind::CommandGuard(cg) => check_command_guard(cmd, cg)
                    .map(|sub| format!("{}{sub}{}", cg.reason_prefix, cg.reason_suffix)),
            };

            if let Some(reason) = hit {
                let dec = rule.action.to_decision();
                if best.as_ref().is_none_or(|b| dec > b.0) {
                    best = Some((dec, rule.id.clone(), reason));
                }
                if dec == Decision::Deny {
                    break;
                }
            }
        }
        best
    }

    fn is_remote_command(&self, cmd: &str) -> bool {
        let lower = cmd.to_ascii_lowercase();
        for kw in ["ssh", "scp", "sftp", "rsync"] {
            if has_word(&lower, kw) {
                return true;
            }
        }
        for alias in &self.remote_host_aliases {
            let needle = format!("{}:", alias.to_ascii_lowercase());
            if lower.contains(&needle) {
                return true;
            }
        }
        false
    }
}

fn effective_tool_cwd(input: &HookInput, ws: &Path) -> PathBuf {
    match input
        .tool_cwd
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        Some(raw) => {
            let p = Path::new(raw);
            if p.is_absolute() {
                p.to_path_buf()
            } else {
                lexical_path(ws, raw)
            }
        }
        None => ws.to_path_buf(),
    }
}

// ============================================================================
// Core bash-guard & model-policy
// ============================================================================

fn eval_bash_guard_deny(input: &HookInput) -> Option<String> {
    let tool = input.tool_name.as_deref()?;
    if tool != "Bash" && tool != "PowerShell" {
        return None;
    }
    let cmd = input.tool_input.get("command").and_then(Value::as_str)?;
    let deny_msg = "Write file vao scratchpad roi chay (khong dung python - / python -c nhieu dong / heredoc dai).";

    if has_ascii_ci(cmd, "py") {
        if regex_cached(r"(?m)(?:^|[;&|(]\s*)(?:py|python3?)(?:\.exe)?(?:\s+-[A-Za-z])*\s+-(?:\s|$)")
            .is_some_and(|r| r.is_match(cmd))
        {
            return Some(format!(
                "bash-guard: python doc stdin (python -). {deny_msg}"
            ));
        }

        if cmd.contains('\n')
            && regex_cached(r"(?m)(?:^|[;&|(]\s*)(?:py|python3?)(?:\.exe)?\s+-c\s")
                .is_some_and(|r| r.is_match(cmd))
        {
            return Some(format!(
                "bash-guard: python -c nhieu dong. {deny_msg}"
            ));
        }
    }

    if cmd.contains("<<") {
        if let Some(re) = regex_cached(r#"<<-?\s*(['"]?)([A-Za-z_]\w*)['"]?[^\n]*\n([\s\S]*)"#) {
            if let Some(caps) = re.captures(cmd) {
                let tag = caps.get(2).map_or("", |m| m.as_str());
                let body = caps.get(3).map_or("", |m| m.as_str());
                let lines: Vec<&str> = body.split('\n').collect();
                let count = lines
                    .iter()
                    .position(|l| l.trim() == tag)
                    .unwrap_or(lines.len());
                if count > 3 {
                    return Some(format!("bash-guard: heredoc {count} dong. {deny_msg}"));
                }
            }
        }
    }

    None
}

fn eval_bash_default_timeout(input: &HookInput) -> Option<Value> {
    if input.tool_name.as_deref() != Some("Bash") {
        return None;
    }
    let ti = input.tool_input.as_object()?;
    if ti.get("run_in_background").and_then(Value::as_bool) == Some(true) {
        return None;
    }
    if ti.get("timeout").is_some_and(|v| !v.is_null()) {
        return None;
    }
    let mut updated = ti.clone();
    updated.insert(
        "timeout".to_string(),
        Value::Number(BASH_DEFAULT_TIMEOUT_MS.into()),
    );
    Some(Value::Object(updated))
}

fn eval_model_policy(input: &HookInput, ws: &Path) -> Option<HookOutcome> {
    let tool = input.tool_name.as_deref()?;
    if tool != "Agent" && tool != "Task" {
        return None;
    }
    let ti = input.tool_input.as_object()?;
    let cfg = load_model_policy(ws);
    if cfg.mode == "audit" {
        return None;
    }

    let role = ti
        .get("subagent_type")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("general-purpose");

    let role_cfg = cfg.roles.get(role);
    let default_model = pick_model(&cfg.default_model).unwrap_or("sonnet");
    let eff_model = role_cfg
        .and_then(|r| r.model.as_deref())
        .and_then(pick_model)
        .unwrap_or(default_model);
    let eff_effort = role_cfg.and_then(|r| r.effort.as_deref());
    let allow_opus = role_cfg.is_some_and(|r| r.allow_opus)
        || eff_model.contains("opus")
        || cfg.opus_allowed.iter().any(|x| x == role);

    let given = ti
        .get("model")
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or("");

    if given.is_empty() {
        let mut upd = ti.clone();
        upd.insert(
            "model".to_string(),
            Value::String(eff_model.to_string()),
        );
        if cfg.fill_effort {
            if let Some(eff) = eff_effort {
                if !ti.get("effort").is_some_and(|v| !v.is_null()) {
                    upd.insert("effort".to_string(), Value::String(eff.to_string()));
                }
            }
        }
        return Some(HookOutcome {
            decision: Some(Decision::Allow),
            reason: Some(format!("model-policy: vai tro {role} -> {eff_model}")),
            rule_id: Some("model-filled".to_string()),
            hook_name: Some("model-policy".to_string()),
            updated_input: Some(Value::Object(upd)),
            ..Default::default()
        });
    }

    if given.to_ascii_lowercase().contains("opus") && !allow_opus {
        return Some(HookOutcome {
            decision: Some(Decision::Ask),
            reason: Some(format!(
                "model-policy: vai tro {role} mac dinh {eff_model}, khong phai opus"
            )),
            rule_id: Some("opus-not-allowed".to_string()),
            hook_name: Some("model-policy".to_string()),
            ..Default::default()
        });
    }

    None
}

fn pick_model(raw: &str) -> Option<&'static str> {
    let lower = raw.trim().to_ascii_lowercase();
    MODEL_ALIASES
        .iter()
        .copied()
        .find(|m| *m == lower.as_str())
}

// ============================================================================
// Lightweight static regex cache (avoids recompiling core regexes)
// ============================================================================

fn regex_cached(pattern: &'static str) -> Option<&'static Regex> {
    use std::sync::{Mutex, OnceLock};
    static CACHE: OnceLock<Mutex<HashMap<&'static str, Option<&'static Regex>>>> = OnceLock::new();
    let lock = CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    let mut map = lock.lock().ok()?;
    if let Some(entry) = map.get(pattern) {
        return *entry;
    }
    let compiled = Regex::new(pattern).ok().map(|r| -> &'static Regex { Box::leak(Box::new(r)) });
    map.insert(pattern, compiled);
    compiled
}

fn regex_dyn_cached(pattern: &str) -> Option<&'static Regex> {
    use std::sync::{Mutex, OnceLock};
    static CACHE: OnceLock<Mutex<HashMap<String, Option<&'static Regex>>>> = OnceLock::new();
    let lock = CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    let mut map = lock.lock().ok()?;
    if let Some(entry) = map.get(pattern) {
        return *entry;
    }
    let compiled = Regex::new(pattern).ok().map(|r| -> &'static Regex { Box::leak(Box::new(r)) });
    map.insert(pattern.to_string(), compiled);
    compiled
}


/// Strings a prefilter is matched against. Principle: a prefilter may only be looser than
/// or equal to the inner parsers, so it must see every form they can see: raw cmd,
/// quote-stripped (plain_norm), and shlex tokens (backslash/quote-unescaped) of the whole
/// command, each segment, command substitutions and quoted tokens one level down.
pub(super) fn prefilter_haystacks(cmd: &str) -> Vec<String> {
    fn join(s: &str, out: &mut Vec<String>, deep: bool) {
        let toks = shlex_split(s);
        if deep {
            for t in toks.iter().filter(|t| t.contains(char::is_whitespace)) {
                join(t, out, false);
            }
        }
        out.push(toks.join(" "));
    }
    let mut out = vec![cmd.to_string(), plain_norm(cmd)];
    join(cmd, &mut out, true);
    for seg in split_cmd_segments(cmd) {
        join(&seg, &mut out, true);
    }
    for sub in extract_command_subs(cmd) {
        join(&sub, &mut out, true);
    }
    out
}
