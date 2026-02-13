use microclaw_store::{RegisteredGroup, StoredMessage, Store};

#[test]
fn upserts_and_loads_registered_groups() {
    let store = Store::open_in_memory().unwrap();
    let group = RegisteredGroup {
        jid: "jid-1".to_string(),
        name: "Group One".to_string(),
        folder: "group_one".to_string(),
        trigger_pattern: "@Andy".to_string(),
        added_at: "2024-01-01T00:00:00Z".to_string(),
        container_config: Some("{}".to_string()),
        requires_trigger: true,
    };
    store.upsert_registered_group(&group).unwrap();

    let groups = store.load_registered_groups().unwrap();
    assert_eq!(groups.len(), 1);
    assert_eq!(groups[0], group);
}

#[test]
fn stores_and_filters_new_messages() {
    let store = Store::open_in_memory().unwrap();
    let msg1 = StoredMessage {
        id: "m1".to_string(),
        chat_jid: "jid-1".to_string(),
        sender: "user".to_string(),
        sender_name: "User".to_string(),
        content: "hello".to_string(),
        timestamp: "2024-01-01T00:00:01Z".to_string(),
        is_from_me: false,
    };
    let msg2 = StoredMessage {
        id: "m2".to_string(),
        chat_jid: "jid-1".to_string(),
        sender: "user".to_string(),
        sender_name: "User".to_string(),
        content: "Andy: ignore".to_string(),
        timestamp: "2024-01-01T00:00:02Z".to_string(),
        is_from_me: false,
    };
    store.store_message(&msg1).unwrap();
    store.store_message(&msg2).unwrap();

    let messages = store
        .load_new_messages(&vec!["jid-1".to_string()], "2024-01-01T00:00:00Z", "Andy")
        .unwrap();
    assert_eq!(messages.len(), 1);
    assert_eq!(messages[0].id, "m1");
}
