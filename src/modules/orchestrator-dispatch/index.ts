/**
 * Orchestrator dispatch module.
 *
 * Registers 5 delivery actions for the dispatch pipeline:
 *   - dispatch_task      (orchestrator → host: admit new task)
 *   - dispatch_complete  (child → host: task done)
 *   - dispatch_failed    (child → host: task failed)
 *   - dispatch_cancel    (orchestrator → host: cancel a running task)
 *   - dispatch_progress  (child → host: heartbeat update)
 *
 * No action named cancel_task is registered here — that name belongs to the
 * scheduling module (src/modules/scheduling/index.ts:31). All dispatch actions
 * use the dispatch_ prefix to avoid collisions.
 */
import { registerDeliveryAction } from '../../delivery.js';
import { applyDispatchTask } from './dispatch.js';
import { applyDispatchComplete, applyDispatchFailed } from './completion.js';
import { applyDispatchProgress } from './progress.js';
import { applyDispatchCancel } from './cancellation.js';

// NOTE: registerDeliveryAction is side-effect-only and safe at module-import time
// (it just adds to an in-memory map). The reconciler startup scan, however, queries
// the central DB and MUST run AFTER initDb() + runMigrations() in main(). Re-export
// the startup hook so src/index.ts can call it at the right moment instead of
// running it here at module-import time (which would crash because the DB isn't ready).
registerDeliveryAction('dispatch_task', applyDispatchTask);
registerDeliveryAction('dispatch_complete', applyDispatchComplete);
registerDeliveryAction('dispatch_failed', applyDispatchFailed);
registerDeliveryAction('dispatch_cancel', applyDispatchCancel);
registerDeliveryAction('dispatch_progress', applyDispatchProgress);

export { runReconcilerOnStartup } from './reconciler.js';
