use regex::Regex;

pub fn version() -> &'static str {
    "0.1.0"
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
