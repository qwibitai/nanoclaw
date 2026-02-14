pub mod boards;
pub mod display;
pub mod drivers;
pub mod event_loop;
pub mod pipeline;
pub mod renderer;
mod runtime;
pub mod slint_platform;
pub mod storage;
pub mod transport;
pub mod ui;

pub use runtime::{
    now_ms, AgentActivity, InFlightCommand, NotificationItem, RuntimeAction, RuntimeMode,
    RuntimeState, ToastNotification, ToastSeverity,
};

pub fn boot_message() -> &'static str {
    "microclaw-device ready"
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BootPhase {
    Start,
    WifiInit,
    WifiReady,
    DisplayInit,
    DisplayReady,
    TouchInit,
    TouchIrqReady,
    TransportInit,
    TransportReady,
    UiSceneReady,
    BootComplete,
    Failed(&'static str),
}

impl BootPhase {
    pub fn log(self) {
        let label = match self {
            BootPhase::Start => "boot_start",
            BootPhase::WifiInit => "boot_wifi_init",
            BootPhase::WifiReady => "boot_wifi_ready",
            BootPhase::DisplayInit => "boot_display_init",
            BootPhase::DisplayReady => "boot_display_init_ok",
            BootPhase::TouchInit => "boot_touch_init",
            BootPhase::TouchIrqReady => "boot_touch_irq_ok",
            BootPhase::TransportInit => "boot_transport_init",
            BootPhase::TransportReady => "boot_transport_init_ok",
            BootPhase::UiSceneReady => "boot_ui_scene_ready",
            BootPhase::BootComplete => "boot_complete",
            BootPhase::Failed(reason) => {
                println!("[microclaw] boot_failed: {reason}");
                return;
            }
        };
        println!("[microclaw] {label} t={}", now_ms());
    }
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
    use std::env;

    pub fn init_wifi() -> Result<(), EspError> {
        use esp_idf_svc::eventloop::EspSystemEventLoop;
        use esp_idf_svc::hal::peripherals::Peripherals;
        use esp_idf_svc::nvs::EspDefaultNvsPartition;
        use esp_idf_svc::wifi::{
            AuthMethod, BlockingWifi, ClientConfiguration, Configuration, EspWifi,
        };

        let ssid = env::var("MICROCLAW_WIFI_SSID")
            .map_err(|_| EspError::from_infallible::<esp_idf_svc::sys::ESP_ERR_INVALID_ARG>())?;
        let password = env::var("MICROCLAW_WIFI_PASSWORD").unwrap_or_default();
        let auth_env = env::var("MICROCLAW_WIFI_AUTH").unwrap_or_else(|_| "wpa2".to_string());
        let auth_method = match auth_env.to_lowercase().as_str() {
            "open" => AuthMethod::None,
            "wep" => AuthMethod::WEP,
            "wpa" => AuthMethod::WPA,
            "wpa2" => AuthMethod::WPA2Personal,
            "wpa3" => AuthMethod::WPA3Personal,
            _ => AuthMethod::WPA2Personal,
        };

        let peripherals = Peripherals::take()?;
        let sys_loop = EspSystemEventLoop::take()?;
        let nvs = EspDefaultNvsPartition::take()?;
        let mut wifi = BlockingWifi::wrap(
            EspWifi::new(peripherals.modem, sys_loop.clone(), Some(nvs))?,
            sys_loop,
        )?;
        let configuration = Configuration::Client(ClientConfiguration {
            ssid: ssid.try_into().map_err(|_| {
                EspError::from_infallible::<esp_idf_svc::sys::ESP_ERR_INVALID_ARG>()
            })?,
            bssid: None,
            auth_method,
            password: password.try_into().map_err(|_| {
                EspError::from_infallible::<esp_idf_svc::sys::ESP_ERR_INVALID_ARG>()
            })?,
            channel: None,
            ..Default::default()
        });
        wifi.set_configuration(&configuration)?;
        wifi.start()?;
        wifi.connect()?;
        wifi.wait_netif_up()?;
        Ok(())
    }

    pub fn resolve_transport_url(device_id: &str) -> Option<String> {
        if let Ok(raw) = std::env::var("MICROCLAW_WS_URL") {
            let url = raw.trim();
            if !url.is_empty() {
                return Some(url.to_owned());
            }
        }

        let host = std::env::var("MICROCLAW_HOST").ok()?;
        let host = host.trim();
        if host.is_empty() {
            return None;
        }
        Some(super::device_ws_url(host, device_id))
    }

    pub fn host_allowlist_from_env() -> Vec<String> {
        match env::var("MICROCLAW_HOST_ALLOWLIST") {
            Ok(raw) => raw
                .split(',')
                .map(str::trim)
                .filter(|entry| !entry.is_empty())
                .map(|entry| entry.to_string())
                .collect(),
            Err(_) => Vec::new(),
        }
    }
}

pub mod protocol {
    pub use microclaw_protocol::*;
}
