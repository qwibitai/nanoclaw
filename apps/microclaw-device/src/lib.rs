pub mod display;
pub mod drivers;
pub mod boards;
pub mod event_loop;
pub mod pipeline;
pub mod renderer;
mod runtime;
pub mod ui;

pub use runtime::{now_ms, InFlightCommand, RuntimeAction, RuntimeMode, RuntimeState};

pub fn boot_message() -> &'static str {
    "microclaw-device ready"
}

pub fn device_ws_url(host: &str, device_id: &str) -> String {
    format!("wss://{}/ws?device_id={}", host, device_id)
}

pub fn reconnect_backoff_ms(attempt: u32) -> u64 {
    let attempt = attempt.max(1) as u64;
    let backoff = 500u64.saturating_mul(1 << (attempt - 1).min(5));
    backoff.min(30_000)
}

pub fn ui_shell_title() -> &'static str {
    "microclaw"
}

#[cfg(feature = "esp")]
pub fn esp_feature_hint() -> &'static str {
    "esp-idf enabled"
}

#[cfg(not(feature = "esp"))]
pub fn esp_feature_hint() -> &'static str {
    "esp-idf disabled"
}

#[cfg(feature = "esp")]
pub mod esp_runtime {
    use esp_idf_svc::sys::EspError;

    pub fn init_wifi() -> Result<(), EspError> {
        Ok(())
    }
}

pub mod protocol {
    pub use microclaw_protocol::*;
}
