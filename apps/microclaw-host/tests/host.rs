use microclaw_host::Host;

#[test]
fn host_initializes() {
    let host = Host::new(microclaw_config::HostConfig::default());
    assert!(host.is_ok());
}
