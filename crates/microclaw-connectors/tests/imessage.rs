use microclaw_connectors::IMessageConnector;

#[test]
fn builds_applescript_send_command() {
    let script = IMessageConnector::build_send_script("+15551212", "hello");
    assert!(script.contains("tell application \"Messages\""));
    assert!(script.contains("send \"hello\""));
    assert!(script.contains("buddy \"+15551212\""));
}

#[test]
fn builds_chat_db_query_with_rowid() {
    let query = IMessageConnector::chat_db_query();
    assert!(query.contains("FROM message"));
    assert!(query.contains("WHERE message.ROWID > ?"));
    assert!(query.contains("ORDER BY message.ROWID"));
}
