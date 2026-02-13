#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ConnectorId(pub String);

pub trait Connector {
    fn id(&self) -> ConnectorId;
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
}

impl Connector for IMessageConnector {
    fn id(&self) -> ConnectorId {
        ConnectorId("imessage".to_string())
    }
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
