#[derive(Clone, Debug)]
pub struct HostConfig {
    pub container_backend: String,
}

impl Default for HostConfig {
    fn default() -> Self {
        Self { container_backend: "apple".to_string() }
    }
}
