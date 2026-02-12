pub trait ContainerBackend {
    fn name(&self) -> &'static str;
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
