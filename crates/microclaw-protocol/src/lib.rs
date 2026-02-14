use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct MessageId(String);

impl MessageId {
    pub fn new(v: impl Into<String>) -> Self {
        Self(v.into())
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Envelope {
    pub v: u8,
    pub seq: u64,
    pub source: String,
    pub device_id: String,
    pub session_id: String,
    pub message_id: MessageId,
}

impl Envelope {
    pub fn new(source: &str, device_id: &str, session_id: &str, message_id: MessageId) -> Self {
        Self {
            v: 1,
            seq: 1,
            source: source.into(),
            device_id: device_id.into(),
            session_id: session_id.into(),
            message_id,
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum MessageKind {
    Hello,
    HelloAck,
    StatusSnapshot,
    StatusDelta,
    SnapshotRequest,
    Command,
    CommandAck,
    CommandResult,
    Error,
    TouchEvent,
    Heartbeat,
    HostCommand,
    #[serde(other)]
    Unknown,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct DeviceCommand {
    pub action: DeviceAction,
    #[serde(default)]
    pub args: Value,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub struct DeviceStatus {
    #[serde(default)]
    pub wifi_ok: bool,
    #[serde(default)]
    pub host_reachable: bool,
    #[serde(default)]
    pub host_latency_ms: Option<u32>,
    #[serde(default)]
    pub rssi_dbm: Option<i32>,
    #[serde(default)]
    pub mode: Option<String>,
    #[serde(default)]
    pub scene: Option<String>,
    #[serde(default)]
    pub battery_percent: Option<u8>,
    #[serde(default)]
    pub queue_depth: Option<u16>,
    #[serde(default)]
    pub ota_state: Option<String>,
}

impl Default for DeviceStatus {
    fn default() -> Self {
        Self {
            wifi_ok: false,
            host_reachable: false,
            host_latency_ms: None,
            rssi_dbm: None,
            mode: None,
            scene: None,
            battery_percent: None,
            queue_depth: None,
            ota_state: None,
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "snake_case")]
pub enum DeviceAction {
    Reconnect,
    WifiReconnect,
    StatusGet,
    OtaStart,
    OpenConversation,
    MicToggle,
    Mute,
    EndSession,
    SyncNow,
    Unpair,
    DiagnosticsSnapshot,
    Restart,
    Retry,
    #[serde(other)]
    Unknown,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TouchPhase {
    Down,
    Move,
    Up,
    Cancel,
    #[serde(other)]
    Unknown,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct TouchEventPayload {
    #[serde(default)]
    pub pointer_id: u8,
    pub phase: TouchPhase,
    pub x: u16,
    pub y: u16,
    #[serde(default)]
    pub pressure: Option<u16>,
    #[serde(default)]
    pub raw_timestamp_ms: Option<u64>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct TransportMessage {
    #[serde(flatten)]
    pub envelope: Envelope,
    pub kind: MessageKind,
    #[serde(default)]
    pub corr_id: Option<String>,
    #[serde(default)]
    pub ttl_ms: Option<u64>,
    #[serde(default)]
    pub issued_at: Option<u64>,
    #[serde(default)]
    pub signature: Option<String>,
    #[serde(default)]
    pub nonce: Option<String>,
    #[serde(default)]
    pub payload: Value,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub struct ProtocolError {
    pub code: String,
    pub detail: String,
    pub recoverable: bool,
    #[serde(default)]
    pub retry_after_ms: Option<u64>,
}

impl TransportMessage {
    pub fn new(envelope: Envelope, kind: MessageKind, payload: Value) -> Self {
        Self {
            envelope,
            kind,
            corr_id: None,
            ttl_ms: None,
            issued_at: None,
            signature: None,
            nonce: None,
            payload,
        }
    }

    pub fn payload_as<T>(&self) -> Result<T, serde_json::Error>
    where
        T: DeserializeOwned,
    {
        serde_json::from_value(self.payload.clone())
    }

    pub fn as_touch_event(&self) -> Option<TouchEventPayload> {
        if self.kind != MessageKind::TouchEvent {
            return None;
        }
        self.payload_as().ok()
    }

    pub fn as_device_command(&self) -> Option<DeviceCommand> {
        if !matches!(self.kind, MessageKind::Command | MessageKind::HostCommand) {
            return None;
        }
        self.payload_as().ok()
    }

    pub fn as_status_snapshot(&self) -> Option<DeviceStatus> {
        if self.kind != MessageKind::StatusSnapshot && self.kind != MessageKind::StatusDelta {
            return None;
        }
        self.payload_as().ok()
    }

    pub fn is_expired(&self, now_ms: u64) -> bool {
        match (self.issued_at, self.ttl_ms) {
            (Some(ts), Some(ttl)) => now_ms.saturating_sub(ts) > ttl,
            _ => false,
        }
    }

    pub fn is_replay(&self, last_seq: u64) -> bool {
        self.envelope.seq <= last_seq
    }
}

impl ProtocolError {
    pub fn new(code: impl Into<String>, detail: impl Into<String>, recoverable: bool) -> Self {
        Self {
            code: code.into(),
            detail: detail.into(),
            recoverable,
            retry_after_ms: None,
        }
    }
}
