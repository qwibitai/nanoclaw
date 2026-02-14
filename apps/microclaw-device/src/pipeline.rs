use std::collections::VecDeque;

use microclaw_protocol::TouchEventPayload;

use crate::display::{clamp_and_validate_touch, DisplayPoint};
use crate::drivers::TouchDriver;

pub const TOUCH_QUEUE_CAPACITY: usize = 32;
pub const TOUCH_EVENT_STALE_MS: u64 = 2_000;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TouchEventFrame {
    pub point: DisplayPoint,
    pub phase: microclaw_protocol::TouchPhase,
}

pub struct TouchPipeline {
    queue: VecDeque<TouchEventPayload>,
    dropped: u64,
}

impl TouchPipeline {
    pub fn new() -> Self {
        Self {
            queue: VecDeque::with_capacity(TOUCH_QUEUE_CAPACITY),
            dropped: 0,
        }
    }

    pub fn queue_depth(&self) -> usize {
        self.queue.len()
    }

    pub fn dropped_count(&self) -> u64 {
        self.dropped
    }

    pub fn push_event(&mut self, raw: TouchEventPayload) {
        if self.queue.len() >= TOUCH_QUEUE_CAPACITY {
            self.queue.pop_front();
            self.dropped = self.dropped.saturating_add(1);
        }

        self.queue.push_back(raw);
    }

    pub fn pop_event(&mut self) -> Option<TouchEventPayload> {
        self.queue.pop_front()
    }

    pub fn drain_from_driver<D: TouchDriver + ?Sized>(&mut self, driver: &mut D) -> usize {
        let mut drained = 0usize;

        if !driver.is_interrupt_pending() && self.queue.is_empty() {
            return drained;
        }

        while let Some(event) = driver.read_event() {
            self.push_event(event);
            drained = drained.saturating_add(1);
        }
        driver.clear_interrupt();
        drained
    }

    pub fn next_frame(&mut self) -> Option<TouchEventFrame> {
        while let Some(event) = self.pop_event() {
            if let Some(point) = clamp_and_validate_touch(event.x, event.y) {
                return Some(TouchEventFrame {
                    point,
                    phase: event.phase,
                });
            }
        }
        None
    }

    pub fn purge_stale(&mut self, now_ms: u64, stale_ms: u64, last_seen_ms: &mut Option<u64>) {
        if let Some(last) = *last_seen_ms {
            if now_ms.saturating_sub(last) > stale_ms {
                self.queue.clear();
                *last_seen_ms = None;
            }
        }
    }
}
