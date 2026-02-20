Adds `abortGroup(groupJid)` support for channel-driven cancellation.

Key invariants:
- Abort clears queued work for the target group.
- Abort requests stop active process via SIGTERM then SIGKILL fallback.
- Aborted runs do not schedule automatic retries.
