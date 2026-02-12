use microclaw_store::Store;

#[test]
fn applies_migrations() {
    let store = Store::open_in_memory().unwrap();
    let version = store.schema_version().unwrap();
    assert_eq!(version, 1);
}
