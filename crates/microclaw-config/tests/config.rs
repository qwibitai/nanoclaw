use microclaw_config::HostConfig;

#[test]
fn default_runner_backend_is_apple_container() {
    let cfg = HostConfig::default();
    assert_eq!(cfg.container_backend, "apple");
}
