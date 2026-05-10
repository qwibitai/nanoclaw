/**
 * Orchestrator self-spawn module.
 *
 * Registers 5 delivery actions for the spawn pipeline:
 *   - spawn_task      (orchestrator → host: admit new task)
 *   - spawn_complete  (child → host: task done)
 *   - spawn_failed    (child → host: task failed)
 *   - spawn_cancel    (orchestrator → host: cancel a running task)
 *   - spawn_progress  (child → host: heartbeat update)
 *
 * Spawned children always run in the SAME agent group as the parent — they share
 * workspace, memory, CLAUDE.md, channels. Only the session/thread is isolated.
 */
import { registerDeliveryAction } from '../../delivery.js';
import { applySpawnTask } from './dispatch.js';
import { applySpawnComplete, applySpawnFailed } from './completion.js';
import { applySpawnProgress } from './progress.js';
import { applySpawnCancel } from './cancellation.js';

// NOTE: registerDeliveryAction is side-effect-only and safe at module-import time
// (it just adds to an in-memory map). The reconciler startup scan, however, queries
// the central DB and MUST run AFTER initDb() + runMigrations() in main(). Re-export
// the startup hook so src/index.ts can call it at the right moment instead of
// running it here at module-import time (which would crash because the DB isn't ready).
registerDeliveryAction('spawn_task', applySpawnTask);
registerDeliveryAction('spawn_complete', applySpawnComplete);
registerDeliveryAction('spawn_failed', applySpawnFailed);
registerDeliveryAction('spawn_cancel', applySpawnCancel);
registerDeliveryAction('spawn_progress', applySpawnProgress);

export { runReconcilerOnStartup } from './reconciler.js';
