fn main() {
    let _ = microclaw_host::Host::new(microclaw_config::HostConfig::default())
        .expect("host init should succeed");
    println!("microclaw-host ready");
}
