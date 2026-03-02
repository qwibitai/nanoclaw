# Intent: src/health-monitor.ts modifications

## What changed
Replaced Docker-specific health check with engine-level health check. The monitor now delegates to the engine to determine infrastructure health.

## Key sections

### HealthMonitorDeps interface
- Added: `engineHealthCheck: () => Promise<'ok' | 'error'>`
- The existing `getActiveContainers` field name is kept (conceptually "active agents" regardless of engine)

### Docker health check → Engine health check
- Removed: `checkDockerHealth()` function (which ran `execSync('docker info')`)
- Replaced with: `deps.engineHealthCheck()` call
- ClaudeEngine's `healthCheck()` still runs the Docker/Apple Container check internally
- CodexEngine's `healthCheck()` checks API key configuration

### Alert messages
- Changed: "Docker 服务不可用" → "AI 引擎不可用" (or similar engine-generic wording)
- Changed: "Docker 服务已恢复正常" → "AI 引擎已恢复正常"
- Changed: repair instructions from Docker-specific to generic ("请检查引擎配置")
- The `triggerMainAgentDiagnose` call text should also be engine-generic

### Agent stale check
- Unchanged. The `getActiveContainers()` dep still returns a Map of active agent info. For Codex, the caller populates this Map based on active Codex threads (containerName will be something like `codex-{group}-{timestamp}`).
- The `idleWaiting` field still controls whether to suppress alerts

## Invariants
- Agent stale detection logic is unchanged
- Alert cooldown mechanism is unchanged
- The `notifyAgentOutput` / `notifyAgentBusy` callbacks are unchanged
- Timer intervals (`HEALTH_CHECK_INTERVAL_MS`, `DOCKER_CHECK_INTERVAL_MS`) are unchanged
- `DockerHealthState` renamed to `EngineHealthState` (optional, cosmetic)

## Must-keep
- The `ALERT_COOLDOWN_MS` constant
- The consecutive failure threshold before alerting
- The `AgentSessionState` tracking per group
- The `sendAlert` helper function
- Both interval timers (engine check + agent stale check)
- The `stop()` cleanup function
