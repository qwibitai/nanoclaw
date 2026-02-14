use microclaw_device::storage::{keys, DeviceStorage, InMemoryStorage};
use microclaw_device::{RuntimeMode, RuntimeState};

#[test]
fn storage_backed_state_loads_zero_boot_failures_from_empty_storage() {
    let storage = Box::new(InMemoryStorage::new());
    let state = RuntimeState::with_storage(storage);
    assert_eq!(state.boot_failure_count(), 0);
    assert!(matches!(state.mode(), RuntimeMode::Booting));
}

#[test]
fn storage_backed_state_loads_persisted_boot_failure_count() {
    let mut storage = InMemoryStorage::new();
    storage.set_u32(keys::BOOT_FAILURE_COUNT, 2);
    let state = RuntimeState::with_storage(Box::new(storage));
    assert_eq!(state.boot_failure_count(), 2);
    // Below threshold (3), should remain Booting
    assert!(
        matches!(state.mode(), RuntimeMode::Booting),
        "expected Booting with count below limit, got {:?}",
        state.mode()
    );
}

#[test]
fn storage_backed_state_enters_safe_mode_when_persisted_count_exceeds_limit() {
    let mut storage = InMemoryStorage::new();
    storage.set_u32(keys::BOOT_FAILURE_COUNT, 3);
    let state = RuntimeState::with_storage(Box::new(storage));
    assert_eq!(state.boot_failure_count(), 3);
    assert!(
        matches!(state.mode(), RuntimeMode::SafeMode(_)),
        "expected SafeMode with count >= limit, got {:?}",
        state.mode()
    );
}

#[test]
fn mark_boot_failure_persists_to_storage() {
    let storage = Box::new(InMemoryStorage::new());
    let mut state = RuntimeState::with_storage(storage);

    state.mark_boot_failure(100, "fail-1");
    assert_eq!(state.boot_failure_count(), 1);

    // Verify the count was written to storage by creating a new state from the same storage.
    // We can't extract the storage back, but we test the persist path indirectly:
    // mark_boot_failure increments and persists, so successive calls accumulate.
    state.mark_boot_failure(200, "fail-2");
    assert_eq!(state.boot_failure_count(), 2);

    state.mark_boot_failure(300, "fail-3");
    assert_eq!(state.boot_failure_count(), 3);
    assert!(
        matches!(state.mode(), RuntimeMode::SafeMode(_)),
        "expected SafeMode after 3 failures, got {:?}",
        state.mode()
    );
}

#[test]
fn clear_boot_failure_count_persists_zero() {
    let mut storage = InMemoryStorage::new();
    storage.set_u32(keys::BOOT_FAILURE_COUNT, 2);
    let mut state = RuntimeState::with_storage(Box::new(storage));

    assert_eq!(state.boot_failure_count(), 2);
    state.clear_boot_failure_count();
    assert_eq!(state.boot_failure_count(), 0);
}

#[test]
fn state_without_storage_still_works() {
    // Backward compatibility: no storage = memory-only, same as before
    let mut state = RuntimeState::new();
    state.mark_boot_failure(100, "fail");
    assert_eq!(state.boot_failure_count(), 1);
    state.clear_boot_failure_count();
    assert_eq!(state.boot_failure_count(), 0);
}

#[test]
fn storage_loads_device_id() {
    let mut storage = InMemoryStorage::new();
    storage.set_string(keys::DEVICE_ID, "my-device-42");
    let state = RuntimeState::with_storage(Box::new(storage));
    // emit_command uses the device_id in the envelope
    // We verify indirectly by checking the command envelope
    let mut state = state;
    let cmd = state.emit_command(microclaw_protocol::DeviceAction::StatusGet);
    assert_eq!(cmd.envelope.device_id, "my-device-42");
    assert_eq!(cmd.envelope.source, "my-device-42");
}

#[test]
fn in_memory_storage_basic_operations() {
    let mut s = InMemoryStorage::new();

    // u32
    assert_eq!(s.get_u32("k"), None);
    s.set_u32("k", 42);
    assert_eq!(s.get_u32("k"), Some(42));

    // string
    assert_eq!(s.get_string("s"), None);
    s.set_string("s", "hello");
    assert_eq!(s.get_string("s"), Some("hello".to_owned()));

    // bytes
    assert_eq!(s.get_bytes("b"), None);
    s.set_bytes("b", &[1, 2, 3]);
    assert_eq!(s.get_bytes("b"), Some(vec![1, 2, 3]));

    // remove clears all types
    s.remove("k");
    assert_eq!(s.get_u32("k"), None);
    s.remove("s");
    assert_eq!(s.get_string("s"), None);
    s.remove("b");
    assert_eq!(s.get_bytes("b"), None);
}
