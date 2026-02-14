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

pub const SWIPE_MIN_HORIZONTAL_PX: i32 = 40;
pub const SWIPE_MAX_VERTICAL_PX: i32 = 30;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SwipeDirection {
    Left,
    Right,
}

pub struct SwipeDetector {
    down_x: Option<u16>,
    down_y: Option<u16>,
}

impl SwipeDetector {
    pub fn new() -> Self {
        Self { down_x: None, down_y: None }
    }

    pub fn on_down(&mut self, x: u16, y: u16) -> Option<SwipeDirection> {
        self.down_x = Some(x);
        self.down_y = Some(y);
        None
    }

    pub fn on_move(&mut self, _x: u16, _y: u16) -> Option<SwipeDirection> {
        None
    }

    pub fn on_up(&mut self, x: u16, y: u16) -> Option<SwipeDirection> {
        let (dx, dy) = match (self.down_x.take(), self.down_y.take()) {
            (Some(sx), Some(sy)) => (
                x as i32 - sx as i32,
                y as i32 - sy as i32,
            ),
            _ => return None,
        };

        if dx.abs() >= SWIPE_MIN_HORIZONTAL_PX && dy.abs() <= SWIPE_MAX_VERTICAL_PX {
            if dx > 0 { Some(SwipeDirection::Right) } else { Some(SwipeDirection::Left) }
        } else {
            None
        }
    }

    pub fn cancel(&mut self) {
        self.down_x = None;
        self.down_y = None;
    }
}
