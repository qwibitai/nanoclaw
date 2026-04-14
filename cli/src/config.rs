use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

/// Resolved NanoClaw configuration.
#[derive(Debug, Clone)]
#[allow(dead_code)]
pub struct NanoClawConfig {
    pub project_root: PathBuf,
    pub group_folder: String,
    pub group_jid: String,
    pub group_name: String,
    pub is_main: bool,
    pub model: Option<String>,
    pub effort: Option<String>,
    pub assistant_name: String,
    pub timezone: String,
    pub default_model: String,
    // Derived paths
    pub ipc_dir: PathBuf,
    pub group_dir: PathBuf,
    pub global_dir: PathBuf,
    pub extra_dir: PathBuf,
    pub claude_home: PathBuf,
    pub agent_runner_entry: PathBuf,
    pub db_path: PathBuf,
    // Auth env vars
    pub env_vars: HashMap<String, String>,
    // Model aliases
    pub model_aliases: HashMap<String, String>,
}

impl NanoClawConfig {
    pub fn resolve_model_alias(&self, name: &str) -> String {
        self.model_aliases
            .get(name)
            .cloned()
            .unwrap_or_else(|| name.to_string())
    }

    pub fn effective_model(&self) -> &str {
        self.model.as_deref().unwrap_or(&self.default_model)
    }
}

/// Find the NanoClaw installation directory.
///
/// Resolution order:
/// 1. Explicit `--nanoclaw-dir` argument
/// 2. `NANOCLAW_DIR` environment variable
/// 3. Walk up from current working directory looking for `store/messages.db`
/// 4. `~/nanoclaw`
pub fn find_nanoclaw_dir(explicit: Option<&Path>) -> Result<PathBuf, String> {
    if let Some(p) = explicit {
        return validate_nanoclaw_dir(p);
    }

    if let Ok(env_dir) = std::env::var("NANOCLAW_DIR") {
        let p = PathBuf::from(env_dir);
        if p.exists() {
            return validate_nanoclaw_dir(&p);
        }
    }

    // Walk up from cwd
    if let Ok(cwd) = std::env::current_dir() {
        let mut dir = cwd.as_path();
        loop {
            if dir.join("store").join("messages.db").exists() {
                return Ok(dir.to_path_buf());
            }
            match dir.parent() {
                Some(parent) => dir = parent,
                None => break,
            }
        }
    }

    // Default
    let home = dirs::home_dir().ok_or("Cannot determine home directory")?;
    let default = home.join("nanoclaw");
    if default.exists() {
        return validate_nanoclaw_dir(&default);
    }

    Err("NanoClaw directory not found. Use --nanoclaw-dir or set NANOCLAW_DIR".to_string())
}

fn validate_nanoclaw_dir(p: &Path) -> Result<PathBuf, String> {
    let db = p.join("store").join("messages.db");
    if !db.exists() {
        return Err(format!(
            "NanoClaw directory {} does not contain store/messages.db",
            p.display()
        ));
    }
    Ok(p.to_path_buf())
}

/// Parse a .env file and extract key-value pairs.
pub fn parse_env_file(path: &Path) -> HashMap<String, String> {
    let mut vars = HashMap::new();
    let content = match fs::read_to_string(path) {
        Ok(c) => c,
        Err(_) => return vars,
    };

    for line in content.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        if let Some((key, val)) = trimmed.split_once('=') {
            let key = key.trim();
            let val = val.trim().trim_matches('"').trim_matches('\'');
            vars.insert(key.to_string(), val.to_string());
        }
    }
    vars
}

/// Load model aliases from ~/.config/nanoclaw/model-aliases.json
pub fn load_model_aliases() -> HashMap<String, String> {
    let home = match dirs::home_dir() {
        Some(h) => h,
        None => return HashMap::new(),
    };
    let path = home
        .join(".config")
        .join("nanoclaw")
        .join("model-aliases.json");

    match fs::read_to_string(&path) {
        Ok(content) => serde_json::from_str(&content).unwrap_or_default(),
        Err(_) => HashMap::new(),
    }
}

/// Find the claude CLI binary path (same search as host-runner.ts).
pub fn find_claude_path() -> String {
    let home = dirs::home_dir().unwrap_or_default();
    let candidates = [
        home.join(".local").join("bin").join("claude"),
        PathBuf::from("/usr/local/bin/claude"),
        PathBuf::from("/usr/bin/claude"),
    ];

    for p in &candidates {
        if p.exists() {
            return p.to_string_lossy().to_string();
        }
    }

    // Try `which claude`
    if let Ok(output) = std::process::Command::new("which")
        .arg("claude")
        .output()
    {
        if output.status.success() {
            let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if !path.is_empty() {
                return path;
            }
        }
    }

    String::new()
}

/// Build the full NanoClaw config from directory, group info, and .env.
pub fn build_config(
    project_root: PathBuf,
    group_folder: String,
    group_jid: String,
    group_name: String,
    is_main: bool,
    model: Option<String>,
    effort: Option<String>,
) -> NanoClawConfig {
    let env_file = project_root.join(".env");
    let all_env = parse_env_file(&env_file);

    let assistant_name = all_env
        .get("ASSISTANT_NAME")
        .cloned()
        .or_else(|| std::env::var("ASSISTANT_NAME").ok())
        .unwrap_or_else(|| "Andy".to_string());

    let timezone = std::env::var("TZ")
        .ok()
        .or_else(|| all_env.get("TZ").cloned())
        .unwrap_or_else(|| "UTC".to_string());

    let default_model = std::env::var("DEFAULT_MODEL")
        .ok()
        .or_else(|| all_env.get("DEFAULT_MODEL").cloned())
        .unwrap_or_else(|| "claude-sonnet-4-20250514".to_string());

    // Auth credentials
    let mut env_vars = HashMap::new();
    let auth_keys = [
        "CLAUDE_CODE_OAUTH_TOKEN",
        "ANTHROPIC_API_KEY",
        "ANTHROPIC_BASE_URL",
        "ANTHROPIC_AUTH_TOKEN",
    ];
    for key in &auth_keys {
        if let Some(val) = all_env.get(*key) {
            env_vars.insert(key.to_string(), val.clone());
        }
    }

    let ipc_dir = project_root.join("data").join("cli-ipc").join(&group_folder);
    let group_dir = project_root.join("groups").join(&group_folder);
    let global_dir = project_root.join("groups").join("global");
    let extra_dir = project_root
        .join("data")
        .join("extra")
        .join(&group_folder);
    let claude_home = project_root
        .join("data")
        .join("sessions")
        .join(&group_folder)
        .join(".claude");
    let agent_runner_entry = project_root
        .join("container")
        .join("agent-runner")
        .join("dist")
        .join("index.js");
    let db_path = project_root.join("store").join("messages.db");

    let model_aliases = load_model_aliases();

    NanoClawConfig {
        project_root,
        group_folder,
        group_jid,
        group_name,
        is_main,
        model,
        effort,
        assistant_name,
        timezone,
        default_model,
        ipc_dir,
        group_dir,
        global_dir,
        extra_dir,
        claude_home,
        agent_runner_entry,
        db_path,
        env_vars,
        model_aliases,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use tempfile::TempDir;

    #[test]
    fn test_parse_env_file_basic() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join(".env");
        let mut f = fs::File::create(&path).unwrap();
        writeln!(f, "KEY1=value1").unwrap();
        writeln!(f, "KEY2=\"quoted value\"").unwrap();
        writeln!(f, "# comment").unwrap();
        writeln!(f, "").unwrap();
        writeln!(f, "KEY3=value3").unwrap();

        let vars = parse_env_file(&path);
        assert_eq!(vars.get("KEY1").unwrap(), "value1");
        assert_eq!(vars.get("KEY2").unwrap(), "quoted value");
        assert_eq!(vars.get("KEY3").unwrap(), "value3");
        assert_eq!(vars.len(), 3);
    }

    #[test]
    fn test_parse_env_file_missing() {
        let vars = parse_env_file(Path::new("/nonexistent/.env"));
        assert!(vars.is_empty());
    }

    #[test]
    fn test_parse_env_file_single_quoted() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join(".env");
        fs::write(&path, "TOKEN='abc123'").unwrap();

        let vars = parse_env_file(&path);
        assert_eq!(vars.get("TOKEN").unwrap(), "abc123");
    }

    #[test]
    fn test_find_nanoclaw_dir_explicit() {
        let dir = TempDir::new().unwrap();
        let store = dir.path().join("store");
        fs::create_dir_all(&store).unwrap();
        fs::write(store.join("messages.db"), "").unwrap();

        let result = find_nanoclaw_dir(Some(dir.path()));
        assert!(result.is_ok());
        assert_eq!(result.unwrap(), dir.path());
    }

    #[test]
    fn test_find_nanoclaw_dir_invalid() {
        let dir = TempDir::new().unwrap();
        let result = find_nanoclaw_dir(Some(dir.path()));
        assert!(result.is_err());
    }

    #[test]
    fn test_load_model_aliases_missing_file() {
        // Should return empty map when file doesn't exist
        let aliases = load_model_aliases();
        // We can't control the home dir, but at minimum it shouldn't panic
        let _ = aliases;
    }

    #[test]
    fn test_resolve_model_alias() {
        let mut aliases = HashMap::new();
        aliases.insert("opus".to_string(), "claude-opus-4-20250514".to_string());
        aliases.insert("sonnet".to_string(), "claude-sonnet-4-20250514".to_string());

        let config = NanoClawConfig {
            project_root: PathBuf::from("/tmp"),
            group_folder: "test".to_string(),
            group_jid: "tg:123".to_string(),
            group_name: "test".to_string(),
            is_main: true,
            model: None,
            effort: None,
            assistant_name: "Andy".to_string(),
            timezone: "UTC".to_string(),
            default_model: "claude-sonnet-4-20250514".to_string(),
            ipc_dir: PathBuf::from("/tmp"),
            group_dir: PathBuf::from("/tmp"),
            global_dir: PathBuf::from("/tmp"),
            extra_dir: PathBuf::from("/tmp"),
            claude_home: PathBuf::from("/tmp"),
            agent_runner_entry: PathBuf::from("/tmp"),
            db_path: PathBuf::from("/tmp"),
            env_vars: HashMap::new(),
            model_aliases: aliases,
        };

        assert_eq!(
            config.resolve_model_alias("opus"),
            "claude-opus-4-20250514"
        );
        assert_eq!(
            config.resolve_model_alias("unknown"),
            "unknown"
        );
    }

    #[test]
    fn test_effective_model() {
        let config = NanoClawConfig {
            project_root: PathBuf::from("/tmp"),
            group_folder: "test".to_string(),
            group_jid: "tg:123".to_string(),
            group_name: "test".to_string(),
            is_main: true,
            model: Some("claude-opus-4-20250514".to_string()),
            effort: None,
            assistant_name: "Andy".to_string(),
            timezone: "UTC".to_string(),
            default_model: "claude-sonnet-4-20250514".to_string(),
            ipc_dir: PathBuf::from("/tmp"),
            group_dir: PathBuf::from("/tmp"),
            global_dir: PathBuf::from("/tmp"),
            extra_dir: PathBuf::from("/tmp"),
            claude_home: PathBuf::from("/tmp"),
            agent_runner_entry: PathBuf::from("/tmp"),
            db_path: PathBuf::from("/tmp"),
            env_vars: HashMap::new(),
            model_aliases: HashMap::new(),
        };

        assert_eq!(config.effective_model(), "claude-opus-4-20250514");

        let config_no_model = NanoClawConfig {
            model: None,
            ..config
        };
        assert_eq!(config_no_model.effective_model(), "claude-sonnet-4-20250514");
    }

    #[test]
    fn test_parse_env_file_spaces_around_equals() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join(".env");
        fs::write(&path, "KEY = value_with_spaces ").unwrap();
        let vars = parse_env_file(&path);
        assert_eq!(vars.get("KEY").unwrap(), "value_with_spaces");
    }

    #[test]
    fn test_parse_env_file_empty() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join(".env");
        fs::write(&path, "").unwrap();
        let vars = parse_env_file(&path);
        assert!(vars.is_empty());
    }

    #[test]
    fn test_parse_env_file_only_comments() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join(".env");
        fs::write(&path, "# comment 1\n# comment 2\n\n").unwrap();
        let vars = parse_env_file(&path);
        assert!(vars.is_empty());
    }

    #[test]
    fn test_find_nanoclaw_dir_nonexistent() {
        let result = find_nanoclaw_dir(Some(Path::new("/nonexistent/path/12345")));
        assert!(result.is_err());
    }

    #[test]
    fn test_find_claude_path_returns_string() {
        // Just verify it doesn't panic; result depends on system
        let path = find_claude_path();
        let _ = path;
    }

    #[test]
    fn test_resolve_model_alias_with_empty_aliases() {
        let config = NanoClawConfig {
            project_root: PathBuf::from("/tmp"),
            group_folder: "test".to_string(),
            group_jid: "tg:123".to_string(),
            group_name: "test".to_string(),
            is_main: true,
            model: None,
            effort: None,
            assistant_name: "Andy".to_string(),
            timezone: "UTC".to_string(),
            default_model: "claude-sonnet-4-20250514".to_string(),
            ipc_dir: PathBuf::from("/tmp"),
            group_dir: PathBuf::from("/tmp"),
            global_dir: PathBuf::from("/tmp"),
            extra_dir: PathBuf::from("/tmp"),
            claude_home: PathBuf::from("/tmp"),
            agent_runner_entry: PathBuf::from("/tmp"),
            db_path: PathBuf::from("/tmp"),
            env_vars: HashMap::new(),
            model_aliases: HashMap::new(),
        };
        // With no aliases, should return input as-is
        assert_eq!(config.resolve_model_alias("anything"), "anything");
    }

    #[test]
    fn test_build_config_paths() {
        let dir = TempDir::new().unwrap();
        let root = dir.path().to_path_buf();

        // Create .env
        let env_path = root.join(".env");
        fs::write(&env_path, "ASSISTANT_NAME=TestBot\nTZ=Asia/Tokyo\n").unwrap();

        let config = build_config(
            root.clone(),
            "telegram_main".to_string(),
            "tg:123".to_string(),
            "test_group".to_string(),
            true,
            None,
            None,
        );

        assert_eq!(config.assistant_name, "TestBot");
        assert_eq!(config.timezone, "Asia/Tokyo");
        assert_eq!(config.ipc_dir, root.join("data/cli-ipc/telegram_main"));
        assert_eq!(config.group_dir, root.join("groups/telegram_main"));
        assert_eq!(config.global_dir, root.join("groups/global"));
        assert!(config.is_main);
    }
}
