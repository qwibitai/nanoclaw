use regex::Regex;

pub fn version() -> &'static str {
    "0.1.0"
}

#[derive(Clone, Debug)]
pub struct NewMessage {
    pub sender_name: String,
    pub timestamp: String,
    pub content: String,
}

impl NewMessage {
    pub fn new(sender_name: impl Into<String>, timestamp: impl Into<String>, content: impl Into<String>) -> Self {
        Self {
            sender_name: sender_name.into(),
            timestamp: timestamp.into(),
            content: content.into(),
        }
    }
}

#[derive(Clone, Debug)]
pub struct Message {
    pub content: String,
}

impl Message {
    pub fn new(content: impl Into<String>) -> Self {
        Self {
            content: content.into(),
        }
    }
}

pub fn create_trigger_pattern(trigger: &str) -> Regex {
    let trimmed = trigger.trim();
    let normalized = if trimmed.starts_with('@') {
        trimmed.to_string()
    } else {
        format!("@{trimmed}")
    };
    Regex::new(&format!("(?i)^{}\\b", regex::escape(&normalized)))
        .expect("trigger regex should compile")
}

pub fn should_require_trigger(is_main_group: bool, requires_trigger: Option<bool>) -> bool {
    !is_main_group && requires_trigger != Some(false)
}

pub fn should_process(
    is_main_group: bool,
    requires_trigger: Option<bool>,
    trigger: &str,
    messages: &[Message],
) -> bool {
    if !should_require_trigger(is_main_group, requires_trigger) {
        return true;
    }
    let pattern = create_trigger_pattern(trigger);
    messages
        .iter()
        .any(|m| pattern.is_match(m.content.trim()))
}

pub fn escape_xml(input: &str) -> String {
    input
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('\"', "&quot;")
}

pub fn format_messages(messages: &[NewMessage]) -> String {
    let lines = messages
        .iter()
        .map(|m| {
            format!(
                "<message sender=\"{}\" time=\"{}\">{}</message>",
                escape_xml(&m.sender_name),
                m.timestamp,
                escape_xml(&m.content)
            )
        })
        .collect::<Vec<_>>()
        .join("\n");
    format!("<messages>\n{}\n</messages>", lines)
}

pub fn strip_internal_tags(text: &str) -> String {
    let pattern = Regex::new(r"<internal>[\s\S]*?</internal>").expect("internal tag regex");
    pattern.replace_all(text, "").trim().to_string()
}

pub fn format_outbound(prefix_assistant_name: bool, assistant_name: &str, raw_text: &str) -> String {
    let text = strip_internal_tags(raw_text);
    if text.is_empty() {
        return String::new();
    }
    if prefix_assistant_name {
        format!("{}: {}", assistant_name, text)
    } else {
        text
    }
}

pub trait Channel {
    fn owns_jid(&self, jid: &str) -> bool;
    fn is_connected(&self) -> bool;
    fn send_message(&self, jid: &str, text: &str) -> Result<(), String>;
}

pub fn route_outbound<C: Channel>(channels: &[C], jid: &str, text: &str) -> Result<(), String> {
    let channel = channels
        .iter()
        .find(|c| c.owns_jid(jid) && c.is_connected())
        .ok_or_else(|| format!("No channel for JID: {}", jid))?;
    channel.send_message(jid, text)
}

pub fn find_channel<'a, C: Channel>(channels: &'a [C], jid: &str) -> Option<&'a C> {
    channels.iter().find(|c| c.owns_jid(jid))
}
