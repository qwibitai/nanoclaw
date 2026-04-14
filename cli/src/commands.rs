use crate::agent;
use crate::config::NanoClawConfig;
use crate::db;

/// Result of a slash command execution.
pub enum CommandResult {
    /// Display a system message to the user.
    SystemMessage(String),
    /// Send text to the agent via IPC (e.g., /compact).
    SendToAgent(String),
    /// Clear the current session (kill agent, delete session).
    ClearSession,
    /// Quit the TUI.
    Quit,
    /// Unknown command.
    Unknown(String),
}

/// Metadata for a slash command.
pub struct SlashCommand {
    pub name: &'static str,
    pub description: &'static str,
}

/// All available slash commands with descriptions.
pub const COMMANDS: &[SlashCommand] = &[
    SlashCommand { name: "/model",   description: "Set or reset the AI model" },
    SlashCommand { name: "/effort",  description: "Set effort level" },
    SlashCommand { name: "/status",  description: "Show session status" },
    SlashCommand { name: "/clear",   description: "Clear the session" },
    SlashCommand { name: "/compact", description: "Compact agent context" },
    SlashCommand { name: "/tasks",   description: "List scheduled tasks" },
    SlashCommand { name: "/history", description: "Show message history" },
    SlashCommand { name: "/quit",    description: "Quit the TUI" },
    SlashCommand { name: "/exit",    description: "Exit the TUI" },
];

/// Valid effort levels.
const VALID_EFFORTS: &[&str] = &["low", "medium", "high", "max"];

/// Parse and execute a slash command. Returns the result.
pub fn dispatch(
    input: &str,
    config: &NanoClawConfig,
    session_id: &Option<String>,
    last_usage: &Option<agent::Usage>,
    context_window: &Option<u64>,
    agent_state: &str,
) -> CommandResult {
    let input = input.trim();
    let (cmd, args) = match input.split_once(' ') {
        Some((c, a)) => (c, a.trim()),
        None => (input, ""),
    };

    match cmd {
        "/model" => cmd_model(args, config),
        "/effort" => cmd_effort(args, config),
        "/status" => cmd_status(config, session_id, last_usage, context_window, agent_state),
        "/clear" => CommandResult::ClearSession,
        "/compact" => {
            if agent_state == "Idle" {
                CommandResult::SystemMessage("No active agent session to compact.".to_string())
            } else {
                CommandResult::SendToAgent("/compact".to_string())
            }
        }
        "/tasks" => cmd_tasks(config),
        "/history" => cmd_history(args, config),
        "/quit" | "/exit" => CommandResult::Quit,
        _ => CommandResult::Unknown(cmd.to_string()),
    }
}

fn cmd_model(args: &str, config: &NanoClawConfig) -> CommandResult {
    if args.is_empty() {
        return CommandResult::SystemMessage(
            "Usage: /model <name|reset>".to_string(),
        );
    }

    if args == "reset" {
        match db::set_group_model(&config.db_path, &config.group_jid, None) {
            Ok(()) => CommandResult::SystemMessage(format!(
                "Model override cleared. Using default: {}",
                config.default_model
            )),
            Err(e) => CommandResult::SystemMessage(format!("Error: {e}")),
        }
    } else {
        let resolved = config.resolve_model_alias(args);
        match db::set_group_model(&config.db_path, &config.group_jid, Some(&resolved)) {
            Ok(()) => CommandResult::SystemMessage(format!("Model set to {resolved}")),
            Err(e) => CommandResult::SystemMessage(format!("Error: {e}")),
        }
    }
}

fn cmd_effort(args: &str, config: &NanoClawConfig) -> CommandResult {
    if args.is_empty() {
        return CommandResult::SystemMessage(format!(
            "Usage: /effort <{}>",
            VALID_EFFORTS.join("|")
        ));
    }

    if args == "reset" {
        match db::set_group_effort(&config.db_path, &config.group_jid, None) {
            Ok(()) => CommandResult::SystemMessage("Effort override cleared.".to_string()),
            Err(e) => CommandResult::SystemMessage(format!("Error: {e}")),
        }
    } else if VALID_EFFORTS.contains(&args) {
        match db::set_group_effort(&config.db_path, &config.group_jid, Some(args)) {
            Ok(()) => CommandResult::SystemMessage(format!("Effort set to {args}")),
            Err(e) => CommandResult::SystemMessage(format!("Error: {e}")),
        }
    } else {
        CommandResult::SystemMessage(format!(
            "Invalid effort level '{}'. Valid: {}",
            args,
            VALID_EFFORTS.join(", ")
        ))
    }
}

fn cmd_status(
    config: &NanoClawConfig,
    session_id: &Option<String>,
    last_usage: &Option<agent::Usage>,
    context_window: &Option<u64>,
    agent_state: &str,
) -> CommandResult {
    let mut lines = Vec::new();
    lines.push(format!("Group: {} ({})", config.group_name, config.group_folder));
    lines.push(format!("JID: {}", config.group_jid));
    lines.push(format!("Agent: {agent_state}"));
    lines.push(format!("Model: {}", config.effective_model()));
    if let Some(ref effort) = config.effort {
        lines.push(format!("Effort: {effort}"));
    }
    if let Some(ref sid) = session_id {
        let short = if sid.len() > 12 { &sid[..12] } else { sid };
        lines.push(format!("Session: {short}..."));
    }
    if let Some(ref u) = last_usage {
        lines.push(format!(
            "Last usage: {} in / {} out ({} turns)",
            format_tokens(u.input_tokens),
            format_tokens(u.output_tokens),
            u.num_turns
        ));
    }
    if let Some(cw) = context_window {
        lines.push(format!("Context window: {}", format_tokens(*cw)));
    }

    CommandResult::SystemMessage(lines.join("\n"))
}

fn cmd_tasks(config: &NanoClawConfig) -> CommandResult {
    let conn = match db::open_readonly(&config.db_path) {
        Ok(c) => c,
        Err(e) => return CommandResult::SystemMessage(format!("Error: {e}")),
    };
    let tasks = db::get_tasks(&conn, &config.group_folder);
    if tasks.is_empty() {
        return CommandResult::SystemMessage("No scheduled tasks.".to_string());
    }

    let mut lines = Vec::new();
    for t in &tasks {
        let model_info = t
            .model
            .as_deref()
            .map(|m| format!(" [{m}]"))
            .unwrap_or_default();
        let next = t
            .next_run
            .as_deref()
            .unwrap_or("—");
        let prompt_short = if t.prompt.len() > 50 {
            format!("{}...", &t.prompt[..47])
        } else {
            t.prompt.clone()
        };
        lines.push(format!(
            "  {} [{}] {} {}{} (next: {})",
            t.id, t.status, t.schedule_type, prompt_short, model_info, next
        ));
    }
    CommandResult::SystemMessage(format!("Tasks ({}):\n{}", tasks.len(), lines.join("\n")))
}

fn cmd_history(args: &str, config: &NanoClawConfig) -> CommandResult {
    let limit: usize = args.parse().unwrap_or(20);
    let conn = match db::open_readonly(&config.db_path) {
        Ok(c) => c,
        Err(e) => return CommandResult::SystemMessage(format!("Error: {e}")),
    };
    let msgs = db::get_messages(&conn, &config.group_jid, limit);
    if msgs.is_empty() {
        return CommandResult::SystemMessage("No message history.".to_string());
    }

    let mut lines = Vec::new();
    for m in &msgs {
        let time = db::format_local_time(&m.timestamp);
        let sender = if m.is_bot_message {
            &config.group_name
        } else {
            &m.sender_name
        };
        lines.push(format!("[{}] {}: {}", time, sender, m.content));
    }
    CommandResult::SystemMessage(lines.join("\n"))
}

/// Format token counts for display (e.g., 1234 -> "1.2k").
fn format_tokens(n: u64) -> String {
    if n >= 1_000_000 {
        format!("{:.1}M", n as f64 / 1_000_000.0)
    } else if n >= 1_000 {
        format!("{:.1}k", n as f64 / 1_000.0)
    } else {
        n.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::NanoClawConfig;
    use std::collections::HashMap;
    use std::path::PathBuf;

    fn test_config(db_path: PathBuf) -> NanoClawConfig {
        let mut aliases = HashMap::new();
        aliases.insert("opus".to_string(), "claude-opus-4-20250514".to_string());

        NanoClawConfig {
            project_root: PathBuf::from("/tmp"),
            group_folder: "telegram_main".to_string(),
            group_jid: "tg:123".to_string(),
            group_name: "Main Group".to_string(),
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
            db_path,
            env_vars: HashMap::new(),
            model_aliases: aliases,
        }
    }

    fn create_test_db() -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::TempDir::new().unwrap();
        let db_path = dir.path().join("messages.db");
        let conn = rusqlite::Connection::open(&db_path).unwrap();
        conn.execute_batch(
            "
            CREATE TABLE registered_groups (
                jid TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                folder TEXT NOT NULL UNIQUE,
                trigger_pattern TEXT NOT NULL,
                added_at TEXT NOT NULL,
                container_config TEXT,
                requires_trigger INTEGER DEFAULT 1,
                is_main INTEGER DEFAULT 0,
                model TEXT,
                effort TEXT
            );
            CREATE TABLE sessions (
                group_folder TEXT PRIMARY KEY,
                session_id TEXT NOT NULL
            );
            CREATE TABLE scheduled_tasks (
                id TEXT PRIMARY KEY,
                group_folder TEXT NOT NULL,
                chat_jid TEXT NOT NULL,
                prompt TEXT NOT NULL,
                script TEXT,
                schedule_type TEXT NOT NULL,
                schedule_value TEXT NOT NULL,
                context_mode TEXT DEFAULT 'isolated',
                silent INTEGER DEFAULT 0,
                model TEXT,
                effort TEXT,
                next_run TEXT,
                last_run TEXT,
                last_result TEXT,
                status TEXT DEFAULT 'active',
                created_at TEXT NOT NULL
            );
            CREATE TABLE messages (
                id TEXT,
                chat_jid TEXT,
                sender TEXT,
                sender_name TEXT,
                content TEXT,
                timestamp TEXT,
                is_from_me INTEGER,
                is_bot_message INTEGER DEFAULT 0,
                reply_to_message_id TEXT,
                reply_to_message_content TEXT,
                reply_to_sender_name TEXT,
                PRIMARY KEY (id, chat_jid)
            );
            INSERT INTO registered_groups (jid, name, folder, trigger_pattern, added_at, is_main)
            VALUES ('tg:123', 'Main Group', 'telegram_main', '@Andy', '2025-01-01', 1);
            ",
        )
        .unwrap();
        (dir, db_path)
    }

    #[test]
    fn test_dispatch_quit() {
        let (_dir, db_path) = create_test_db();
        let config = test_config(db_path);
        match dispatch("/quit", &config, &None, &None, &None, "Idle") {
            CommandResult::Quit => {}
            _ => panic!("Expected Quit"),
        }
    }

    #[test]
    fn test_dispatch_exit() {
        let (_dir, db_path) = create_test_db();
        let config = test_config(db_path);
        match dispatch("/exit", &config, &None, &None, &None, "Idle") {
            CommandResult::Quit => {}
            _ => panic!("Expected Quit"),
        }
    }

    #[test]
    fn test_dispatch_unknown() {
        let (_dir, db_path) = create_test_db();
        let config = test_config(db_path);
        match dispatch("/foobar", &config, &None, &None, &None, "Idle") {
            CommandResult::Unknown(cmd) => assert_eq!(cmd, "/foobar"),
            _ => panic!("Expected Unknown"),
        }
    }

    #[test]
    fn test_dispatch_model_no_args() {
        let (_dir, db_path) = create_test_db();
        let config = test_config(db_path);
        match dispatch("/model", &config, &None, &None, &None, "Idle") {
            CommandResult::SystemMessage(msg) => assert!(msg.contains("Usage")),
            _ => panic!("Expected usage message"),
        }
    }

    #[test]
    fn test_dispatch_model_set() {
        let (_dir, db_path) = create_test_db();
        let config = test_config(db_path);
        match dispatch("/model opus", &config, &None, &None, &None, "Idle") {
            CommandResult::SystemMessage(msg) => {
                assert!(msg.contains("claude-opus-4-20250514"));
            }
            _ => panic!("Expected SystemMessage"),
        }
    }

    #[test]
    fn test_dispatch_model_reset() {
        let (_dir, db_path) = create_test_db();
        let config = test_config(db_path);
        match dispatch("/model reset", &config, &None, &None, &None, "Idle") {
            CommandResult::SystemMessage(msg) => {
                assert!(msg.contains("cleared"));
            }
            _ => panic!("Expected SystemMessage"),
        }
    }

    #[test]
    fn test_dispatch_effort_no_args() {
        let (_dir, db_path) = create_test_db();
        let config = test_config(db_path);
        match dispatch("/effort", &config, &None, &None, &None, "Idle") {
            CommandResult::SystemMessage(msg) => assert!(msg.contains("Usage")),
            _ => panic!("Expected usage message"),
        }
    }

    #[test]
    fn test_dispatch_effort_valid() {
        let (_dir, db_path) = create_test_db();
        let config = test_config(db_path);
        for level in &["low", "medium", "high", "max"] {
            match dispatch(&format!("/effort {level}"), &config, &None, &None, &None, "Idle") {
                CommandResult::SystemMessage(msg) => {
                    assert!(msg.contains(level), "Expected '{level}' in message: {msg}");
                }
                _ => panic!("Expected SystemMessage for {level}"),
            }
        }
    }

    #[test]
    fn test_dispatch_effort_invalid() {
        let (_dir, db_path) = create_test_db();
        let config = test_config(db_path);
        match dispatch("/effort extreme", &config, &None, &None, &None, "Idle") {
            CommandResult::SystemMessage(msg) => {
                assert!(msg.contains("Invalid"));
            }
            _ => panic!("Expected error message"),
        }
    }

    #[test]
    fn test_dispatch_effort_reset() {
        let (_dir, db_path) = create_test_db();
        let config = test_config(db_path);
        match dispatch("/effort reset", &config, &None, &None, &None, "Idle") {
            CommandResult::SystemMessage(msg) => {
                assert!(msg.contains("cleared"));
            }
            _ => panic!("Expected SystemMessage"),
        }
    }

    #[test]
    fn test_dispatch_status() {
        let (_dir, db_path) = create_test_db();
        let config = test_config(db_path);
        let usage = Some(agent::Usage {
            input_tokens: 1500,
            output_tokens: 800,
            num_turns: 3,
        });
        match dispatch("/status", &config, &Some("sess-abc".to_string()), &usage, &Some(200000), "Running") {
            CommandResult::SystemMessage(msg) => {
                assert!(msg.contains("Main Group"));
                assert!(msg.contains("Running"));
                assert!(msg.contains("1.5k"));
                assert!(msg.contains("sess-abc"));
            }
            _ => panic!("Expected SystemMessage"),
        }
    }

    #[test]
    fn test_dispatch_compact_idle() {
        let (_dir, db_path) = create_test_db();
        let config = test_config(db_path);
        match dispatch("/compact", &config, &None, &None, &None, "Idle") {
            CommandResult::SystemMessage(msg) => {
                assert!(msg.contains("No active"));
            }
            _ => panic!("Expected SystemMessage"),
        }
    }

    #[test]
    fn test_dispatch_compact_running() {
        let (_dir, db_path) = create_test_db();
        let config = test_config(db_path);
        match dispatch("/compact", &config, &None, &None, &None, "Running") {
            CommandResult::SendToAgent(text) => assert_eq!(text, "/compact"),
            _ => panic!("Expected SendToAgent"),
        }
    }

    #[test]
    fn test_dispatch_clear() {
        let (_dir, db_path) = create_test_db();
        let config = test_config(db_path);
        match dispatch("/clear", &config, &None, &None, &None, "Idle") {
            CommandResult::ClearSession => {}
            _ => panic!("Expected ClearSession"),
        }
    }

    #[test]
    fn test_dispatch_tasks_empty() {
        let (_dir, db_path) = create_test_db();
        let config = test_config(db_path);
        match dispatch("/tasks", &config, &None, &None, &None, "Idle") {
            CommandResult::SystemMessage(msg) => {
                assert!(msg.contains("No scheduled tasks"));
            }
            _ => panic!("Expected SystemMessage"),
        }
    }

    #[test]
    fn test_format_tokens() {
        assert_eq!(format_tokens(500), "500");
        assert_eq!(format_tokens(1500), "1.5k");
        assert_eq!(format_tokens(1_500_000), "1.5M");
        assert_eq!(format_tokens(0), "0");
    }

    #[test]
    fn test_dispatch_history_default() {
        let (_dir, db_path) = create_test_db();
        let config = test_config(db_path);
        match dispatch("/history", &config, &None, &None, &None, "Idle") {
            CommandResult::SystemMessage(msg) => {
                assert!(msg.contains("No message history"));
            }
            _ => panic!("Expected SystemMessage"),
        }
    }

    #[test]
    fn test_dispatch_history_with_data() {
        let (_dir, db_path) = create_test_db();
        {
            let conn = rusqlite::Connection::open(&db_path).unwrap();
            conn.execute(
                "INSERT INTO messages (id, chat_jid, sender, sender_name, content, timestamp, is_from_me)
                 VALUES ('m1', 'tg:123', 'u1', 'Alice', 'Hello world', '2025-01-01T10:30:00', 0)",
                [],
            ).unwrap();
        }
        let config = test_config(db_path);
        let expected_time = db::format_local_time("2025-01-01T10:30:00");
        match dispatch("/history", &config, &None, &None, &None, "Idle") {
            CommandResult::SystemMessage(msg) => {
                assert!(msg.contains("Alice"));
                assert!(msg.contains("Hello world"));
                assert!(msg.contains(&expected_time));
            }
            _ => panic!("Expected SystemMessage"),
        }
    }

    #[test]
    fn test_dispatch_history_with_limit() {
        let (_dir, db_path) = create_test_db();
        let config = test_config(db_path);
        // With numeric limit but no data
        match dispatch("/history 5", &config, &None, &None, &None, "Idle") {
            CommandResult::SystemMessage(msg) => {
                assert!(msg.contains("No message history"));
            }
            _ => panic!("Expected SystemMessage"),
        }
    }

    #[test]
    fn test_dispatch_tasks_with_data() {
        let (_dir, db_path) = create_test_db();
        {
            let conn = rusqlite::Connection::open(&db_path).unwrap();
            conn.execute(
                "INSERT INTO scheduled_tasks (id, group_folder, chat_jid, prompt, schedule_type, schedule_value, status, created_at)
                 VALUES ('t1', 'telegram_main', 'tg:123', 'Daily report', 'cron', '0 9 * * *', 'active', '2025-01-01')",
                [],
            ).unwrap();
        }
        let config = test_config(db_path);
        match dispatch("/tasks", &config, &None, &None, &None, "Idle") {
            CommandResult::SystemMessage(msg) => {
                assert!(msg.contains("Tasks (1)"));
                assert!(msg.contains("Daily report"));
                assert!(msg.contains("cron"));
            }
            _ => panic!("Expected SystemMessage"),
        }
    }

    #[test]
    fn test_dispatch_status_minimal() {
        let (_dir, db_path) = create_test_db();
        let config = test_config(db_path);
        match dispatch("/status", &config, &None, &None, &None, "Idle") {
            CommandResult::SystemMessage(msg) => {
                assert!(msg.contains("Main Group"));
                assert!(msg.contains("telegram_main"));
                assert!(msg.contains("Idle"));
                assert!(msg.contains("Model:"));
                // No session, usage, or context_window lines
                assert!(!msg.contains("Session:"));
                assert!(!msg.contains("Last usage:"));
                assert!(!msg.contains("Context window:"));
            }
            _ => panic!("Expected SystemMessage"),
        }
    }

    #[test]
    fn test_dispatch_status_with_effort() {
        let (_dir, db_path) = create_test_db();
        let mut config = test_config(db_path);
        config.effort = Some("high".to_string());
        match dispatch("/status", &config, &None, &None, &None, "Running") {
            CommandResult::SystemMessage(msg) => {
                assert!(msg.contains("Effort: high"));
                assert!(msg.contains("Running"));
            }
            _ => panic!("Expected SystemMessage"),
        }
    }

    #[test]
    fn test_dispatch_model_direct_name() {
        let (_dir, db_path) = create_test_db();
        let config = test_config(db_path);
        // Use a name that is NOT an alias
        match dispatch("/model claude-haiku-3-5-20241022", &config, &None, &None, &None, "Idle") {
            CommandResult::SystemMessage(msg) => {
                assert!(msg.contains("claude-haiku-3-5-20241022"));
            }
            _ => panic!("Expected SystemMessage"),
        }
    }

    #[test]
    fn test_dispatch_compact_waiting_ipc() {
        let (_dir, db_path) = create_test_db();
        let config = test_config(db_path);
        match dispatch("/compact", &config, &None, &None, &None, "WaitingIpc") {
            CommandResult::SendToAgent(text) => assert_eq!(text, "/compact"),
            _ => panic!("Expected SendToAgent"),
        }
    }

    #[test]
    fn test_commands_list_completeness() {
        let names: Vec<&str> = COMMANDS.iter().map(|c| c.name).collect();
        assert!(names.contains(&"/model"));
        assert!(names.contains(&"/effort"));
        assert!(names.contains(&"/status"));
        assert!(names.contains(&"/clear"));
        assert!(names.contains(&"/compact"));
        assert!(names.contains(&"/tasks"));
        assert!(names.contains(&"/history"));
        assert!(names.contains(&"/quit"));
        assert!(names.contains(&"/exit"));
    }
}
