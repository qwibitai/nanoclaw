use std::cell::RefCell;

use microclaw_core::{
    escape_xml, find_channel, format_messages, format_outbound, route_outbound,
    strip_internal_tags, Channel, NewMessage,
};

#[test]
fn escape_xml_replaces_entities() {
    let input = "Tom & Jerry <tag> \"hi\"";
    let output = escape_xml(input);
    assert_eq!(output, "Tom &amp; Jerry &lt;tag&gt; &quot;hi&quot;");
}

#[test]
fn format_messages_wraps_xml() {
    let messages = vec![
        NewMessage::new("Alice", "2024-01-01T00:00:00Z", "hello"),
        NewMessage::new("Bob", "2024-01-01T00:00:01Z", "<tag>"),
    ];
    let formatted = format_messages(&messages);
    assert!(formatted.starts_with("<messages>\n"));
    assert!(formatted.contains("<message sender=\"Alice\" time=\"2024-01-01T00:00:00Z\">hello</message>"));
    assert!(formatted.contains("<message sender=\"Bob\" time=\"2024-01-01T00:00:01Z\">&lt;tag&gt;</message>"));
    assert!(formatted.ends_with("\n</messages>"));
}

#[test]
fn strip_internal_tags_removes_hidden_content() {
    let input = "hello <internal>secret</internal>";
    assert_eq!(strip_internal_tags(input), "hello");
    let input = "<internal>secret</internal>";
    assert_eq!(strip_internal_tags(input), "");
}

#[test]
fn format_outbound_prefixes_assistant_name() {
    let output = format_outbound(true, "Andy", "hello");
    assert_eq!(output, "Andy: hello");
    let output = format_outbound(false, "Andy", "hello");
    assert_eq!(output, "hello");
    let output = format_outbound(true, "Andy", "<internal>secret</internal>");
    assert_eq!(output, "");
}

struct TestChannel {
    jid: String,
    connected: bool,
    sent: RefCell<Vec<(String, String)>>,
}

impl TestChannel {
    fn new(jid: &str, connected: bool) -> Self {
        Self {
            jid: jid.to_string(),
            connected,
            sent: RefCell::new(Vec::new()),
        }
    }
}

impl Channel for TestChannel {
    fn owns_jid(&self, jid: &str) -> bool {
        self.jid == jid
    }

    fn is_connected(&self) -> bool {
        self.connected
    }

    fn send_message(&self, jid: &str, text: &str) -> Result<(), String> {
        self.sent
            .borrow_mut()
            .push((jid.to_string(), text.to_string()));
        Ok(())
    }
}

#[test]
fn route_outbound_sends_via_connected_channel() {
    let channel_a = TestChannel::new("jid-a", false);
    let channel_b = TestChannel::new("jid-a", true);
    let channels = vec![channel_a, channel_b];
    route_outbound(&channels, "jid-a", "hello").expect("route outbound");
    assert_eq!(channels[1].sent.borrow().len(), 1);
    assert_eq!(channels[1].sent.borrow()[0].1, "hello");
}

#[test]
fn find_channel_returns_first_owner() {
    let channel_a = TestChannel::new("jid-a", false);
    let channel_b = TestChannel::new("jid-b", true);
    let channels = vec![channel_a, channel_b];
    let found = find_channel(&channels, "jid-b");
    assert!(found.is_some());
}

#[test]
fn route_outbound_errors_without_channel() {
    let channel_a = TestChannel::new("jid-a", true);
    let channels = vec![channel_a];
    let err = route_outbound(&channels, "jid-b", "hello").unwrap_err();
    assert!(err.contains("No channel"));
}
