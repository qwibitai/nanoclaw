import { log } from '../../log.js';
import { getOrphanedTasks } from './db/tasks.js';
import { completeSpawnSideEffects } from './dispatch.js';

export function runReconcilerSweep(): void {
  const orphans = getOrphanedTasks();
  if (orphans.length === 0) return;

  log.info('Reconciler: scheduling side-effects for orphaned tasks', { count: orphans.length });
  for (const task of orphans) {
    // Lease + completionInFlight in completeSpawnSideEffects dedupes against
    // any in-flight setImmediate from the original admit. Self-orchestration:
    // child agent group is always the parent's agent group.
    setImmediate(completeSpawnSideEffects, task.task_id, task.parent_agent_group_id);
  }
}

let startupRan = false;

export function runReconcilerOnStartup(): void {
  if (startupRan) return;
  startupRan = true;
  log.info('Reconciler: running startup scan for orphaned tasks');
  runReconcilerSweep();
}
