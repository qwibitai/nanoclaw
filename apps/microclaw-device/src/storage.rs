use std::collections::HashMap;

pub trait DeviceStorage {
    fn get_u32(&self, key: &str) -> Option<u32>;
    fn set_u32(&mut self, key: &str, value: u32);
    fn get_string(&self, key: &str) -> Option<String>;
    fn set_string(&mut self, key: &str, value: &str);
    fn get_bytes(&self, key: &str) -> Option<Vec<u8>>;
    fn set_bytes(&mut self, key: &str, value: &[u8]);
    fn remove(&mut self, key: &str);
}

pub struct InMemoryStorage {
    u32s: HashMap<String, u32>,
    strings: HashMap<String, String>,
    bytes: HashMap<String, Vec<u8>>,
}

impl InMemoryStorage {
    pub fn new() -> Self {
        Self {
            u32s: HashMap::new(),
            strings: HashMap::new(),
            bytes: HashMap::new(),
        }
    }
}

impl Default for InMemoryStorage {
    fn default() -> Self {
        Self::new()
    }
}

impl DeviceStorage for InMemoryStorage {
    fn get_u32(&self, key: &str) -> Option<u32> {
        self.u32s.get(key).copied()
    }

    fn set_u32(&mut self, key: &str, value: u32) {
        self.u32s.insert(key.to_owned(), value);
    }

    fn get_string(&self, key: &str) -> Option<String> {
        self.strings.get(key).cloned()
    }

    fn set_string(&mut self, key: &str, value: &str) {
        self.strings.insert(key.to_owned(), value.to_owned());
    }

    fn get_bytes(&self, key: &str) -> Option<Vec<u8>> {
        self.bytes.get(key).cloned()
    }

    fn set_bytes(&mut self, key: &str, value: &[u8]) {
        self.bytes.insert(key.to_owned(), value.to_vec());
    }

    fn remove(&mut self, key: &str) {
        self.u32s.remove(key);
        self.strings.remove(key);
        self.bytes.remove(key);
    }
}

pub mod keys {
    pub const BOOT_FAILURE_COUNT: &str = "boot_failure_count";
    pub const BOOT_SUCCESS: &str = "boot_success";
    pub const DEVICE_ID: &str = "device_id";
    pub const WIFI_SSID: &str = "wifi_ssid";
    pub const WIFI_PASSWORD: &str = "wifi_password";
    pub const HOST_URL: &str = "host_url";
    pub const HOST_ALLOWLIST: &str = "host_allowlist";
}
