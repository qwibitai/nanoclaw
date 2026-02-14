use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};

fn main() {
    let config = microclaw_config::HostConfig::from_env();
    let shutdown = Arc::new(AtomicBool::new(false));

    {
        let shutdown = shutdown.clone();
        ctrlc::set_handler(move || {
            shutdown.store(true, Ordering::Release);
        })
        .expect("install ctrl-c handler");
    }

    let mut host = microclaw_host::Host::new(config).expect("host init should succeed");
    host.run(shutdown).expect("host run should succeed");
}
