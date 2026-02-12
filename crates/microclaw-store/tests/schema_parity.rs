use microclaw_store::Store;

fn table_exists(store: &Store, name: &str) -> bool {
    store
        .conn()
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name=?",
            [name],
            |row| row.get::<_, i64>(0),
        )
        .unwrap_or(0)
        > 0
}

#[test]
fn schema_includes_core_tables() {
    let store = Store::open_in_memory().unwrap();
    let required = [
        "chats",
        "messages",
        "scheduled_tasks",
        "task_run_logs",
        "router_state",
        "sessions",
        "registered_groups",
    ];
    for table in required {
        assert!(table_exists(&store, table), "missing table {table}");
    }
}

#[test]
fn scheduled_tasks_has_context_mode() {
    let store = Store::open_in_memory().unwrap();
    let mut stmt = store
        .conn()
        .prepare("PRAGMA table_info(scheduled_tasks)")
        .unwrap();
    let columns: Vec<String> = stmt
        .query_map([], |row| row.get::<_, String>(1))
        .unwrap()
        .map(|r| r.unwrap())
        .collect();
    assert!(columns.iter().any(|c| c == "context_mode"));
}
