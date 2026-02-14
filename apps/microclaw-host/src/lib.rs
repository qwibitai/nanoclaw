use chrono::Utc;
use microclaw_bus::Bus;
use microclaw_config::HostConfig;
use microclaw_protocol::{
    DeviceAction, DeviceCommand, Envelope, MessageId, MessageKind, ProtocolError, TransportMessage,
};
use microclaw_queue::{ExecutionQueue, RetryPolicy as QueueRetryPolicy};
use microclaw_scheduler::{
    compute_next_run, due_tasks, update_task_after_run, ScheduleType, ScheduledTask,
};
use microclaw_sandbox::{
    AppleContainerRunner, DockerRunnerExec, EgressPolicy, Mount, MountPolicy, ProcessExecutor,
    RunSpec, SecretBroker,
};
use microclaw_store::Store;
use std::collections::{HashMap, HashSet, VecDeque};
use std::fmt::{Display, Formatter};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use std::thread;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};

const DEFAULT_LOOPBACK_DEPTH: usize = 128;

#[derive(Debug)]
pub struct HostError(pub String);

impl Display for HostError {
    fn fmt(&self, f: &mut Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for HostError {}

#[derive(Debug, Default, Clone)]
pub struct HostStatus {
    pub started_at_ms: u64,
    pub ticks: u64,
    pub in_flight: usize,
    pub inbound_frames: u64,
    pub outbound_frames: u64,
    pub inbound_filtered: u64,
    pub bus_replayed: u64,
    pub scheduler_polls: u64,
    pub scheduled_enqueued: u64,
    pub work_completed: u64,
    pub work_retries: u64,
    pub work_failed: u64,
    pub commands_rejected: u64,
    pub last_error: Option<String>,
}

#[derive(Debug, Default, Clone)]
pub struct StepReport {
    pub inbound_frames: u32,
    pub bus_frames: u32,
    pub scheduled_count: u32,
    pub scheduler_ticks: u32,
    pub work_dispatched: u32,
    pub work_succeeded: u32,
    pub work_failed: u32,
    pub transport_enqueued: u32,
    pub transport_dropped: u32,
}

#[derive(Debug, Clone)]
enum Work {
    Command {
        action: DeviceAction,
        corr_id: Option<String>,
        group: String,
        source: String,
        args: serde_json::Value,
    },
    ScheduledTask(ScheduledTask),
}

#[derive(Debug)]
struct LoopTransport {
    inbound: VecDeque<TransportMessage>,
    outbound: VecDeque<TransportMessage>,
    connected: bool,
    max_inbound: usize,
    max_outbound: usize,
    drops_in: u64,
    drops_out: u64,
    inbound_frames: u64,
    outbound_frames: u64,
}

impl LoopTransport {
    fn new(depth: usize) -> Self {
        Self {
            inbound: VecDeque::new(),
            outbound: VecDeque::new(),
            connected: true,
            max_inbound: depth,
            max_outbound: depth,
            drops_in: 0,
            drops_out: 0,
            inbound_frames: 0,
            outbound_frames: 0,
        }
    }

    fn push_inbound(&mut self, frame: TransportMessage) {
        if self.inbound.len() >= self.max_inbound {
            self.inbound.pop_front();
            self.drops_in = self.drops_in.saturating_add(1);
        }
        self.inbound.push_back(frame);
    }

    fn poll_frames(&mut self) -> Vec<TransportMessage> {
        let mut frames = Vec::with_capacity(self.inbound.len());
        while let Some(frame) = self.inbound.pop_front() {
            self.inbound_frames = self.inbound_frames.saturating_add(1);
            frames.push(frame);
        }
        frames
    }

    fn send_frame(&mut self, frame: TransportMessage) {
        if self.outbound.len() >= self.max_outbound {
            self.outbound.pop_front();
            self.drops_out = self.drops_out.saturating_add(1);
        }
        self.outbound.push_back(frame);
        self.outbound_frames = self.outbound_frames.saturating_add(1);
    }

    fn take_outbound(&mut self) -> Vec<TransportMessage> {
        let mut out = Vec::with_capacity(self.outbound.len());
        while let Some(frame) = self.outbound.pop_front() {
            out.push(frame);
        }
        out
    }

    fn outbound_depth(&self) -> usize {
        self.outbound.len()
    }

    fn connected(&self) -> bool {
        self.connected
    }

    fn set_connected(&mut self, connected: bool) {
        self.connected = connected;
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(Duration::from_millis(0), |v| v)
        .as_millis() as u64
}

pub struct Host {
    config: HostConfig,
    store: Store,
    bus: Bus,
    transport: LoopTransport,
    queue: ExecutionQueue<Work>,
    mount_policy: MountPolicy,
    egress_policy: EgressPolicy,
    apple: AppleContainerRunner<ProcessExecutor>,
    docker: DockerRunnerExec<ProcessExecutor>,
    secrets: SecretBroker,
    last_bus_seq: u64,
    last_scheduler_ms: u64,
    next_health_log_ms: u64,
    next_transport_retry_ms: u64,
    allowed_sources: HashSet<String>,
    allowed_actions: HashSet<DeviceAction>,
    inflight_task_ids: HashSet<String>,
    transport_recoveries: u64,
    backend_failures: u64,
    backend_circuit_until: u64,
    status: HostStatus,
    started_at: Instant,
}

impl Host {
    pub fn new(config: HostConfig) -> Result<Self, HostError> {
        let store = if let Some(path) = &config.store_path {
            Store::open(path).map_err(|error| HostError(error.to_string()))?
        } else {
            Store::open_in_memory().map_err(|error| HostError(error.to_string()))?
        };

        let bus = if let Some(path) = &config.bus_path {
            Bus::open(path).map_err(|error| HostError(error.to_string()))?
        } else {
            Bus::open_in_memory().map_err(|error| HostError(error.to_string()))?
        };

        let allowed_sources = config.allowed_sources.iter().cloned().collect();
        let allowed_actions = config
            .allowed_host_actions
            .iter()
            .filter_map(|raw| parse_host_action(raw))
            .collect::<HashSet<_>>();

        let queue = ExecutionQueue::new(
            config.max_inflight,
            QueueRetryPolicy::new(config.queue_retry_max_attempts, config.queue_retry_backoff_ms),
        );
        let mount_policy = MountPolicy::new(config.mount_allowlist.clone());
        let egress_policy = EgressPolicy::new(config.egress_allowlist.clone());

        Ok(Self {
            store,
            bus,
            transport: LoopTransport::new(DEFAULT_LOOPBACK_DEPTH),
            queue,
            mount_policy,
            egress_policy,
            apple: AppleContainerRunner::new(ProcessExecutor),
            docker: DockerRunnerExec::new(ProcessExecutor),
            secrets: SecretBroker::new(Vec::new(), HashMap::new()),
            last_bus_seq: 0,
            last_scheduler_ms: 0,
            next_health_log_ms: 0,
            next_transport_retry_ms: 0,
            allowed_sources,
            allowed_actions,
            inflight_task_ids: HashSet::new(),
            transport_recoveries: 0,
            backend_failures: 0,
            backend_circuit_until: 0,
            status: HostStatus {
                started_at_ms: now_ms(),
                ..HostStatus::default()
            },
            started_at: Instant::now(),
            config,
        })
    }

    pub fn run(&mut self, shutdown: Arc<AtomicBool>) -> Result<(), HostError> {
        self.emit_status(
            "host_boot",
            serde_json::json!({ "host_id": self.config.host_id.as_str(), "mode": "loopback" }),
        );
        let mut next_tick = now_ms();
        while !shutdown.load(Ordering::Acquire) {
            let sample_ms = now_ms();
            let _ = self.step(sample_ms);

            if sample_ms.saturating_sub(next_tick) < self.config.tick_interval_ms {
                thread::sleep(Duration::from_millis(
                    self.config.tick_interval_ms.saturating_sub(sample_ms.saturating_sub(next_tick)),
                ));
            }
            next_tick = now_ms();
        }

        self.emit_status("host_shutdown", serde_json::json!({ "ticks": self.status.ticks }));
        Ok(())
    }

    pub fn step(&mut self, now_ms: u64) -> StepReport {
        self.status.ticks = self.status.ticks.saturating_add(1);
        let mut report = StepReport::default();

        if now_ms >= self.next_health_log_ms {
            self.next_health_log_ms = now_ms.saturating_add(self.config.health_log_interval_ms.max(500));
            self.emit_status(
                "health",
                serde_json::json!({
                    "ticks": self.status.ticks,
                    "in_flight_tasks": self.inflight_task_ids.len(),
                    "backend_failures": self.backend_failures,
                    "transport_connected": self.transport.connected(),
                    "transport_outbound_depth": self.transport.outbound_depth(),
                    "bus_replayed": self.status.bus_replayed,
                }),
            );
        }

        self.recover_transport_if_needed(now_ms);
        report.inbound_frames = self.process_inbound(now_ms) as u32;
        report.bus_frames = self.process_bus() as u32;
        report.scheduled_count = self.poll_scheduler(now_ms, &mut report) as u32;
        report.work_dispatched = self.process_queue(now_ms, &mut report) as u32;

        report.transport_enqueued = self.transport.outbound_frames as u32;
        report.transport_dropped = self.transport.drops_out as u32;
        self.status.inbound_frames = self
            .status
            .inbound_frames
            .saturating_add(report.inbound_frames as u64);
        self.status.scheduler_polls = self.status.scheduler_polls.saturating_add(1);
        report
    }

    pub fn status(&self) -> HostStatus {
        HostStatus {
            started_at_ms: self.status.started_at_ms,
            ticks: self.status.ticks,
            in_flight: self.inflight_task_ids.len(),
            inbound_frames: self.status.inbound_frames,
            outbound_frames: self.status.outbound_frames,
            inbound_filtered: self.status.inbound_filtered,
            bus_replayed: self.status.bus_replayed,
            scheduler_polls: self.status.scheduler_polls,
            scheduled_enqueued: self.status.scheduled_enqueued,
            work_completed: self.status.work_completed,
            work_retries: self.status.work_retries,
            work_failed: self.status.work_failed,
            commands_rejected: self.status.commands_rejected,
            last_error: self.status.last_error.clone(),
        }
    }

    pub fn inject_transport_frame(&mut self, frame: TransportMessage) {
        self.transport.push_inbound(frame);
    }

    pub fn drain_transport_outbound(&mut self) -> Vec<TransportMessage> {
        self.transport.take_outbound()
    }

    pub fn set_transport_connected(&mut self, connected: bool) {
        self.transport.set_connected(connected);
    }

    pub fn store(&self) -> &Store {
        &self.store
    }

    fn process_inbound(&mut self, now_ms: u64) -> usize {
        let mut count: usize = 0;
        let frames = self.transport.poll_frames();
        for frame in frames {
            count = count.saturating_add(1);

            if !self.is_source_allowed(&frame.envelope.source) {
                self.status.inbound_filtered = self.status.inbound_filtered.saturating_add(1);
                continue;
            }

            if matches!(frame.kind, MessageKind::Command | MessageKind::HostCommand) {
                if let Some(cmd) = frame.as_device_command() {
                    self.enqueue_command(now_ms, frame.envelope.source, frame.envelope.session_id, frame.corr_id.clone(), cmd, frame.envelope.device_id);
                }
                continue;
            }

            if matches!(frame.kind, MessageKind::Heartbeat) {
                let status = serde_json::json!({
                    "ok": true,
                    "backend": self.config.container_backend.as_str(),
                });
                let outbound = self.build_outbound(
                    &frame.envelope.session_id,
                    MessageKind::CommandResult,
                    status,
                    frame.corr_id.clone(),
                );
                self.emit_outbound(outbound);
            }
        }
        count
    }

    fn enqueue_command(
        &mut self,
        now_ms: u64,
        source: String,
        group: String,
        corr_id: Option<String>,
        cmd: DeviceCommand,
        destination: String,
    ) {
        if !self.config.allowed_host_actions.is_empty() && !self.allowed_actions.contains(&cmd.action)
        {
            self.status.commands_rejected = self.status.commands_rejected.saturating_add(1);
            let rejected = self.build_outbound(
                &destination,
                MessageKind::Error,
                serde_json::json!({
                    "error": ProtocolError::new("command_denied", "command is not in host allowlist", false),
                    "source": source,
                }),
                corr_id,
            );
            self.emit_outbound(rejected);
            return;
        }

        let work_group = if group.is_empty() {
            destination.clone()
        } else {
            group
        };
        let queue_group = work_group.clone();

        self.queue.enqueue(
            &queue_group,
            &format!("cmd-{}-{}", destination, now_ms),
            Work::Command {
                action: cmd.action,
                corr_id,
                group: work_group,
                source,
                args: cmd.args,
            },
        );
    }

    fn process_bus(&mut self) -> usize {
        let mut count: usize = 0;
        match self.bus.replay_from_seq(self.last_bus_seq) {
            Ok(events) => {
                for env in events {
                    self.last_bus_seq = self.last_bus_seq.max(env.seq);
                    count = count.saturating_add(1);
                    self.status.bus_replayed = self.status.bus_replayed.saturating_add(1);
                }
            }
            Err(error) => {
                self.status.last_error = Some(error.to_string());
            }
        }
        count
    }

    fn poll_scheduler(&mut self, now_ms: u64, report: &mut StepReport) -> usize {
        if self.last_scheduler_ms != 0
            && now_ms.saturating_sub(self.last_scheduler_ms) < self.config.scheduler_poll_interval_ms
        {
            return 0;
        }
        self.last_scheduler_ms = now_ms;

        let mut scheduled: usize = 0;
        let due = match due_tasks(self.store.conn(), Utc::now()) {
            Ok(list) => list,
            Err(error) => {
                self.status.last_error = Some(error.to_string());
                return 0;
            }
        };

        for task in due {
            if task.status != "active" {
                continue;
            }
            if self.inflight_task_ids.contains(&task.id) {
                continue;
            }
            self.queue
                .enqueue(&task.chat_jid, &task.id, Work::ScheduledTask(task.clone()));
            self.inflight_task_ids.insert(task.id);
            self.status.scheduled_enqueued = self.status.scheduled_enqueued.saturating_add(1);
            report.scheduler_ticks = report.scheduler_ticks.saturating_add(1);
            scheduled = scheduled.saturating_add(1);
        }

        scheduled
    }

    fn process_queue(&mut self, now_ms: u64, report: &mut StepReport) -> usize {
        let mut processed: usize = 0;
        while let Some(item) = self.queue.next_ready(now_ms) {
            let id = item.id.clone();
            processed = processed.saturating_add(1);

            let mut ok = false;
            match self.run_work(item.payload.clone()) {
                Ok(Some(outbound)) => {
                    self.emit_outbound(outbound);
                    report.work_succeeded = report.work_succeeded.saturating_add(1);
                    self.status.work_completed = self.status.work_completed.saturating_add(1);
                    ok = true;
                }
                Ok(None) => {
                    self.status.work_completed = self.status.work_completed.saturating_add(1);
                    ok = true;
                }
                Err(error) => {
                    report.work_failed = report.work_failed.saturating_add(1);
                    self.status.work_failed = self.status.work_failed.saturating_add(1);
                    let finished = item.attempts >= self.config.queue_retry_max_attempts;
                    if !finished {
                        self.status.work_retries = self.status.work_retries.saturating_add(1);
                    }
                    self.status.last_error = Some(error.to_string());
                    if finished {
                        self.inflight_task_ids.remove(&id);
                    }
                }
            }

            if ok {
                self.inflight_task_ids.remove(&id);
            }
            self.queue.complete(item, ok, now_ms);
        }
        processed
    }

    fn run_work(&mut self, work: Work) -> Result<Option<TransportMessage>, HostError> {
        match work {
            Work::Command {
                action,
                corr_id,
                group,
                source,
                args,
            } => self.handle_command(action, corr_id, group, source, args),
            Work::ScheduledTask(task) => self.handle_scheduled_task(task),
        }
    }

    fn handle_command(
        &mut self,
        action: DeviceAction,
        corr_id: Option<String>,
        group: String,
        source: String,
        args: serde_json::Value,
    ) -> Result<Option<TransportMessage>, HostError> {
        let _ = source;
        let body = match action {
            DeviceAction::StatusGet => serde_json::json!({
                "host_id": self.config.host_id.as_str(),
                "device_id": self.config.device_id.as_str(),
                "uptime_ms": self.started_at.elapsed().as_millis(),
                "inflight": self.inflight_task_ids.len(),
                "connected": self.transport.connected(),
                "backend": self.config.container_backend.as_str(),
            }),
            DeviceAction::SyncNow => {
                let tasks = due_tasks(self.store.conn(), Utc::now()).map_err(|error| {
                    HostError(format!("scheduler_check_failed: {}", error))
                })?;
                serde_json::json!({
                    "message": "scheduler_tick_requested",
                    "due_count": tasks.len(),
                })
            }
            _ => serde_json::json!({
                "status": "accepted",
                "action": format!("{:?}", action),
                "args": args,
            }),
        };
        Ok(Some(self.build_outbound(
            &group,
            MessageKind::CommandResult,
            body,
            corr_id,
        )))
    }

    fn handle_scheduled_task(&mut self, task: ScheduledTask) -> Result<Option<TransportMessage>, HostError> {
        let started = now_ms();
        let output = self.run_in_sandbox(&task)?;
        let result = if output.status == 0 {
            output.stdout
        } else {
            return Err(HostError(format!(
                "sandbox execution failed: {}",
                output.stderr
            )));
        };

        let duration_ms = now_ms().saturating_sub(started);
        let next_run = match task.schedule_type {
            ScheduleType::Once => None,
            _ => {
                compute_next_run(task.schedule_type, &task.schedule_value, Utc::now())
                    .ok()
            }
        };

        update_task_after_run(self.store.conn(), &task.id, next_run, &result, Utc::now())
            .map_err(|error| HostError(format!("task_update_failed: {}", error)))?;

        Ok(Some(self.build_outbound(
            &task.chat_jid,
            MessageKind::CommandResult,
            serde_json::json!({
                "task_id": task.id,
                "duration_ms": duration_ms,
                "result": result,
                "next_run": next_run.map(|value| value.to_rfc3339()),
            }),
            None,
        )))
    }

    fn run_in_sandbox(&mut self, task: &ScheduledTask) -> Result<microclaw_sandbox::CommandResult, HostError> {
        if self.config.dry_run {
            return Ok(microclaw_sandbox::CommandResult {
                status: 0,
                stdout: format!("dry-run {} {}", task.id, task.prompt),
                stderr: String::new(),
            });
        }

        let now = now_ms();
        if now < self.backend_circuit_until {
            return Err(HostError("sandbox backend circuit breaker active".to_string()));
        }

        let mut spec = RunSpec::new(
            &self.config.container_image,
            vec![
                "echo".to_string(),
                format!(
                    "nano-claw task={} prompt={} context={}",
                    task.id, task.prompt, task.context_mode
                ),
            ],
        );
        spec.add_env("NANOCLAW_HOST_ID", &self.config.host_id);
        spec.add_env("NANOCLAW_GROUP", &task.group_folder);

        for mount in &self.config.mount_allowlist {
            spec.add_mount(Mount::read_only(mount, mount));
        }

        for host in &self.config.egress_allowlist {
            spec.add_egress_host(host);
        }

        let status = if self.config.container_backend == "apple" {
            self.apple.run_with_policy(&spec, &self.mount_policy, &self.egress_policy)
        } else {
            self.docker.run_with_policy(&spec, &self.mount_policy, &self.egress_policy)
        };

        match status {
            Ok(result) => {
                self.backend_failures = 0;
                self.backend_circuit_until = 0;
                Ok(result)
            }
            Err(error) => {
                self.backend_failures = self.backend_failures.saturating_add(1);
                let backoff_ms = (1_u64 << self.backend_failures.min(12))
                    .saturating_mul(self.config.queue_retry_backoff_ms);
                self.backend_circuit_until = now.saturating_add(backoff_ms.min(30_000));
                Err(HostError(format!("sandbox_run_failed: {}", error)))
            }
        }
    }

    fn emit_outbound(&mut self, frame: TransportMessage) {
        self.status.outbound_frames = self.status.outbound_frames.saturating_add(1);
        self.transport.send_frame(frame);
    }

    fn build_outbound(
        &self,
        destination: &str,
        kind: MessageKind,
        payload: serde_json::Value,
        corr_id: Option<String>,
    ) -> TransportMessage {
        let mut frame = TransportMessage::new(
            Envelope::new(
                &self.config.host_id,
                destination,
                destination,
                MessageId::new(format!(
                    "{}-{}",
                    if destination.is_empty() {
                        "global"
                    } else {
                        destination
                    },
                    now_ms()
                )),
            ),
            kind,
            payload,
        );
        frame.corr_id = corr_id;
        frame
    }

    fn emit_status(&self, event: &str, fields: serde_json::Value) {
        let mut map = serde_json::Map::new();
        map.insert("event".to_string(), serde_json::json!(event));
        map.insert("level".to_string(), serde_json::json!("info"));
        if let serde_json::Value::Object(data) = fields {
            map.extend(data);
        }
        if let Ok(text) = serde_json::to_string(&serde_json::Value::Object(map)) {
            println!("{}", text);
        }
    }

    fn recover_transport_if_needed(&mut self, now_ms: u64) {
        if self.transport.connected() || now_ms < self.next_transport_retry_ms {
            return;
        }

        self.transport_recoveries = self.transport_recoveries.saturating_add(1);
        if self.transport_recoveries > 0 && self.transport_recoveries < 2 {
            let backoff = self.config.transport_reconnect_backoff_ms.max(200);
            self.next_transport_retry_ms = now_ms.saturating_add(backoff);
            return;
        }

        self.transport_recoveries = 0;
        self.transport.set_connected(true);
    }

    fn is_source_allowed(&self, source: &str) -> bool {
        if self.allowed_sources.is_empty() {
            true
        } else {
            self.allowed_sources.contains(source)
        }
    }
}

fn parse_host_action(raw: &str) -> Option<DeviceAction> {
    match raw.to_ascii_lowercase().as_str() {
        "reconnect" => Some(DeviceAction::Reconnect),
        "wifi_reconnect" => Some(DeviceAction::WifiReconnect),
        "status_get" => Some(DeviceAction::StatusGet),
        "status" => Some(DeviceAction::StatusGet),
        "host_status" => Some(DeviceAction::StatusGet),
        "sync_now" => Some(DeviceAction::SyncNow),
        "open_conversation" => Some(DeviceAction::OpenConversation),
        "mic_toggle" => Some(DeviceAction::MicToggle),
        "mute" => Some(DeviceAction::Mute),
        "end_session" => Some(DeviceAction::EndSession),
        "unpair" => Some(DeviceAction::Unpair),
        "diagnostics_snapshot" => Some(DeviceAction::DiagnosticsSnapshot),
        "restart" => Some(DeviceAction::Restart),
        "retry" => Some(DeviceAction::Retry),
        "ota_start" => Some(DeviceAction::OtaStart),
        _ => None,
    }
}
