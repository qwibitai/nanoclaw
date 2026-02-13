use microclaw_sandbox::{AppleContainerRunner, Mount, RunSpec};

#[test]
fn builds_apple_container_command() {
    let mut spec = RunSpec::new("microclaw-agent:latest", vec!["/bin/sh".into()]);
    spec.add_mount(Mount::read_only("/host/data", "/workspace/data"));
    spec.add_env("TOKEN", "redacted");

    let args = AppleContainerRunner::build_command(&spec);
    assert_eq!(args[0], "container");
    assert!(args.contains(&"--rm".to_string()));
    assert!(args.contains(&"--mount".to_string()));
    assert!(args.iter().any(|arg| arg.contains("src=/host/data")));
    assert!(args.iter().any(|arg| arg == "TOKEN=redacted"));
    assert!(args.iter().any(|arg| arg == "microclaw-agent:latest"));
}
