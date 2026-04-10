import { agencyFetch } from './agency-hq-client.js';
import { findCeoJid } from './dispatch-loop.js';
import { createCorrelationLogger, logger } from './logger.js';
import { SchedulerDependencies } from './task-scheduler.js';

export const SPRINT_RETRO_INTERVAL = 5 * 60_000; // 5 minutes

let stopping = false;
let retroIntervalHandle: ReturnType<typeof setInterval> | null = null;

const isStopping = () => stopping;

interface CompletedSprint {
  id: string;
  name: string;
  goal?: string;
  status: string;
  started_at?: string;
  ended_at?: string;
}

interface RetroTask {
  id: string;
  title: string;
  context?: {
    gates?: Record<string, string>;
    result?: { summary?: string };
  };
}

interface RetrospectiveData {
  sprint: CompletedSprint;
  shipped: RetroTask[];
  slipped: RetroTask[];
  never_started: RetroTask[];
  cycle_times: Array<{ task_id: string; cycle_time_hours: number }>;
  meta: {
    total_tasks: number;
    shipped_count: number;
    slipped_count: number;
    never_started_count: number;
    ghost_count: number;
    avg_cycle_time_hours: number | null;
  };
}

async function getProcessedSprintIds(): Promise<Set<string>> {
  try {
    const res = await agencyFetch('/memory/ops?project=retro-processed');
    if (!res.ok) return new Set();
    const json = (await res.json()) as {
      success: boolean;
      data?: { content?: string };
    };
    const content = json.data?.content;
    if (!content) return new Set();
    const ids = JSON.parse(content) as string[];
    return new Set(Array.isArray(ids) ? ids : []);
  } catch {
    return new Set();
  }
}

async function markSprintProcessed(
  sprintId: string,
  existing: Set<string>,
): Promise<void> {
  const ids = [...existing, sprintId];
  try {
    await agencyFetch('/memory/ops', {
      method: 'PUT',
      body: JSON.stringify({
        project: 'retro-processed',
        content: JSON.stringify(ids),
      }),
    });
  } catch (err) {
    logger.warn({ err, sprintId }, 'Failed to mark sprint as retro-processed');
  }
}

async function createRetroMeeting(
  sprint: CompletedSprint,
): Promise<string | null> {
  try {
    const res = await agencyFetch('/meetings', {
      method: 'POST',
      body: JSON.stringify({
        type: 'retro',
        title: `${sprint.name} Retro`,
        sprint_id: sprint.id,
      }),
    });
    if (!res.ok) {
      logger.warn(
        { sprintId: sprint.id, status: res.status },
        'Failed to create retro meeting record',
      );
      return null;
    }
    const json = (await res.json()) as {
      success: boolean;
      data: { id: string };
    };
    return json.data?.id ?? null;
  } catch (err) {
    logger.error(
      { err, sprintId: sprint.id },
      'Error creating retro meeting record',
    );
    return null;
  }
}

async function fetchRetrospective(
  sprintId: string,
): Promise<RetrospectiveData | null> {
  try {
    const res = await agencyFetch(`/sprints/${sprintId}/retrospective`);
    if (!res.ok) {
      logger.warn(
        { sprintId, status: res.status },
        'Failed to fetch sprint retrospective',
      );
      return null;
    }
    const json = (await res.json()) as {
      success: boolean;
      data: RetrospectiveData;
    };
    return json.data ?? null;
  } catch (err) {
    logger.error({ err, sprintId }, 'Error fetching sprint retrospective');
    return null;
  }
}

function formatTaskLine(t: RetroTask): string {
  const summary = t.context?.result?.summary;
  const text = summary ?? t.title;
  const truncated = text.length > 120 ? `${text.slice(0, 117)}...` : text;
  return `• ${truncated}`;
}

function formatRetroMessage(retro: RetrospectiveData): string {
  const { sprint, shipped, slipped, never_started, meta } = retro;

  // Gate failures: tasks whose context.gates has any "FAIL" value
  const gateFailures = shipped.filter((t) => {
    const gates = t.context?.gates ?? {};
    return Object.values(gates).some((v) => v === 'FAIL');
  });

  const lines: string[] = [`*Sprint Complete: ${sprint.name}*`];

  if (sprint.goal) {
    lines.push(`_${sprint.goal}_`);
  }

  lines.push('');
  lines.push(`• Done: ${meta.shipped_count} / ${meta.total_tasks}`);
  lines.push(`• Slipped: ${meta.slipped_count}`);
  if (meta.never_started_count > 0) {
    lines.push(`• Blocked/never started: ${meta.never_started_count}`);
  }
  if (meta.avg_cycle_time_hours != null) {
    lines.push(`• Avg cycle time: ${meta.avg_cycle_time_hours.toFixed(1)}h`);
  }
  if (gateFailures.length > 0) {
    lines.push(
      `• Gate failures: ${gateFailures.map((t) => t.title).join(', ')}`,
    );
  }

  if (shipped.length > 0) {
    lines.push('');
    lines.push('*Shipped:*');
    for (const t of shipped) {
      lines.push(formatTaskLine(t));
    }
  }

  if (slipped.length > 0) {
    lines.push('');
    lines.push('*Slipped:*');
    for (const t of slipped) {
      lines.push(formatTaskLine(t));
    }
  }

  if (never_started.length > 0) {
    lines.push('');
    lines.push('*Blocked/never started:*');
    for (const t of never_started) {
      lines.push(`• ${t.title}`);
    }
  }

  return lines.join('\n');
}

export async function checkForCompletedSprints(
  deps: SchedulerDependencies,
  isStoppingFn: () => boolean,
): Promise<void> {
  if (isStoppingFn()) return;

  const log = createCorrelationLogger(undefined, {
    op: 'sprint-retro-watcher',
  });
  log.trace('Sprint retro watcher poll cycle start');

  const target = findCeoJid(deps);
  if (!target) {
    log.debug('No CEO group registered, skipping sprint retro check');
    return;
  }

  let sprints: CompletedSprint[];
  try {
    const res = await agencyFetch('/sprints?status=completed');
    if (!res.ok) {
      log.warn({ status: res.status }, 'Failed to fetch completed sprints');
      return;
    }
    const json = (await res.json()) as {
      success: boolean;
      data: CompletedSprint[];
    };
    sprints = json.data ?? [];
  } catch (err) {
    log.error({ err }, 'Failed to fetch completed sprints');
    return;
  }

  if (sprints.length === 0) return;

  const processed = await getProcessedSprintIds();
  const newlyCompleted = sprints.filter((s) => !processed.has(s.id));

  if (newlyCompleted.length === 0) {
    log.debug(
      { total: sprints.length },
      'All completed sprints already reported',
    );
    return;
  }

  log.info(
    { count: newlyCompleted.length },
    'Found unprocessed completed sprints, sending retro reports',
  );

  for (const sprint of newlyCompleted) {
    if (isStoppingFn()) return;

    const retro = await fetchRetrospective(sprint.id);
    if (!retro) {
      log.warn({ sprintId: sprint.id }, 'Skipping sprint — retro fetch failed');
      continue;
    }

    const message = formatRetroMessage(retro);

    try {
      await deps.sendMessage(target.jid, message);
      log.info(
        { sprintId: sprint.id, sprintName: sprint.name },
        'Sprint retro report sent to CEO',
      );
    } catch (err) {
      log.error({ err, sprintId: sprint.id }, 'Failed to send retro message');
      continue;
    }

    await markSprintProcessed(sprint.id, processed);
    processed.add(sprint.id);
  }
}

export function startSprintRetroWatcher(deps: SchedulerDependencies): void {
  stopping = false;
  logger.info(
    { intervalMs: SPRINT_RETRO_INTERVAL },
    'Starting sprint retro watcher',
  );

  // Run once immediately, then on interval
  checkForCompletedSprints(deps, isStopping).catch((err) =>
    logger.error({ err }, 'Sprint retro watcher tick failed'),
  );

  retroIntervalHandle = setInterval(() => {
    checkForCompletedSprints(deps, isStopping).catch((err) =>
      logger.error({ err }, 'Sprint retro watcher tick failed'),
    );
  }, SPRINT_RETRO_INTERVAL);
}

export function stopSprintRetroWatcher(): void {
  stopping = true;
  if (retroIntervalHandle) {
    clearInterval(retroIntervalHandle);
    retroIntervalHandle = null;
  }
}
