// Spike-only stub for the v2 container_state watchdog tracking.
//
// Upstream nanoclaw v2 introduced a two-DB session model where the
// agent-runner records "which tool is currently in-flight" so the host
// watchdog UI can show progress + kill stuck tools. Talon doesn't have
// that UI surface (we're a headless HTTP service driven by CoPilot)
// and our existing logging already captures tool start/end events.
//
// During the provider-abstraction spike, claude.ts imports these
// functions from `../db/connection.js`. Rather than pull in the full
// v2 DB schema, we stub them as no-ops. If we ever add a Talon-side
// equivalent (e.g. exposing tool state via /status endpoint for
// CoPilot to poll), wire real logic in here.

export function setContainerToolInFlight(_toolName: string, _declaredTimeoutMs: number | null): void {
  // intentional no-op for the spike
}

export function clearContainerToolInFlight(): void {
  // intentional no-op for the spike
}
