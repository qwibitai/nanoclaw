use microclaw_connectors::TelegramConnector;

#[test]
fn builds_telegram_send_message_url() {
    let url = TelegramConnector::send_message_url("token");
    assert_eq!(url, "https://api.telegram.org/bottoken/sendMessage");
}
