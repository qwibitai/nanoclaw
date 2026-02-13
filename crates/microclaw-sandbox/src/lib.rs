pub trait ContainerBackend {
    fn name(&self) -> &'static str;
}

#[derive(Debug, Clone)]
pub struct Mount {
    pub source: String,
    pub target: String,
    pub read_only: bool,
}

impl Mount {
    pub fn read_only(source: &str, target: &str) -> Self {
        Self {
            source: source.to_string(),
            target: target.to_string(),
            read_only: true,
        }
    }

    fn to_apple_arg(&self) -> String {
        let mut arg = format!("type=bind,src={},dst={}", self.source, self.target);
        if self.read_only {
            arg.push_str(",readonly");
        }
        arg
    }

    fn to_docker_arg(&self) -> String {
        let suffix = if self.read_only { ":ro" } else { "" };
        format!("{}:{}{}", self.source, self.target, suffix)
    }
}

#[derive(Debug, Clone)]
pub enum PolicyError {
    MountNotAllowed(String),
}

pub struct MountPolicy {
    allowed_prefixes: Vec<String>,
}

impl MountPolicy {
    pub fn new(allowed_prefixes: Vec<String>) -> Self {
        Self { allowed_prefixes }
    }

    pub fn validate(&self, mounts: &[Mount]) -> Result<(), PolicyError> {
        for mount in mounts {
            let allowed = self
                .allowed_prefixes
                .iter()
                .any(|prefix| mount.source.starts_with(prefix));
            if !allowed {
                return Err(PolicyError::MountNotAllowed(mount.source.clone()));
            }
        }
        Ok(())
    }
}

pub struct EgressPolicy {
    allowlist: Vec<String>,
}

impl EgressPolicy {
    pub fn new(allowlist: Vec<String>) -> Self {
        Self { allowlist }
    }

    pub fn allows(&self, host: &str) -> bool {
        self.allowlist.iter().any(|entry| entry == host)
    }
}

#[derive(Debug, Clone)]
pub struct RunSpec {
    pub image: String,
    pub command: Vec<String>,
    pub mounts: Vec<Mount>,
    pub env: Vec<(String, String)>,
}

impl RunSpec {
    pub fn new(image: &str, command: Vec<String>) -> Self {
        Self {
            image: image.to_string(),
            command,
            mounts: Vec::new(),
            env: Vec::new(),
        }
    }

    pub fn add_mount(&mut self, mount: Mount) {
        self.mounts.push(mount);
    }

    pub fn add_env(&mut self, key: &str, value: &str) {
        self.env.push((key.to_string(), value.to_string()));
    }
}

pub struct AppleContainerRunner;

impl AppleContainerRunner {
    pub fn build_command(spec: &RunSpec) -> Vec<String> {
        let mut args = vec!["container".to_string(), "run".to_string(), "--rm".to_string()];
        for mount in &spec.mounts {
            args.push("--mount".to_string());
            args.push(mount.to_apple_arg());
        }
        for (key, value) in &spec.env {
            args.push("--env".to_string());
            args.push(format!("{}={}", key, value));
        }
        args.push(spec.image.clone());
        args.extend(spec.command.iter().cloned());
        args
    }
}

pub struct DockerRunner;

impl DockerRunner {
    pub fn build_command(spec: &RunSpec) -> Vec<String> {
        let mut args = vec!["docker".to_string(), "run".to_string(), "--rm".to_string()];
        for mount in &spec.mounts {
            args.push("-v".to_string());
            args.push(mount.to_docker_arg());
        }
        for (key, value) in &spec.env {
            args.push("-e".to_string());
            args.push(format!("{}={}", key, value));
        }
        args.push(spec.image.clone());
        args.extend(spec.command.iter().cloned());
        args
    }
}

pub struct AppleContainer;

impl AppleContainer {
    pub fn new() -> Self {
        Self
    }
}

impl ContainerBackend for AppleContainer {
    fn name(&self) -> &'static str {
        "apple"
    }
}

pub struct DockerBackend;

impl DockerBackend {
    pub fn new() -> Self {
        Self
    }
}

impl ContainerBackend for DockerBackend {
    fn name(&self) -> &'static str {
        "docker"
    }
}
