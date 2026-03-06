import {
  completeWorkerRun,
  getWorkerRuns,
  updateWorkerRunLifecycle,
  WorkerRunPhase,
  WorkerRunRecord,
} from './db.js';
import { hasRunningContainerWithPrefix } from './container-runtime.js';
import { logger } from './logger.js';

export interface WorkerRunSupervisorConfig {
  hardTimeoutMs: number;
  queuedCursorGraceMs: number;
  leaseTtlMs: number;
  processStartAtMs: number;
  restartSuppressionWindowMs: number;
  ownerId: string;
}

export interface ReconcileInput {
  lastAgentTimestamp: Record<string, string>;
  resolveChatJid: (groupFolder: string) => string | undefined;
}

function toMs(value: string | null | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function nowIso(): string {
  return new Date().toISOString();
}

function phaseForRun(run: WorkerRunRecord): WorkerRunPhase {
  const raw = `${run.phase ?? ''}`.trim();
  if (raw.length === 0) return run.status === 'queued' ? 'queued' : 'active';
  return raw as WorkerRunPhase;
}


export class WorkerRunSupervisor {
  constructor(private readonly config: WorkerRunSupervisorConfig) {}

  private leaseExpiryIso(nowMs: number): string {
    return new Date(nowMs + this.config.leaseTtlMs).toISOString();
  }

  private shouldSuppressQueuedCursorFailure(startedMs: number, nowMs: number): boolean {
    const windowMs = Math.max(0, this.config.restartSuppressionWindowMs);
    if (windowMs === 0) return false;

    // Suppress stale cursor failures only during the startup grace window,
    // and only for runs created close to process startup time.
    if (nowMs > (this.config.processStartAtMs + windowMs)) return false;
    return startedMs >= (this.config.processStartAtMs - windowMs);
  }

  markQueued(runId: string): void {
    const nowMs = Date.now();
    updateWorkerRunLifecycle(runId, {
      phase: 'queued',
      last_heartbeat_at: new Date(nowMs).toISOString(),
      spawn_acknowledged_at: null,
      active_container_name: null,
      no_container_since: null,
      expects_followup_container: false,
      supervisor_owner: this.config.ownerId,
      lease_expires_at: this.leaseExpiryIso(nowMs),
      recovered_from_reason: null,
    });
  }

  markSpawnStarted(runId: string, containerName: string, phase: WorkerRunPhase): void {
    const nowMs = Date.now();
    updateWorkerRunLifecycle(runId, {
      phase,
      last_heartbeat_at: new Date(nowMs).toISOString(),
      spawn_acknowledged_at: new Date(nowMs).toISOString(),
      active_container_name: containerName,
      no_container_since: null,
      expects_followup_container: phase === 'completion_repair_active',
      supervisor_owner: this.config.ownerId,
      lease_expires_at: this.leaseExpiryIso(nowMs),
    });
  }

  markHeartbeat(runId: string): void {
    const nowMs = Date.now();
    updateWorkerRunLifecycle(runId, {
      last_heartbeat_at: new Date(nowMs).toISOString(),
      supervisor_owner: this.config.ownerId,
      lease_expires_at: this.leaseExpiryIso(nowMs),
    });
  }

  markContainerExited(runId: string, phaseAfter: WorkerRunPhase): void {
    const now = nowIso();
    updateWorkerRunLifecycle(runId, {
      phase: phaseAfter,
      active_container_name: null,
      no_container_since: now,
      supervisor_owner: this.config.ownerId,
    });
  }

  markRepairPending(runId: string): void {
    const now = nowIso();
    updateWorkerRunLifecycle(runId, {
      phase: 'completion_repair_pending',
      active_container_name: null,
      no_container_since: now,
      expects_followup_container: true,
      supervisor_owner: this.config.ownerId,
    });
  }

  markFinalizing(runId: string): void {
    updateWorkerRunLifecycle(runId, {
      phase: 'finalizing',
      active_container_name: null,
      no_container_since: null,
      expects_followup_container: false,
      supervisor_owner: this.config.ownerId,
    });
  }

  markTerminal(runId: string): void {
    updateWorkerRunLifecycle(runId, {
      phase: 'terminal',
      active_container_name: null,
      no_container_since: null,
      expects_followup_container: false,
      lease_expires_at: null,
      supervisor_owner: this.config.ownerId,
    });
  }

  reconcile(input: ReconcileInput): boolean {
    const nowMs = Date.now();
    let changed = false;
    const activeRuns = getWorkerRuns({
      groupFolderLike: 'jarvis-worker-%',
      statuses: ['running', 'queued'],
      limit: 200,
    });

    for (const run of activeRuns) {
      const startedMs = toMs(run.started_at);
      if (startedMs === null) continue;
      const ageMs = nowMs - startedMs;

      if (run.completed_at) {
        completeWorkerRun(
          run.run_id,
          'failed',
          'Auto-reconciled inconsistent worker run state',
          JSON.stringify({
            reason: 'active_status_with_completed_at',
            status: run.status,
            phase: run.phase,
            started_at: run.started_at,
            completed_at: run.completed_at,
          }),
        );
        changed = true;
        continue;
      }

      if (run.status === 'queued') {
        const chatJid = input.resolveChatJid(run.group_folder);
        const cursor = chatJid ? input.lastAgentTimestamp[chatJid] : undefined;
        const startupSuppression = this.shouldSuppressQueuedCursorFailure(startedMs, nowMs);
        const spawnAcknowledged = !!toMs(run.spawn_acknowledged_at);
        if (
          cursor
          && run.started_at <= cursor
          && ageMs >= this.config.queuedCursorGraceMs
          && !startupSuppression
          && !spawnAcknowledged
        ) {
          completeWorkerRun(
            run.run_id,
            'failed',
            'Auto-failed queued worker run before spawn (cursor past dispatch)',
            JSON.stringify({
              reason: 'queued_stale_before_spawn',
              status: run.status,
              phase: run.phase,
              started_at: run.started_at,
              cursor,
              stale_ms: ageMs,
              queued_cursor_grace_ms: this.config.queuedCursorGraceMs,
            }),
          );
          changed = true;
          continue;
        }

        if (ageMs > this.config.hardTimeoutMs) {
          completeWorkerRun(
            run.run_id,
            'failed',
            'Auto-failed stale queued worker run watchdog timeout',
            JSON.stringify({
              reason: 'stale_worker_run_watchdog',
              status: run.status,
              phase: run.phase,
              started_at: run.started_at,
              stale_ms: ageMs,
            }),
          );
          changed = true;
        }
        continue;
      }

      const phase = phaseForRun(run);
      const prefix = `nanoclaw-${run.group_folder}-`;
      const hasRunningContainer = hasRunningContainerWithPrefix(prefix);

      if (hasRunningContainer) {
        if (run.no_container_since || !run.active_container_name) {
          updateWorkerRunLifecycle(run.run_id, {
            no_container_since: null,
            active_container_name: `prefix:${prefix}`,
            supervisor_owner: this.config.ownerId,
            phase: phase === 'completion_repair_pending' ? 'completion_repair_active' : phase,
          });
          changed = true;
        }
      }

      if (ageMs > this.config.hardTimeoutMs) {
        completeWorkerRun(
          run.run_id,
          'failed',
          'Auto-failed stale worker run watchdog timeout',
          JSON.stringify({
            reason: 'stale_worker_run_watchdog',
            status: run.status,
            phase,
            started_at: run.started_at,
            stale_ms: ageMs,
          }),
        );
        logger.warn(
          { runId: run.run_id, status: run.status, phase, startedAt: run.started_at },
          'Auto-failed stale worker run',
        );
        changed = true;
      }
    }

    return changed;
  }
}
