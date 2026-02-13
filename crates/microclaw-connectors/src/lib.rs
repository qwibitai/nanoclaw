#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ConnectorId(pub String);

pub trait Connector {
    fn id(&self) -> ConnectorId;
}

use std::path::Path;
use std::process::Command;

use serde::{Deserialize, Serialize};
use lettre::Transport;

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

    pub fn send_message(
        base_url: &str,
        token: &str,
        channel_id: &str,
        content: &str,
    ) -> Result<DiscordMessage, String> {
        let url = join_url(base_url, &format!("channels/{}/messages", channel_id));
        let response = ureq::post(&url)
            .set("Authorization", &format!("Bot {}", token))
            .send_json(serde_json::json!({ "content": content }))
            .map_err(ureq_error)?;
        response
            .into_json::<DiscordMessage>()
            .map_err(|err| format!("parse error: {}", err))
    }

    pub fn fetch_messages(
        base_url: &str,
        token: &str,
        channel_id: &str,
        after: Option<&str>,
    ) -> Result<Vec<DiscordMessage>, String> {
        let url = join_url(base_url, &format!("channels/{}/messages", channel_id));
        let mut request = ureq::get(&url).set("Authorization", &format!("Bot {}", token));
        if let Some(after) = after {
            request = request.query("after", after);
        }
        let response = request.call().map_err(ureq_error)?;
        response
            .into_json::<Vec<DiscordMessage>>()
            .map_err(|err| format!("parse error: {}", err))
    }
}

impl Connector for DiscordConnector {
    fn id(&self) -> ConnectorId {
        ConnectorId("discord".to_string())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DiscordMessage {
    pub id: String,
    pub content: String,
}

pub struct TelegramConnector;

impl TelegramConnector {
    pub fn new() -> Self {
        Self
    }

    pub fn send_message_url(token: &str) -> String {
        format!("https://api.telegram.org/bot{}/sendMessage", token)
    }

    pub fn send_message(
        base_url: &str,
        token: &str,
        chat_id: &str,
        text: &str,
    ) -> Result<TelegramMessage, String> {
        let url = join_url(base_url, &format!("bot{}/sendMessage", token));
        let response = ureq::post(&url)
            .send_json(serde_json::json!({"chat_id": chat_id, "text": text}))
            .map_err(ureq_error)?;
        let body: TelegramSendResponse = response
            .into_json()
            .map_err(|err| format!("parse error: {}", err))?;
        if body.ok {
            Ok(body.result)
        } else {
            Err("telegram send failed".to_string())
        }
    }

    pub fn get_updates(
        base_url: &str,
        token: &str,
        offset: Option<i64>,
    ) -> Result<Vec<TelegramUpdate>, String> {
        let url = join_url(base_url, &format!("bot{}/getUpdates", token));
        let mut request = ureq::get(&url);
        if let Some(offset) = offset {
            request = request.query("offset", &offset.to_string());
        }
        let response = request.call().map_err(ureq_error)?;
        let body: TelegramUpdatesResponse = response
            .into_json()
            .map_err(|err| format!("parse error: {}", err))?;
        if body.ok {
            Ok(body.result)
        } else {
            Err("telegram getUpdates failed".to_string())
        }
    }
}

impl Connector for TelegramConnector {
    fn id(&self) -> ConnectorId {
        ConnectorId("telegram".to_string())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TelegramMessage {
    pub message_id: i64,
    pub text: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TelegramUpdate {
    pub update_id: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct TelegramSendResponse {
    ok: bool,
    result: TelegramMessage,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct TelegramUpdatesResponse {
    ok: bool,
    result: Vec<TelegramUpdate>,
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

    pub fn build_message(
        from: &str,
        to: &str,
        subject: &str,
        body: &str,
    ) -> EmailMessage {
        EmailMessage {
            from: from.to_string(),
            to: to.to_string(),
            subject: subject.to_string(),
            body: body.to_string(),
        }
    }

    pub fn smtp_send_with_transport<T: EmailTransport>(
        transport: &T,
        message: &EmailMessage,
    ) -> Result<(), String> {
        transport.send(message)
    }

    pub fn smtp_send(
        server: &str,
        from: &str,
        to: &str,
        subject: &str,
        body: &str,
    ) -> Result<(), String> {
        let email = lettre::Message::builder()
            .from(from.parse().map_err(|err| format!("from error: {}", err))?)
            .to(to.parse().map_err(|err| format!("to error: {}", err))?)
            .subject(subject)
            .body(body.to_string())
            .map_err(|err| format!("build error: {}", err))?;
        let mailer = lettre::SmtpTransport::relay(server)
            .map_err(|err| format!("smtp error: {}", err))?
            .build();
        mailer
            .send(&email)
            .map_err(|err| format!("send error: {}", err))?;
        Ok(())
    }

    pub fn imap_idle_with_client<C: ImapClient>(client: &mut C) -> Result<(), String> {
        client.idle()
    }

    pub fn connect_imap(
        server: &str,
        port: u16,
        username: &str,
        password: &str,
    ) -> Result<ImapSession, String> {
        let client = imap::ClientBuilder::new(server, port)
            .connect()
            .map_err(|err| format!("imap connect error: {}", err))?;
        let session = client
            .login(username, password)
            .map_err(|(err, _)| format!("imap login error: {}", err))?;
        Ok(ImapSession { session })
    }
}

impl Connector for EmailConnector {
    fn id(&self) -> ConnectorId {
        ConnectorId("email".to_string())
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EmailMessage {
    pub from: String,
    pub to: String,
    pub subject: String,
    pub body: String,
}

pub trait EmailTransport {
    fn send(&self, message: &EmailMessage) -> Result<(), String>;
}

pub trait ImapClient {
    fn idle(&mut self) -> Result<(), String>;
}

pub struct ImapSession {
    session: imap::Session<imap::Connection>,
}

impl ImapClient for ImapSession {
    fn idle(&mut self) -> Result<(), String> {
        self.session
            .noop()
            .map(|_| ())
            .map_err(|err| format!("imap noop error: {}", err))
    }
}

fn join_url(base: &str, path: &str) -> String {
    let base = base.trim_end_matches('/');
    let path = path.trim_start_matches('/');
    format!("{}/{}", base, path)
}

fn ureq_error(err: ureq::Error) -> String {
    match err {
        ureq::Error::Status(code, resp) => {
            let body = resp.into_string().unwrap_or_default();
            format!("http {}: {}", code, body)
        }
        ureq::Error::Transport(err) => format!("transport error: {}", err),
    }
}
