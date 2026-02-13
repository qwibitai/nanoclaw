use microclaw_connectors::EmailConnector;

#[test]
fn builds_smtp_mail_from() {
    let cmd = EmailConnector::smtp_mail_from("me@example.com");
    assert_eq!(cmd, "MAIL FROM:<me@example.com>");
}

#[test]
fn builds_imap_idle_command() {
    let cmd = EmailConnector::imap_idle_command();
    assert_eq!(cmd, "IDLE");
}
