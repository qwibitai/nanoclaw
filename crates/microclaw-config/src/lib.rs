#[derive(Clone, Debug)]
pub struct HostConfig {
    pub host_id: String,
    pub device_id: String,
    pub container_backend: String,
    pub container_image: String,
    pub tick_interval_ms: u64,
    pub max_inflight: usize,
    pub queue_retry_max_attempts: usize,
    pub queue_retry_backoff_ms: u64,
    pub scheduler_poll_interval_ms: u64,
    pub store_path: Option<String>,
    pub bus_path: Option<String>,
    pub mount_allowlist: Vec<String>,
    pub egress_allowlist: Vec<String>,
    pub allowed_sources: Vec<String>,
    pub allowed_host_actions: Vec<String>,
    pub transport_reconnect_backoff_ms: u64,
    pub health_log_interval_ms: u64,
    pub dry_run: bool,
}

impl Default for HostConfig {
    fn default() -> Self {
        Self {
            host_id: "microclaw-host".to_string(),
            device_id: "microclaw-device".to_string(),
            container_backend: "apple".to_string(),
            container_image: "nanoclaw-agent:latest".to_string(),
            tick_interval_ms: 250,
            max_inflight: 4,
            queue_retry_max_attempts: 3,
            queue_retry_backoff_ms: 500,
            scheduler_poll_interval_ms: 1000,
            store_path: None,
            bus_path: None,
            mount_allowlist: vec!["/tmp".to_string()],
            egress_allowlist: vec![],
            allowed_sources: vec![],
            allowed_host_actions: vec![
                "status_get".to_string(),
                "sync_now".to_string(),
            ],
            transport_reconnect_backoff_ms: 1_000,
            health_log_interval_ms: 5_000,
            dry_run: false,
        }
    }
}

impl HostConfig {
    pub fn from_env() -> Self {
        let mut config = Self::default();

        if let Ok(raw) = std::env::var("NANOCLAW_HOST_ID") {
            if !raw.trim().is_empty() {
                config.host_id = raw.trim().to_string();
            }
        }

        if let Ok(raw) = std::env::var("NANOCLAW_DEVICE_ID") {
            if !raw.trim().is_empty() {
                config.device_id = raw.trim().to_string();
            }
        }

        if let Ok(backend) = std::env::var("NANOCLAW_CONTAINER_BACKEND") {
            if !backend.trim().is_empty() {
                config.container_backend = backend.trim().to_ascii_lowercase();
            }
        }

        if let Ok(image) = std::env::var("NANOCLAW_CONTAINER_IMAGE") {
            if !image.trim().is_empty() {
                config.container_image = image.trim().to_string();
            }
        }

        if let Ok(raw) = std::env::var("NANOCLAW_TICK_INTERVAL_MS") {
            if let Ok(value) = raw.trim().parse::<u64>() {
                config.tick_interval_ms = value;
            }
        }

        if let Ok(raw) = std::env::var("NANOCLAW_MAX_INFLIGHT") {
            if let Ok(value) = raw.trim().parse::<usize>() {
                config.max_inflight = value.max(1);
            }
        }

        if let Ok(raw) = std::env::var("NANOCLAW_QUEUE_RETRY_MAX_ATTEMPTS") {
            if let Ok(value) = raw.trim().parse::<usize>() {
                config.queue_retry_max_attempts = value.max(1);
            }
        }

        if let Ok(raw) = std::env::var("NANOCLAW_QUEUE_RETRY_BACKOFF_MS") {
            if let Ok(value) = raw.trim().parse::<u64>() {
                config.queue_retry_backoff_ms = value;
            }
        }

        if let Ok(raw) = std::env::var("NANOCLAW_SCHEDULER_POLL_INTERVAL_MS") {
            if let Ok(value) = raw.trim().parse::<u64>() {
                config.scheduler_poll_interval_ms = value.max(100);
            }
        }

        if let Ok(raw) = std::env::var("NANOCLAW_STORE_PATH") {
            if !raw.trim().is_empty() {
                config.store_path = Some(raw);
            }
        }

        if let Ok(raw) = std::env::var("NANOCLAW_BUS_PATH") {
            if !raw.trim().is_empty() {
                config.bus_path = Some(raw);
            }
        }

        if let Ok(raw) = std::env::var("NANOCLAW_MOUNT_ALLOWLIST") {
            config.mount_allowlist = raw
                .split(',')
                .map(|entry| entry.trim().to_string())
                .filter(|entry| !entry.is_empty())
                .collect();
        }

        if let Ok(raw) = std::env::var("NANOCLAW_EGRESS_ALLOWLIST") {
            config.egress_allowlist = raw
                .split(',')
                .map(|entry| entry.trim().to_string())
                .filter(|entry| !entry.is_empty())
                .collect();
        }

        if let Ok(raw) = std::env::var("NANOCLAW_ALLOWED_SOURCES") {
            config.allowed_sources = raw
                .split(',')
                .map(|entry| entry.trim().to_string())
                .filter(|entry| !entry.is_empty())
                .collect();
        }

        if let Ok(raw) = std::env::var("NANOCLAW_ALLOWED_HOST_ACTIONS") {
            config.allowed_host_actions = raw
                .split(',')
                .map(|entry| entry.trim().to_string())
                .filter(|entry| !entry.is_empty())
                .collect();
        }

        if let Ok(raw) = std::env::var("NANOCLAW_TRANSPORT_RECONNECT_BACKOFF_MS") {
            if let Ok(value) = raw.trim().parse::<u64>() {
                config.transport_reconnect_backoff_ms = value;
            }
        }

        if let Ok(raw) = std::env::var("NANOCLAW_HEALTH_LOG_INTERVAL_MS") {
            if let Ok(value) = raw.trim().parse::<u64>() {
                config.health_log_interval_ms = value.max(500);
            }
        }

        if let Ok(raw) = std::env::var("NANOCLAW_DRY_RUN") {
            if let Ok(value) = raw.trim().parse::<bool>() {
                config.dry_run = value;
            }
        }

        config
    }
}
