import { randomUUID } from 'node:crypto';

import { getAllAgentGroups } from '../db/agent-groups.js';
import { getDb } from '../db/connection.js';
import { getMessagingGroupsByAgentGroup } from '../db/messaging-groups.js';
import { nextEvenSeq } from '../db/session-db.js';
import { createSession, findSessionForAgent } from '../db/sessions.js';
import { TIMEZONE } from '../config.js';
import { log } from '../log.js';
import { inboundDbPath, openInboundDb } from '../session-manager.js';
import type { TribunalSchedule } from '../types.js';
import { createTribunalSession } from './orchestrator.js';

interface SchedulerRun {
  agent_group_id: string;
  cron_expr: string;
  last_run: string;
}

function getLastRun(agentGroupId: string, cronExpr: string): string | null {
  const row = getDb()
    .prepare('SELECT last_run FROM tribunal_scheduler_runs WHERE agent_group_id = ? AND cron_expr = ?')
    .get(agentGroupId, cronExpr) as SchedulerRun | undefined;
  return row?.last_run ?? null;
}

function upsertLastRun(agentGroupId: string, cronExpr: string, lastRun: string): void {
  getDb()
    .prepare(
      `INSERT INTO tribunal_scheduler_runs (agent_group_id, cron_expr, last_run)
       VALUES (?, ?, ?)
       ON CONFLICT (agent_group_id, cron_expr) DO UPDATE SET last_run = excluded.last_run`,
    )
    .run(agentGroupId, cronExpr, lastRun);
}

async function isDue(agentGroupId: string, cronExpr: string, now: Date): Promise<boolean> {
  const { CronExpressionParser } = await import('cron-parser');
  const lastRun = getLastRun(agentGroupId, cronExpr);

  try {
    const interval = CronExpressionParser.parse(cronExpr, { tz: TIMEZONE });
    if (!lastRun) {
      // Never run: fire only if the most recent past tick was within the last sweep window (60s)
      const prev = interval.prev();
      return now.getTime() - prev.getTime() < 65_000;
    }
    const lastRunDate = new Date(lastRun);
    const next = CronExpressionParser.parse(cronExpr, { tz: TIMEZONE, currentDate: lastRunDate }).next();
    return next.getTime() <= now.getTime();
  } catch {
    log.warn('Tribunal scheduler: invalid cron expression', { agentGroupId, cronExpr });
    return false;
  }
}

async function triggerTribunalTask(
  agentGroupId: string,
  messagingGroupId: string,
  task: string,
): Promise<void> {
  const fs = await import('node:fs');
  const { wakeContainer } = await import('../container-runner.js');

  const threadId = `tribunal-sched-${randomUUID()}`;

  createTribunalSession({ agentGroupId, messagingGroupId, threadId, task });

  const ts = new Date().toISOString();
  let session = findSessionForAgent(agentGroupId, messagingGroupId, threadId);
  if (!session) {
    const agentGroup = getAllAgentGroups().find((g) => g.id === agentGroupId);
    session = {
      id: randomUUID(),
      agent_group_id: agentGroupId,
      messaging_group_id: messagingGroupId,
      thread_id: threadId,
      agent_provider: agentGroup?.agent_provider ?? null,
      status: 'active',
      container_status: 'stopped',
      last_active: null,
      created_at: ts,
    };
    createSession(session);
  }

  const inPath = inboundDbPath(agentGroupId, session.id);
  if (!fs.existsSync(inPath)) {
    log.warn('Tribunal scheduler: inbound.db not found, skipping trigger', { agentGroupId, threadId });
    return;
  }

  const inDb = openInboundDb(agentGroupId, session.id);
  try {
    inDb
      .prepare(
        `INSERT INTO messages_in (id, seq, timestamp, status, tries, kind, platform_id, channel_type, thread_id, content)
         VALUES (?, ?, datetime('now'), 'pending', 0, 'task', NULL, 'discord', ?, ?)`,
      )
      .run(randomUUID(), nextEvenSeq(inDb), threadId, JSON.stringify({ text: task }));
  } finally {
    inDb.close();
  }

  await wakeContainer(session);
  log.info('Tribunal scheduler: triggered task', { agentGroupId, threadId, task });
}

export async function runTribunalScheduler(): Promise<void> {
  const now = new Date();
  const allGroups = getAllAgentGroups();

  for (const group of allGroups) {
    if (!group.tribunal_schedules) continue;

    let schedules: TribunalSchedule[];
    try {
      schedules = JSON.parse(group.tribunal_schedules) as TribunalSchedule[];
    } catch {
      log.warn('Tribunal scheduler: invalid tribunal_schedules JSON', { agentGroupId: group.id });
      continue;
    }

    for (const schedule of schedules) {
      if (!(await isDue(group.id, schedule.cron, now))) continue;

      const messagingGroups = getMessagingGroupsByAgentGroup(group.id);
      if (messagingGroups.length === 0) {
        log.warn('Tribunal scheduler: no messaging group wired to agent group', { agentGroupId: group.id });
        continue;
      }

      // Use the first wired Discord channel; skip if none
      const discordGroup = messagingGroups.find((mg) => mg.channel_type === 'discord') ?? messagingGroups[0];

      try {
        await triggerTribunalTask(group.id, discordGroup.id, schedule.task);
        upsertLastRun(group.id, schedule.cron, now.toISOString());
      } catch (err) {
        log.error('Tribunal scheduler: failed to trigger task', { agentGroupId: group.id, cron: schedule.cron, err });
      }
    }
  }
}
