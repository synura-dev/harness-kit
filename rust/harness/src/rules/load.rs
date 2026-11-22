use super::*;

/// Cheap check, no git spawn: `<ws>/.git/index` mentions `.harness/rules.toml`.
/// Matches only the root entry: byte before is not `/` or a name char, byte after is NUL.
/// shortcut: index v4 (prefix-compressed names; detected via header version), unreadable index,
/// linked-worktree `.git` files and indexes over 64 MiB are not inspected => not fail-closed.
pub(super) fn git_tracks_rules(ws: &Path) -> bool {
    use std::io::Read;
    const NEEDLE: &[u8] = b".harness/rules.toml";
    let Ok(f) = std::fs::File::open(ws.join(".git").join("index")) else {
        return false;
    };
    let mut buf = Vec::new();
    if f.take(64 << 20).read_to_end(&mut buf).is_err() {
        return false;
    }
    if buf.len() < 8 || &buf[..4] != b"DIRC" || buf[4..8] == [0, 0, 0, 4] {
        return false;
    }
    buf.windows(NEEDLE.len()).enumerate().any(|(i, w)| {
        w == NEEDLE
            && buf.get(i + NEEDLE.len()) == Some(&0)
            && i > 0
            && !(buf[i - 1] == b'/' || buf[i - 1].is_ascii_alphanumeric() || buf[i - 1] == b'_')
    })
}

impl RulesEngine {
    pub fn load_for_workspace(ws: &Path) -> Self {
        Self::load_filtered(ws, None, None)
    }

    pub fn load_for_hook(ws: &Path, host: Host, tool_name: Option<&str>) -> Self {
        Self::load_filtered(ws, Some(host), tool_name)
    }

    pub(super) fn load_filtered(ws: &Path, host_filter: Option<Host>, tool_filter: Option<&str>) -> Self {
        let mut engine = Self::empty();
        if tool_filter.is_none() || matches!(tool_filter, Some("Bash" | "PowerShell")) {
            let act = if host_filter == Some(Host::Agy) { RuleAction::Deny } else { RuleAction::Ask };
            if let Ok(c) = compile_bash_rule(rules_mention_bash_spec(act)) {
                engine.bash_rules.push(c);
            }
        }

        for (layer, path) in discover_rule_files(ws) {
            match std::fs::read_to_string(&path) {
                Ok(raw) => {
                    if let Err(err) = engine.merge_toml_filtered(
                        &layer,
                        &path.to_string_lossy(),
                        &raw,
                        host_filter,
                        tool_filter,
                    ) {
                        engine.warnings.push(format!("{}: {err}", path.display()));
                        engine.fail_closed_layer(&layer, &path, &err, host_filter);
                    }
                }
                Err(err) => {
                    engine.warnings.push(format!("{}: {err}", path.display()));
                    engine.fail_closed_layer(&layer, &path, &err.to_string(), host_filter);
                }
            }
        }
        // A git-tracked project rules file that vanished is a load error, not "no project layer"
        // (otherwise `bash x.sh` could delete the rules file and silently lift the guard).
        let project_rules = ws.join(".harness").join("rules.toml");
        if !std::fs::symlink_metadata(&project_rules).is_ok() && git_tracks_rules(ws) {
            let msg = "tracked in git but missing";
            engine.warnings.push(format!("{}: {msg}", project_rules.display()));
            engine.fail_closed_layer("project", &project_rules, msg, host_filter);
        }
        engine
    }

    #[cfg(test)]
    pub fn from_toml_str(raw: &str) -> Result<Self, String> {
        let mut engine = Self::empty();
        engine.merge_toml_str("project", "inline", raw)?;
        Ok(engine)
    }

    pub fn empty() -> Self {
        Self {
            layers: Vec::new(),
            warnings: Vec::new(),
            protected_paths: Vec::new(),
            remote_host_aliases: Vec::new(),
            sensitive_file_names: Vec::new(),
            path_rules: Vec::new(),
            agy_arg_scans: Vec::new(),
            bash_rules: Vec::new(),
            data_gate: None,
            claude_web: None,
            worktree_dir: None,
        }
    }

    #[cfg(test)]
    pub fn merge_toml_str(&mut self, layer: &str, path_label: &str, raw: &str) -> Result<(), String> {
        self.merge_toml_filtered(layer, path_label, raw, None, None)
    }

    pub(super) fn merge_toml_filtered(
        &mut self,
        layer: &str,
        path_label: &str,
        raw: &str,
        host_filter: Option<Host>,
        tool_filter: Option<&str>,
    ) -> Result<(), String> {
        let parsed: RulesFile = toml::from_str(raw).map_err(|e| format!("TOML parse error: {e}"))?;
        self.layers.push(RuleLayerMeta {
            layer: layer.to_string(),
            path: path_label.to_string(),
        });

        self.add_protected_paths(parsed.protected_paths);
        self.add_aliases(parsed.remote_host_aliases);
        self.add_sensitive_names(parsed.sensitive_file_names);
        for old in ["daemon_allow", "allowed_dbpath_env", "allowed_dbpath_default"] {
            if raw.contains(old) {
                self.warnings.push(format!(
                    "layer {layer}: deprecated key '{old}' (use allow_daemons / allowed_paths_env / allowed_paths + path_flag)"
                ));
            }
        }
        if parsed.data_gate.is_some() {
            self.data_gate = parsed.data_gate;
        }
        if let Some(c) = parsed.claude_web {
            self.claude_web = Some(c.reason.unwrap_or_else(|| {
                "guard[claude-web]: WebSearch/WebFetch blocked on Claude.".to_string()
            }));
        }
        if let Some(d) = parsed.worktree_dir {
            let d = d.trim().trim_matches('/').to_string();
            if d.is_empty() || d.split('/').any(|c| c == ".." || c == ".git") || d.starts_with('/') {
                self.warnings.push(format!("layer {layer}: invalid worktree_dir '{d}' ignored"));
            } else {
                self.worktree_dir = Some(d);
            }
        }

        let is_shell_tool = matches!(tool_filter, Some("Bash" | "PowerShell"));
        let skip_path_rules = is_shell_tool;
        let skip_agy_scans = matches!(host_filter, Some(Host::Claude));
        let skip_bash_rules = tool_filter.is_some() && !is_shell_tool;

        // Layers are a UNION: every rule of every layer stays and is evaluated; the final
        // decision is the strictest match, so no layer can remove or loosen another's rule.
        // '@' is banned in ids (reserved) so ids can never be forged to look layered.
        let bad_id = parsed
            .path_rules
            .iter()
            .map(|r| &r.id)
            .chain(parsed.agy_arg_scan.iter().map(|r| &r.id))
            .chain(parsed.bash_rules.iter().map(|r| &r.id))
            .find(|id| id.contains('@'));
        if let Some(id) = bad_id {
            return Err(format!("rule id '{id}' contains reserved character '@'"));
        }

        let fail_action = if host_filter == Some(Host::Agy) {
            RuleAction::Deny
        } else {
            RuleAction::Ask
        };
        if !skip_path_rules {
            for pr in parsed.path_rules {
                if CORE_PROTECTED_IDS.contains(&pr.id.as_str()) {
                    self.warnings.push(format!(
                        "layer {layer}: core rule id '{}' cannot be overridden",
                        pr.id
                    ));
                    continue;
                }
                if let Some(t) = tool_filter {
                    if !pr.tools.is_empty()
                        && !pr
                            .tools
                            .iter()
                            .any(|x| x == "*" || x.eq_ignore_ascii_case(t))
                    {
                        continue;
                    }
                }
                match compile_path_rule(pr.clone()) {
                    Ok(c) => self.path_rules.push(c),
                    Err(e) => {
                        self.warnings.push(format!("layer {layer}: {e}"));
                        let rep = fail_closed_path_spec(&pr.id, pr.tools.clone(), fail_action, &e);
                        if let Ok(c) = compile_path_rule(rep) {
                            self.path_rules.push(c);
                        }
                    }
                }
            }
        }

        if !skip_agy_scans {
            for sc in parsed.agy_arg_scan {
                if CORE_PROTECTED_IDS.contains(&sc.id.as_str()) {
                    self.warnings.push(format!(
                        "layer {layer}: core rule id '{}' cannot be overridden",
                        sc.id
                    ));
                    continue;
                }
                match CompiledMatcher::compile(sc.match_kind, &sc.pattern, true) {
                    Ok(matcher) => self.agy_arg_scans.push(CompiledAgyScan { spec: sc, matcher }),
                    Err(e) => {
                        let msg = format!("agy_arg_scan '{}': {e}", sc.id);
                        self.warnings.push(format!("layer {layer}: {msg}"));
                        let rep = AgyArgScanSpec {
                            id: sc.id.clone(),
                            action: fail_action,
                            match_kind: PathMatchKind::Regex,
                            pattern: "(?s).*".to_string(),
                            exclude_keys: Vec::new(),
                            skip_command_line_on: Vec::new(),
                            reason: fail_closed_reason(&sc.id, &msg),
                        };
                        if let Ok(matcher) = CompiledMatcher::compile(rep.match_kind, &rep.pattern, true) {
                            self.agy_arg_scans.push(CompiledAgyScan { spec: rep, matcher });
                        }
                    }
                }
            }
        }

        if !skip_bash_rules {
            for br in parsed.bash_rules {
                if CORE_PROTECTED_IDS.contains(&br.id.as_str()) {
                    self.warnings.push(format!(
                        "layer {layer}: core rule id '{}' cannot be overridden",
                        br.id
                    ));
                    continue;
                }
                match compile_bash_rule(br.clone()) {
                    Ok(c) => self.bash_rules.push(c),
                    Err(e) => {
                        self.warnings.push(format!("layer {layer}: {e}"));
                        if let Ok(c) = compile_bash_rule(fail_closed_bash_spec(&br.id, fail_action, &e)) {
                            self.bash_rules.push(c);
                        }
                    }
                }
            }
        }

        Ok(())
    }

    /// A rules file that cannot be read/parsed must not silently drop its protections:
    /// one catch-all rule on write tools (ask on Claude, deny on agy which has no ask).
    fn fail_closed_layer(&mut self, layer: &str, path: &Path, err: &str, host: Option<Host>) {
        let action = if host == Some(Host::Agy) { RuleAction::Deny } else { RuleAction::Ask };
        let id = format!("rules-load-error@{layer}");
        let msg = format!("{}: {err}", path.display());
        let tools = ["Write", "Edit", "MultiEdit", "NotebookEdit"]
            .map(String::from)
            .to_vec();
        if let Ok(c) = compile_path_rule(fail_closed_path_spec(&id, tools, action, &msg)) {
            self.path_rules.push(c);
        }
        if let Ok(c) = compile_bash_rule(fail_closed_bash_spec(&id, action, &msg)) {
            self.bash_rules.push(c);
        }
    }

    pub(super) fn add_protected_paths(&mut self, items: Vec<String>) {
        for p in items {
            let trimmed = p.trim().to_string();
            if !trimmed.is_empty() && !self.protected_paths.contains(&trimmed) {
                self.protected_paths.push(trimmed);
            }
        }
    }

    pub(super) fn add_aliases(&mut self, items: Vec<String>) {
        for a in items {
            let trimmed = a.trim().to_string();
            if !trimmed.is_empty() && !self.remote_host_aliases.contains(&trimmed) {
                self.remote_host_aliases.push(trimmed);
            }
        }
    }

    pub(super) fn add_sensitive_names(&mut self, items: Vec<String>) {
        for s in items {
            let trimmed = s.trim().to_string();
            if !trimmed.is_empty() && !self.sensitive_file_names.contains(&trimmed) {
                self.sensitive_file_names.push(trimmed);
            }
        }
    }

}


fn fail_closed_reason(id: &str, err: &str) -> String {
    format!("rule '{id}' khong nap duoc ({err}); chan de an toan / rule failed to load, failing closed")
}

fn fail_closed_path_spec(id: &str, tools: Vec<String>, action: RuleAction, err: &str) -> PathRuleSpec {
    PathRuleSpec {
        id: id.to_string(),
        tools,
        action,
        match_kind: PathMatchKind::Regex,
        pattern: "(?s).*".to_string(),
        unless: None,
        reason: fail_closed_reason(id, err),
    }
}

fn fail_closed_bash_spec(id: &str, action: RuleAction, err: &str) -> BashRuleSpec {
    serde_json::from_value(serde_json::json!({
        "id": id,
        "kind": "regex",
        "action": action,
        "pattern": "(?s).*",
        "reason": fail_closed_reason(id, err),
    }))
    .expect("static bash rule spec")
}

pub(super) fn compile_path_rule(spec: PathRuleSpec) -> Result<CompiledPathRule, String> {
    let matcher = CompiledMatcher::compile(spec.match_kind, &spec.pattern, true)
        .map_err(|e| format!("path_rule '{}': {e}", spec.id))?;
    let unless = match &spec.unless {
        Some(u) => Some(Regex::new(u).map_err(|e| format!("path_rule '{}' unless: {e}", spec.id))?),
        None => None,
    };
    Ok(CompiledPathRule {
        spec,
        matcher,
        unless,
    })
}

pub(super) fn compile_bash_rule(spec: BashRuleSpec) -> Result<CompiledBashRule, String> {
    let reason = spec
        .reason
        .clone()
        .unwrap_or_else(|| format!("blocked by {}", spec.id));
    let prefilter: Vec<String> = spec
        .prefilter
        .iter()
        .filter(|p| !p.is_empty())
        .map(|p| p.to_ascii_lowercase())
        .collect();
    let kind = match spec.kind {
        BashRuleKind::Regex => {
            let pat = spec
                .pattern
                .ok_or_else(|| format!("bash_rule '{}': missing pattern", spec.id))?;
            {
                Regex::new(&pat).map_err(|e| format!("bash_rule '{}': {e}", spec.id))?;
                if let Some(u) = &spec.unless {
                    Regex::new(u).map_err(|e| format!("bash_rule '{}' unless: {e}", spec.id))?;
                }
            }
            CompiledBashKind::Regex {
                pattern: pat,
                unless: spec.unless,
                remote_only: spec.remote_only,
            }
        }
        BashRuleKind::WorktreeScript => {
            let pat = spec
                .script_regex
                .ok_or_else(|| format!("bash_rule '{}': missing script_regex", spec.id))?;
            {
                Regex::new(&pat).map_err(|e| format!("bash_rule '{}': {e}", spec.id))?;
                if let Some(e) = &spec.exclude_regex {
                    Regex::new(e)
                        .map_err(|err| format!("bash_rule '{}' exclude_regex: {err}", spec.id))?;
                }
            }
            CompiledBashKind::WorktreeScript {
                script_pat: pat,
                exclude_pat: spec.exclude_regex,
                allow_env_vars: spec.allow_env_vars,
                allow_tmp_prefixes: spec.allow_tmp_prefixes,
                ignore_script_paths: spec
                    .ignore_script_paths
                    .into_iter()
                    .map(|p| normalize_slashes(&p))
                    .collect(),
            }
        }
        BashRuleKind::ShellAccess => {
            let pat = spec
                .mention_regex
                .ok_or_else(|| format!("bash_rule '{}': missing mention_regex", spec.id))?;
            {
                Regex::new(&pat).map_err(|e| format!("bash_rule '{}': {e}", spec.id))?;
                if let Some(d) = &spec.dir_regex {
                    Regex::new(d)
                        .map_err(|e| format!("bash_rule '{}' dir_regex: {e}", spec.id))?;
                }
                if let Some(r) = &spec.redirect_target_regex {
                    Regex::new(r).map_err(|e| {
                        format!("bash_rule '{}' redirect_target_regex: {e}", spec.id)
                    })?;
                }
            }
            let allow_subcommands = spec
                .allow_subcommands
                .into_iter()
                .filter_map(|s| {
                    let mut parts = s.split_whitespace();
                    Some((parts.next()?.to_string(), parts.next()?.to_string()))
                })
                .collect();
            CompiledBashKind::ShellAccess {
                mention_pat: pat,
                dir_pat: spec.dir_regex,
                allow_commands: spec.allow_commands.into_iter().collect(),
                allow_subcommands,
                allow_scripts: spec
                    .allow_scripts
                    .into_iter()
                    .map(|p| normalize_slashes(&p))
                    .collect(),
                redirect_pat: spec.redirect_target_regex,
                search_cmds: spec.search_cmds.into_iter().collect(),
                recursive_ls_flag: spec.recursive_ls_flag,
            }
        }
        BashRuleKind::CommandGuard => {
            {
                validate_opt_regex(&spec.id, "uri_regex", spec.uri_regex.as_deref())?;
                validate_opt_regex(
                    &spec.id,
                    "uri_allow_host_regex",
                    spec.uri_allow_host_regex.as_deref(),
                )?;
                validate_opt_regex(
                    &spec.id,
                    "inline_exec_regex",
                    spec.inline_exec_regex.as_deref(),
                )?;
                validate_opt_regex(
                    &spec.id,
                    "inline_keyword_regex",
                    spec.inline_keyword_regex.as_deref(),
                )?;
                for p in &spec.port_forward_rules {
                    Regex::new(&p.regex)
                        .map_err(|e| format!("bash_rule '{}' port_forward: {e}", spec.id))?;
                }
            }
            let backstop_pat = if spec.backstop_tools.is_empty() {
                None
            } else {
                let joined = spec
                    .backstop_tools
                    .iter()
                    .map(|t| regex::escape(t))
                    .collect::<Vec<_>>()
                    .join("|");
                let bp = format!(r#"(?:^|[\s'"/!=:(;])(?:{joined})(?:$|[\s'";|&),])"#);
                {
                    Regex::new(&bp)
                        .map_err(|e| format!("bash_rule '{}' backstop: {e}", spec.id))?;
                }
                Some(bp)
            };
            CompiledBashKind::CommandGuard(Box::new(CompiledCommandGuard {
                reason_prefix: spec.reason_prefix.unwrap_or_default(),
                reason_suffix: spec.reason_suffix.unwrap_or_default(),
                uri_pat: spec.uri_regex,
                uri_allow_host_pat: spec.uri_allow_host_regex,
                uri_reason: spec.uri_reason.unwrap_or_else(|| "restricted URI".to_string()),
                inline_exec_pat: spec.inline_exec_regex,
                inline_keyword_pat: spec.inline_keyword_regex,
                inline_reason: spec
                    .inline_reason
                    .unwrap_or_else(|| "restricted inline script".to_string()),
                port_forward_rules: spec
                    .port_forward_rules
                    .into_iter()
                    .map(|p| (p.regex, p.reason))
                    .collect(),
                tools: spec.tools.into_iter().collect(),
                backstop_tools: spec.backstop_tools,
                backstop_pat,
                readonly_commands: spec.readonly_commands.into_iter().collect(),
                kill_tools: spec.kill_tools.into_iter().collect(),
                kill_arg_contains: spec.kill_arg_contains.unwrap_or_default(),
                kill_reason: spec.kill_reason.unwrap_or_else(|| "kill process".to_string()),
                tool_reason: spec
                    .tool_reason
                    .unwrap_or_else(|| "cong cu bi chan".to_string()),
                allow_daemons: spec.allow_daemons,
            }))
        }
    };
    Ok(CompiledBashRule {
        id: spec.id,
        action: spec.action,
        reason,
        prefilter,
        kind,
    })
}

pub(super) fn validate_opt_regex(id: &str, field: &str, pat: Option<&str>) -> Result<(), String> {
    if let Some(p) = pat {
        Regex::new(p).map_err(|e| format!("bash_rule '{id}' {field}: {e}"))?;
    }
    Ok(())
}

