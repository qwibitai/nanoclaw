use microclaw_connectors::{EmailConnector, EmailMessage, EmailTransport, ImapClient};

struct StubTransport {
    sent: std::sync::Mutex<Vec<EmailMessage>>,
}

impl StubTransport {
    fn new() -> Self {
        Self {
            sent: std::sync::Mutex::new(Vec::new()),
        }
    }
}

impl EmailTransport for StubTransport {
    fn send(&self, message: &EmailMessage) -> Result<(), String> {
        self.sent.lock().unwrap().push(message.clone());
        Ok(())
    }
}

struct StubImap {
    called: bool,
}

impl ImapClient for StubImap {
    fn idle(&mut self) -> Result<(), String> {
        self.called = true;
        Ok(())
    }
}

#[test]
fn smtp_send_with_transport_records_message() {
    let transport = StubTransport::new();
    let message = EmailConnector::build_message("a@example.com", "b@example.com", "hi", "body");
    EmailConnector::smtp_send_with_transport(&transport, &message).unwrap();
    let sent = transport.sent.lock().unwrap();
    assert_eq!(sent.len(), 1);
    assert_eq!(sent[0].subject, "hi");
}

#[test]
fn imap_idle_with_client_calls_idle() {
    let mut client = StubImap { called: false };
    EmailConnector::imap_idle_with_client(&mut client).unwrap();
    assert!(client.called);
}
