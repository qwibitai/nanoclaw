use microclaw_config::HostConfig;
use microclaw_store::Store;
use microclaw_bus::Bus;
use microclaw_scheduler::Scheduler;
use microclaw_queue::GroupQueue;
use microclaw_sandbox::AppleContainer;

pub struct Host {
    _config: HostConfig,
    _store: Store,
    _bus: Bus,
    _scheduler: Scheduler,
    _queue: GroupQueue<String>,
    _sandbox: AppleContainer,
}

impl Host {
    pub fn new(config: HostConfig) -> Result<Self, String> {
        let store = Store::open_in_memory().map_err(|e| e.to_string())?;
        let bus = Bus::open_in_memory().map_err(|e| e.to_string())?;
        Ok(Self {
            _config: config,
            _store: store,
            _bus: bus,
            _scheduler: Scheduler::new(),
            _queue: GroupQueue::new(128),
            _sandbox: AppleContainer::new(),
        })
    }
}
