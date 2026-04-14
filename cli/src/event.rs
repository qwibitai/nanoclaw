use crossterm::event::KeyEvent;

use crate::agent::ContainerOutput;

/// All events the application handles, merged into a single channel.
#[derive(Debug)]
#[allow(dead_code)]
pub enum AppEvent {
    /// Terminal key press
    Key(KeyEvent),
    /// Terminal resize
    Resize(u16, u16),
    /// Streaming partial text update from agent
    AgentPartial(String),
    /// Final result from agent
    AgentFinal(ContainerOutput),
    /// Agent process exited
    AgentExited(Option<i32>),
    /// Agent error (spawn failure, parse error)
    AgentError(String),
    /// Periodic tick for UI refresh
    Tick,
    /// Periodic DB poll for new messages from external channels
    DbPoll,
}
