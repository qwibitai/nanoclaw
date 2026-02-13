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
