use microclaw_sandbox::{EgressPolicy, Mount, MountPolicy, PolicyError};

#[test]
fn mount_allowlist_allows_prefix() {
    let policy = MountPolicy::new(vec!["/allowed".to_string()]);
    let mounts = vec![Mount::read_only("/allowed/data", "/workspace/data")];
    assert!(policy.validate(&mounts).is_ok());
}

#[test]
fn mount_allowlist_blocks_unknown() {
    let policy = MountPolicy::new(vec!["/allowed".to_string()]);
    let mounts = vec![Mount::read_only("/blocked/data", "/workspace/data")];
    let err = policy.validate(&mounts).unwrap_err();
    assert!(matches!(err, PolicyError::MountNotAllowed(_)));
}

#[test]
fn egress_denies_by_default() {
    let policy = EgressPolicy::new(vec![]);
    assert!(!policy.allows("api.example.com"));
}

#[test]
fn egress_allows_allowlisted() {
    let policy = EgressPolicy::new(vec!["api.example.com".to_string()]);
    assert!(policy.allows("api.example.com"));
}
