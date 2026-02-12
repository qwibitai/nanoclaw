use microclaw_sandbox::{AppleContainer, ContainerBackend};

#[test]
fn apple_backend_reports_name() {
    let backend = AppleContainer::new();
    assert_eq!(backend.name(), "apple");
}
