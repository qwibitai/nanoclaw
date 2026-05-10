import { log } from '../../log.js';
import { getOrphanedTasks } from './db/tasks.js';
import { completeDispatchSideEffects } from './dispatch.js';

export function runReconcilerSweep(): void {
  const orphans = getOrphanedTasks();
  if (orphans.length === 0) return;

  log.info('Reconciler: scheduling side-effects for orphaned tasks', { count: orphans.length });
  for (const task of orphans) {
    // Lease + completionInFlight in completeDispatchSideEffects dedupes against
    // any in-flight setImmediate from the original admit.
    setImmediate(completeDispatchSideEffects, task.task_id);
  }
}

let startupRan = false;

export function runReconcilerOnStartup(): void {
  if (startupRan) return;
  startupRan = true;
  log.info('Reconciler: running startup scan for orphaned tasks');
  runReconcilerSweep();
}
