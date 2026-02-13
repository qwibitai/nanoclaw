#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ConnectorId(pub String);

pub trait Connector {
    fn id(&self) -> ConnectorId;
}

use std::path::Path;
use std::process::Command;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommandResult {
    pub status: i32,
    pub stdout: String,
    pub stderr: String,
}

pub trait CommandExecutor {
    fn run(&self, args: &[String]) -> Result<CommandResult, String>;
}

pub struct ProcessExecutor;

impl CommandExecutor for ProcessExecutor {
    fn run(&self, args: &[String]) -> Result<CommandResult, String> {
        let (program, rest) = args
            .split_first()
            .ok_or_else(|| "empty command".to_string())?;
        let output = Command::new(program)
            .args(rest)
            .output()
            .map_err(|err| format!("failed to execute {}: {}", program, err))?;
        Ok(CommandResult {
            status: output.status.code().unwrap_or(-1),
            stdout: String::from_utf8_lossy(&output.stdout).to_string(),
            stderr: String::from_utf8_lossy(&output.stderr).to_string(),
        })
    }
}

pub struct IMessageConnector;

impl IMessageConnector {
    pub fn new() -> Self {
        Self
    }

    pub fn build_send_script(to: &str, message: &str) -> String {
        format!(
            "tell application \"Messages\"\n    set targetService to 1st service whose service type = iMessage\n    set targetBuddy to buddy \"{}\" of targetService\n    send \"{}\" to targetBuddy\nend tell",
            to, message
        )
    }

    pub fn chat_db_query() -> &'static str {
        "SELECT message.ROWID, message.text, message.date, handle.id AS sender\nFROM message\nJOIN handle ON message.handle_id = handle.ROWID\nWHERE message.ROWID > ?\nORDER BY message.ROWID ASC"
    }

    pub fn send_with_executor<E: CommandExecutor>(
        executor: &E,
        to: &str,
        message: &str,
    ) -> Result<CommandResult, String> {
        let script = Self::build_send_script(to, message);
        let args = vec!["osascript".to_string(), "-e".to_string(), script];
        executor.run(&args)
    }

    pub fn send(to: &str, message: &str) -> Result<CommandResult, String> {
        let executor = ProcessExecutor;
        Self::send_with_executor(&executor, to, message)
    }

    pub fn fetch_since(
        path: impl AsRef<Path>,
        last_rowid: i64,
    ) -> rusqlite::Result<Vec<IMessageMessage>> {
        let conn = rusqlite::Connection::open(path)?;
        let mut stmt = conn.prepare(Self::chat_db_query())?;
        let rows = stmt.query_map([last_rowid], |row| {
            Ok(IMessageMessage {
                rowid: row.get(0)?,
                text: row.get::<_, Option<String>>(1)?.unwrap_or_default(),
                sender: row.get::<_, Option<String>>(3)?.unwrap_or_default(),
            })
        })?;
        let mut messages = Vec::new();
        for row in rows {
            messages.push(row?);
        }
        Ok(messages)
    }
}

impl Connector for IMessageConnector {
    fn id(&self) -> ConnectorId {
        ConnectorId("imessage".to_string())
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IMessageMessage {
    pub rowid: i64,
    pub text: String,
    pub sender: String,
}

pub struct DiscordConnector;

impl DiscordConnector {
    pub fn new() -> Self {
        Self
    }

    pub fn message_url(channel_id: &str) -> String {
        format!(
            "https://discord.com/api/v10/channels/{}/messages",
            channel_id
        )
    }

    pub fn auth_header(token: &str) -> (String, String) {
        ("Authorization".to_string(), format!("Bot {}", token))
    }
}

impl Connector for DiscordConnector {
    fn id(&self) -> ConnectorId {
        ConnectorId("discord".to_string())
    }
}

pub struct TelegramConnector;

impl TelegramConnector {
    pub fn new() -> Self {
        Self
    }

    pub fn send_message_url(token: &str) -> String {
        format!("https://api.telegram.org/bot{}/sendMessage", token)
    }
}

impl Connector for TelegramConnector {
    fn id(&self) -> ConnectorId {
        ConnectorId("telegram".to_string())
    }
}

pub struct EmailConnector;

impl EmailConnector {
    pub fn new() -> Self {
        Self
    }

    pub fn smtp_mail_from(address: &str) -> String {
        format!("MAIL FROM:<{}>", address)
    }

    pub fn imap_idle_command() -> &'static str {
        "IDLE"
    }
}

impl Connector for EmailConnector {
    fn id(&self) -> ConnectorId {
        ConnectorId("email".to_string())
    }
}
