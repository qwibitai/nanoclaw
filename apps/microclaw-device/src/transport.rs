use std::collections::VecDeque;
#[cfg(feature = "esp")]
use std::sync::mpsc::{self, Receiver, SyncSender};
#[cfg(feature = "esp")]
use std::time::Duration as StdDuration;

#[cfg(feature = "esp")]
use esp_idf_svc::ws::client::{
    EspWebSocketClient, EspWebSocketClientConfig, FrameType, WebSocketEvent, WebSocketEventType,
};
use microclaw_protocol::TransportMessage;
#[cfg(feature = "esp")]
use serde_json;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct TransportStats {
    pub inbound_frames: u64,
    pub outbound_frames: u64,
    pub dropped_inbound: u64,
    pub dropped_outbound: u64,
}

impl TransportStats {
    pub const fn new() -> Self {
        Self {
            inbound_frames: 0,
            outbound_frames: 0,
            dropped_inbound: 0,
            dropped_outbound: 0,
        }
    }
}

impl Default for TransportStats {
    fn default() -> Self {
        Self::new()
    }
}

pub trait TransportBus {
    fn is_connected(&self) -> bool;
    fn poll_frames(&mut self) -> Vec<TransportMessage>;
    fn send_frame(&mut self, frame: TransportMessage);
    fn transport_stats(&self) -> TransportStats;
    fn set_connected(&mut self, connected: bool);
    fn reconnect(&mut self, attempt: u32, now_ms: u64) -> bool {
        let _ = self.is_connected();
        let _ = (attempt, now_ms);
        false
    }
}

#[derive(Clone, Debug)]
pub struct InMemoryTransport {
    inbound: VecDeque<TransportMessage>,
    outbound: VecDeque<TransportMessage>,
    connected: bool,
    max_inbound: usize,
    max_outbound: usize,
    stats: TransportStats,
    reconnect_attempts: u64,
    reconnect_failures_remaining: u64,
}

impl InMemoryTransport {
    pub fn new() -> Self {
        Self {
            inbound: VecDeque::new(),
            outbound: VecDeque::new(),
            connected: false,
            max_inbound: 128,
            max_outbound: 128,
            stats: TransportStats::new(),
            reconnect_attempts: 0,
            reconnect_failures_remaining: 0,
        }
    }

    pub fn with_queue_depth(max_inbound: usize, max_outbound: usize) -> Self {
        Self {
            inbound: VecDeque::new(),
            outbound: VecDeque::new(),
            connected: false,
            max_inbound,
            max_outbound,
            stats: TransportStats::new(),
            reconnect_attempts: 0,
            reconnect_failures_remaining: 0,
        }
    }

    pub fn push_inbound(&mut self, frame: TransportMessage) {
        if self.inbound.len() >= self.max_inbound {
            self.inbound.pop_front();
            self.stats.dropped_inbound = self.stats.dropped_inbound.saturating_add(1);
        }
        self.inbound.push_back(frame);
    }

    pub fn drain_outbound(&mut self) -> Vec<TransportMessage> {
        let mut out = Vec::with_capacity(self.outbound.len());
        while let Some(frame) = self.outbound.pop_front() {
            out.push(frame);
        }
        out
    }

    pub fn inbound_depth(&self) -> usize {
        self.inbound.len()
    }

    pub fn outbound_depth(&self) -> usize {
        self.outbound.len()
    }

    pub fn reconnect_attempts(&self) -> u64 {
        self.reconnect_attempts
    }

    pub fn set_reconnect_failures_until_success(&mut self, failures: u64) {
        self.reconnect_failures_remaining = failures;
    }
}

impl Default for InMemoryTransport {
    fn default() -> Self {
        Self::new()
    }
}

impl TransportBus for InMemoryTransport {
    fn is_connected(&self) -> bool {
        self.connected
    }

    fn set_connected(&mut self, connected: bool) {
        self.connected = connected;
    }

    fn reconnect(&mut self, _attempt: u32, _now_ms: u64) -> bool {
        self.reconnect_attempts = self.reconnect_attempts.saturating_add(1);
        if self.reconnect_failures_remaining != 0 {
            self.reconnect_failures_remaining = self.reconnect_failures_remaining.saturating_sub(1);
            return false;
        }
        self.connected = true;
        true
    }

    fn poll_frames(&mut self) -> Vec<TransportMessage> {
        let mut out = Vec::with_capacity(self.inbound.len());
        while let Some(frame) = self.inbound.pop_front() {
            self.stats.inbound_frames = self.stats.inbound_frames.saturating_add(1);
            out.push(frame);
        }
        out
    }

    fn send_frame(&mut self, frame: TransportMessage) {
        if self.outbound.len() >= self.max_outbound {
            self.outbound.pop_front();
            self.stats.dropped_outbound = self.stats.dropped_outbound.saturating_add(1);
        }
        self.stats.outbound_frames = self.stats.outbound_frames.saturating_add(1);
        self.outbound.push_back(frame);
    }

    fn transport_stats(&self) -> TransportStats {
        self.stats
    }
}

#[cfg(feature = "esp")]
#[derive(Debug)]
enum WsEvent {
    Connected,
    Disconnected,
    TextFrame(String),
}

#[cfg(feature = "esp")]
impl WsEvent {
    fn text(raw: &str) -> Self {
        Self::TextFrame(raw.to_owned())
    }
}

#[cfg(feature = "esp")]
pub struct WsTransport {
    url: String,
    source: String,
    connected: bool,
    max_inbound: usize,
    max_outbound: usize,
    inbound: VecDeque<TransportMessage>,
    outbound: VecDeque<TransportMessage>,
    stats: TransportStats,
    event_sender: SyncSender<WsEvent>,
    event_receiver: Receiver<WsEvent>,
    ws: Option<EspWebSocketClient<'static>>,
    timeout: StdDuration,
}

#[cfg(feature = "esp")]
impl WsTransport {
    pub fn new(url: impl Into<String>, source: impl Into<String>) -> Self {
        let (event_sender, event_receiver) = mpsc::sync_channel(32);
        Self {
            url: url.into(),
            source: source.into(),
            connected: false,
            max_inbound: 128,
            max_outbound: 128,
            inbound: VecDeque::new(),
            outbound: VecDeque::new(),
            stats: TransportStats::new(),
            event_sender,
            event_receiver,
            ws: None,
            timeout: StdDuration::from_secs(10),
        }
    }

    pub fn with_queue_depth(
        url: impl Into<String>,
        source: impl Into<String>,
        max_inbound: usize,
        max_outbound: usize,
    ) -> Self {
        let mut transport = Self::new(url, source);
        transport.max_inbound = max_inbound;
        transport.max_outbound = max_outbound;
        transport
    }

    fn push_inbound(&mut self, frame: TransportMessage) {
        if self.inbound.len() >= self.max_inbound {
            self.inbound.pop_front();
            self.stats.dropped_inbound = self.stats.dropped_inbound.saturating_add(1);
        }
        self.inbound.push_back(frame);
    }

    fn push_outbound(&mut self, frame: TransportMessage) {
        if self.outbound.len() >= self.max_outbound {
            self.outbound.pop_front();
            self.stats.dropped_outbound = self.stats.dropped_outbound.saturating_add(1);
        }
        self.outbound.push_back(frame);
    }

    fn parse_incoming_text(&mut self, payload: &str) {
        match serde_json::from_str::<TransportMessage>(payload) {
            Ok(msg) => {
                if self.source.is_empty() || msg.envelope.source != self.source {
                    self.push_inbound(msg);
                }
            }
            Err(_) => {
                self.stats.dropped_inbound = self.stats.dropped_inbound.saturating_add(1);
            }
        }
    }

    fn sync_events(&mut self) {
        loop {
            match self.event_receiver.try_recv() {
                Ok(event) => match event {
                    WsEvent::Connected => {
                        self.connected = true;
                    }
                    WsEvent::Disconnected => {
                        self.connected = false;
                    }
                    WsEvent::TextFrame(payload) => {
                        self.parse_incoming_text(&payload);
                    }
                },
                Err(mpsc::TryRecvError::Empty) => break,
                Err(mpsc::TryRecvError::Disconnected) => {
                    self.connected = false;
                    break;
                }
            }
        }
    }

    fn send_queued_outbound(&mut self) {
        let Some(client) = self.ws.as_mut() else {
            return;
        };

        while self.connected && !self.outbound.is_empty() {
            let Some(frame) = self.outbound.front() else {
                break;
            };
            let payload = match serde_json::to_vec(frame) {
                Ok(bytes) => bytes,
                Err(_) => {
                    self.stats.dropped_outbound = self.stats.dropped_outbound.saturating_add(1);
                    self.outbound.pop_front();
                    continue;
                }
            };

            if client.send(FrameType::Text(false), &payload).is_err() {
                self.connected = false;
                break;
            }

            self.outbound.pop_front();
            self.stats.outbound_frames = self.stats.outbound_frames.saturating_add(1);
        }
    }

    fn connect(&mut self, _attempt: u32) -> bool {
        let url = self.url.trim();
        if url.is_empty() {
            return false;
        }

        // If we already have a live connection, just verify it
        if let Some(client) = self.ws.as_ref() {
            if client.is_connected() {
                self.connected = true;
                return true;
            }
        }

        // Drop the dead socket so we can create a fresh one
        self.ws = None;
        self.connected = false;
        let sender = self.event_sender.clone();

        let callback = move |event| match event {
            Ok(WebSocketEvent { event_type, .. }) => match event_type {
                WebSocketEventType::Connected => {
                    sender.try_send(WsEvent::Connected).ok();
                }
                WebSocketEventType::Disconnected | WebSocketEventType::Closed => {
                    sender.try_send(WsEvent::Disconnected).ok();
                }
                WebSocketEventType::Text(payload) => {
                    sender.try_send(WsEvent::text(payload)).ok();
                }
                _ => {}
            },
            Err(_) => {
                sender.try_send(WsEvent::Disconnected).ok();
            }
        };

        let config = EspWebSocketClientConfig::default();
        let ws = match EspWebSocketClient::new(url, &config, self.timeout, callback) {
            Ok(ws) => ws,
            Err(_) => return false,
        };
        self.connected = ws.is_connected();
        self.ws = Some(ws);
        if !self.connected {
            // keep handle so we can continue to process the async connect path
            // without rebuilding a new socket every loop tick.
        }
        self.connected
    }

    pub fn device_id(&self) -> &str {
        self.source.as_str()
    }

    pub fn source(&self) -> &str {
        self.source.as_str()
    }
}

#[cfg(feature = "esp")]
impl TransportBus for WsTransport {
    fn is_connected(&self) -> bool {
        self.connected && self.ws.is_some()
    }

    fn set_connected(&mut self, connected: bool) {
        self.connected = connected;
        if !connected {
            self.ws = None;
        }
    }

    fn reconnect(&mut self, attempt: u32, _now_ms: u64) -> bool {
        self.connect(attempt)
    }

    fn poll_frames(&mut self) -> Vec<TransportMessage> {
        self.sync_events();
        self.send_queued_outbound();

        let mut out = Vec::with_capacity(self.inbound.len());
        while let Some(frame) = self.inbound.pop_front() {
            self.stats.inbound_frames = self.stats.inbound_frames.saturating_add(1);
            out.push(frame);
        }
        out
    }

    fn send_frame(&mut self, frame: TransportMessage) {
        self.sync_events();
        let mut frame = frame;
        if !self.source.is_empty() {
            frame.envelope.source = self.source.clone();
        }
        self.push_outbound(frame);
        self.send_queued_outbound();
    }

    fn transport_stats(&self) -> TransportStats {
        self.stats
    }
}
