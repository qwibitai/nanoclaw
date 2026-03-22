import { STALL_THRESHOLD_MS } from './config.js';
import { agencyFetch, type AgencyHqTask } from './agency-hq-client.js';
import { createCorrelationLogger } from './logger.js';
import type { SchedulerDependencies } from './task-scheduler.js';

/** Tracks when each task was dispatched (for stall detection). */
export const dispatchTime = new Map<string, number>();

/**
 * Find the CEO group's JID for sending stall notifications.
 */
function findCeoJid(
  deps: SchedulerDependencies,
): { jid: string; folder: string } | null {
  const groups = deps.registeredGroups();
  for (const [jid, group] of Object.entries(groups)) {
    if (group.folder === 'ceo') return { jid, folder: group.folder };
  }
  return null;
}

export async function detectStalledTasks(
  deps: SchedulerDependencies,
  isStopping: () => boolean,
): Promise<void> {
  if (isStopping()) return;

  const log = createCorrelationLogger(undefined, { op: 'stall-detector' });

  let tasks: AgencyHqTask[];
  try {
    const res = await agencyFetch('/tasks?status=in-progress');
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      log.error(
        { status: res.status, body },
        'Failed to fetch in-progress tasks',
      );
      return;
    }
    const json = (await res.json()) as {
      success: boolean;
      data: AgencyHqTask[];
    };
    tasks = json.data ?? [];
  } catch (err) {
    log.error({ err }, 'Failed to fetch in-progress tasks from Agency HQ');
    return;
  }

  const now = Date.now();
  let stalledCount = 0;

  for (const task of tasks) {
    if (isStopping()) return;

    // Check dispatched_at from local tracking or API response
    const dispatched =
      dispatchTime.get(task.id) ??
      (task.dispatched_at ? new Date(task.dispatched_at).getTime() : null);

    if (!dispatched) continue;

    // Check if task has been updated since dispatch
    if (task.updated_at) {
      const updatedAt = new Date(task.updated_at).getTime();
      if (updatedAt > dispatched) continue;
    }

    if (now - dispatched > STALL_THRESHOLD_MS) {
      stalledCount++;
      log.warn(
        { taskId: task.id, dispatchedAt: new Date(dispatched).toISOString() },
        'Task stalled',
      );

      try {
        await agencyFetch('/notifications', {
          method: 'POST',
          body: JSON.stringify({
            type: 'task-stalled',
            title: `Task stalled: ${task.title}`,
            target: 'ceo',
            channel: 'telegram',
            reference_type: 'task',
            reference_id: task.id,
          }),
        });
      } catch (err) {
        log.error(
          { err, taskId: task.id },
          'Failed to POST stall notification',
        );
      }

      // Also notify via message if CEO group exists
      const ceo = findCeoJid(deps);
      if (ceo) {
        try {
          await deps.sendMessage(
            ceo.jid,
            `⚠️ Task stalled (in-progress > ${Math.round(STALL_THRESHOLD_MS / 60_000)}min): ${task.title} (${task.id})`,
          );
        } catch (err) {
          log.error({ err }, 'Failed to send stall message to CEO group');
        }
      }
    }
  }

  if (stalledCount > 0) {
    log.info({ stalledCount }, 'Stall detection complete');
  }
}
