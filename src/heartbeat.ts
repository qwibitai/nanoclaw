import { CronExpressionParser } from 'cron-parser';
import fs from 'fs';
import path from 'path';

import { createTask, deleteTask, getTasksForGroup, updateTask } from './db.js';
import { TIMEZONE } from './config.js';
import { resolveGroupFolderPath } from './group-folder.js';
import {
  buildScheduledLearningPrompt,
  resolveLearningTaskContext,
  validateGroupLearningContent,
} from './learning-content.js';
import { logger } from './logger.js';
import { RegisteredGroup, ScheduledTask } from './types.js';

const MANAGED_HEARTBEAT_TASK_TYPES = [
  'lesson',
  'currentaffairs',
  'quiz',
  'weeklyreport',
] as const;

type HeartbeatTaskType = (typeof MANAGED_HEARTBEAT_TASK_TYPES)[number];

interface HeartbeatPathOptions {
  groupDir?: string;
  projectRoot?: string;
}

interface ParsedCadenceEntry {
  kind: HeartbeatTaskType;
  rawValue: string;
  scheduleType: 'cron';
  scheduleValue: string;
  description: string;
}

interface DesiredTask {
  id: string;
  prompt: string;
  schedule_type: 'cron';
  schedule_value: string;
  description: string;
}

export interface HeartbeatSyncResult {
  status: 'scheduled' | 'blocked' | 'noop';
  reason: string;
  createdTaskIds: string[];
  updatedTaskIds: string[];
  deletedTaskIds: string[];
  validationIssueCount: number;
}

function resolveHeartbeatGroupDir(
  groupFolder: string,
  options?: HeartbeatPathOptions,
): string {
  return options?.groupDir || resolveGroupFolderPath(groupFolder);
}

function readTextFile(filePath: string): string {
  if (!fs.existsSync(filePath)) return '';
  return fs.readFileSync(filePath, 'utf-8');
}

function isOnboardingActive(groupDir: string): boolean {
  const whoIAmPath = path.join(groupDir, 'WHO_I_AM.md');
  const whoIAm = readTextFile(whoIAmPath);
  return whoIAm.includes('Onboarding status: active');
}

function getHeartbeatTimezone(heartbeat: string): string | null {
  const match = heartbeat.match(/^Timezone:\s*(.+)$/m);
  return match?.[1]?.trim() || null;
}

function getSectionBody(content: string, heading: string): string {
  const escapedHeading = heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const regex = new RegExp(
    `^${escapedHeading}\\s*$([\\s\\S]*?)(?=^##\\s+|\\Z)`,
    'm',
  );
  const match = content.match(regex);
  return match?.[1]?.trim() || '';
}

function replaceSection(
  content: string,
  heading: string,
  lines: string[],
): string {
  const escapedHeading = heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const section = `${heading}\n${lines.join('\n')}`;
  const regex = new RegExp(
    `^${escapedHeading}\\s*$[\\s\\S]*?(?=^##\\s+|\\Z)`,
    'm',
  );

  if (regex.test(content)) {
    return content.replace(regex, section);
  }

  const suffix = content.endsWith('\n') ? '' : '\n';
  return `${content}${suffix}\n${section}\n`;
}

function normalizeCadenceKey(rawKey: string): HeartbeatTaskType | undefined {
  const normalized = rawKey.toLowerCase().replace(/[^a-z]/g, '');
  if (MANAGED_HEARTBEAT_TASK_TYPES.includes(normalized as HeartbeatTaskType)) {
    return normalized as HeartbeatTaskType;
  }
  return undefined;
}

function parseTimeValue(rawValue: string): ParsedCadenceEntry | null {
  const daily = rawValue.match(/^(\d{1,2}):(\d{2})$/);
  if (daily) {
    const hour = Number(daily[1]);
    const minute = Number(daily[2]);
    if (hour <= 23 && minute <= 59) {
      return {
        kind: 'lesson',
        rawValue,
        scheduleType: 'cron',
        scheduleValue: `${minute} ${hour} * * *`,
        description: `daily at ${daily[1].padStart(2, '0')}:${daily[2]}`,
      };
    }
  }

  const weekly = rawValue.match(
    /^(Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday)\s+(\d{1,2}):(\d{2})$/i,
  );
  if (weekly) {
    const dayName = weekly[1].toLowerCase();
    const dayMap: Record<string, number> = {
      sunday: 0,
      monday: 1,
      tuesday: 2,
      wednesday: 3,
      thursday: 4,
      friday: 5,
      saturday: 6,
    };
    const hour = Number(weekly[2]);
    const minute = Number(weekly[3]);
    if (hour <= 23 && minute <= 59) {
      return {
        kind: 'lesson',
        rawValue,
        scheduleType: 'cron',
        scheduleValue: `${minute} ${hour} * * ${dayMap[dayName]}`,
        description: `weekly on ${weekly[1]} at ${weekly[2].padStart(2, '0')}:${weekly[3]}`,
      };
    }
  }

  return null;
}

function parseCadenceEntries(heartbeat: string): ParsedCadenceEntry[] {
  const body = getSectionBody(heartbeat, '## Proposed Cadence');
  if (!body) return [];

  const lines = body
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('- '));

  const entries: ParsedCadenceEntry[] = [];
  for (const line of lines) {
    const match = line.match(/^-\s*([^:]+):\s*(.+)$/);
    if (!match) continue;

    const kind = normalizeCadenceKey(match[1]);
    const rawValue = match[2].trim();
    if (!kind || rawValue.toLowerCase() === 'pending') continue;

    const parsed = parseTimeValue(rawValue);
    if (!parsed) continue;

    entries.push({
      kind,
      rawValue,
      scheduleType: parsed.scheduleType,
      scheduleValue: parsed.scheduleValue,
      description: parsed.description,
    });
  }

  return entries;
}

function getHeartbeatTaskId(
  groupFolder: string,
  kind: HeartbeatTaskType,
): string {
  return `heartbeat-${groupFolder}-${kind}`;
}

function buildDesiredTasks(
  group: RegisteredGroup,
  chatJid: string,
  entries: ParsedCadenceEntry[],
  options?: HeartbeatPathOptions,
): Map<string, DesiredTask> {
  const groupDir = resolveHeartbeatGroupDir(group.folder, options);
  const learningContext = resolveLearningTaskContext(groupDir, {
    projectRoot: options?.projectRoot,
  });

  return new Map(
    entries.map((entry) => {
      const id = getHeartbeatTaskId(group.folder, entry.kind);
      return [
        id,
        {
          id,
          prompt: buildScheduledLearningPrompt(entry.kind, learningContext),
          schedule_type: entry.scheduleType,
          schedule_value: entry.scheduleValue,
          description: entry.description,
        },
      ];
    }),
  );
}

function computeNextRun(scheduleValue: string): string {
  const nextRun = CronExpressionParser.parse(scheduleValue, {
    tz: TIMEZONE,
  })
    .next()
    .toISOString();
  if (!nextRun) {
    throw new Error(
      `Unable to compute next run for schedule: ${scheduleValue}`,
    );
  }
  return nextRun;
}

function buildAutomationLines(
  desiredTasks: Map<string, DesiredTask>,
  validationIssueCount: number,
  reason?: string,
): string[] {
  const lines: string[] = [];

  if (validationIssueCount > 0) {
    lines.push(
      `- Validation warning: skipped ${validationIssueCount} malformed local content artifact(s) during content resolution`,
    );
  }

  if (desiredTasks.size === 0) {
    lines.push(reason ? `- ${reason}` : '- None scheduled yet');
    return lines;
  }

  return lines.concat(
    [...desiredTasks.values()]
      .sort((left, right) => left.id.localeCompare(right.id))
      .map(
        (task) =>
          `- ${task.id.replace(/^heartbeat-[^-]+-/, '')}: ${task.description} (task: ${task.id})`,
      ),
  );
}

function writeHeartbeatAutomations(
  heartbeatPath: string,
  heartbeat: string,
  lines: string[],
): void {
  const updated = replaceSection(heartbeat, '## Active Automations', lines);
  if (updated !== heartbeat) {
    fs.writeFileSync(heartbeatPath, updated);
  }
}

export function syncHeartbeatTasksForChat(
  chatJid: string,
  group: RegisteredGroup,
  options?: HeartbeatPathOptions,
): HeartbeatSyncResult {
  if (group.isMain) {
    return {
      status: 'noop',
      reason: 'Main group does not use learner heartbeat scheduling',
      createdTaskIds: [],
      updatedTaskIds: [],
      deletedTaskIds: [],
      validationIssueCount: 0,
    };
  }

  const groupDir = resolveHeartbeatGroupDir(group.folder, options);
  const heartbeatPath = path.join(groupDir, 'HEARTBEAT.md');
  const heartbeat = readTextFile(heartbeatPath);
  if (!heartbeat) {
    return {
      status: 'noop',
      reason: 'No HEARTBEAT.md present',
      createdTaskIds: [],
      updatedTaskIds: [],
      deletedTaskIds: [],
      validationIssueCount: 0,
    };
  }

  const existingManagedTasks = new Map(
    getTasksForGroup(group.folder)
      .filter((task) => task.id.startsWith(`heartbeat-${group.folder}-`))
      .map((task) => [task.id, task] satisfies [string, ScheduledTask]),
  );

  const deleteUnwantedTasks = (reason: string): HeartbeatSyncResult => {
    const deletedTaskIds = [...existingManagedTasks.keys()];
    for (const taskId of deletedTaskIds) {
      deleteTask(taskId);
    }
    writeHeartbeatAutomations(heartbeatPath, heartbeat, [
      `- ${reason}`,
      '- None scheduled yet',
    ]);
    return {
      status: 'blocked',
      reason,
      createdTaskIds: [],
      updatedTaskIds: [],
      deletedTaskIds,
      validationIssueCount: 0,
    };
  };

  if (!isOnboardingActive(groupDir)) {
    return deleteUnwantedTasks(
      'Scheduling blocked: onboarding is still pending',
    );
  }

  const heartbeatTimezone = getHeartbeatTimezone(heartbeat);
  if (!heartbeatTimezone) {
    return deleteUnwantedTasks(
      'Scheduling blocked: HEARTBEAT.md has no explicit timezone',
    );
  }

  if (heartbeatTimezone !== TIMEZONE) {
    return deleteUnwantedTasks(
      `Scheduling blocked: heartbeat timezone ${heartbeatTimezone} does not match runtime timezone ${TIMEZONE}`,
    );
  }

  const cadenceEntries = parseCadenceEntries(heartbeat);
  const validationIssues = validateGroupLearningContent(groupDir);
  if (validationIssues.length > 0) {
    logger.warn(
      {
        groupFolder: group.folder,
        issueCount: validationIssues.length,
        issues: validationIssues.map((issue) => ({
          filePath: issue.filePath,
          kind: issue.kind,
          reason: issue.reason,
        })),
      },
      'Detected malformed group-local learning content; falling back to valid assets',
    );
  }
  const desiredTasks = buildDesiredTasks(
    group,
    chatJid,
    cadenceEntries,
    options,
  );

  const createdTaskIds: string[] = [];
  const updatedTaskIds: string[] = [];
  const deletedTaskIds: string[] = [];

  for (const [taskId, task] of existingManagedTasks.entries()) {
    if (!desiredTasks.has(taskId)) {
      deleteTask(taskId);
      deletedTaskIds.push(taskId);
    }
  }

  for (const [taskId, desiredTask] of desiredTasks.entries()) {
    const existing = existingManagedTasks.get(taskId);
    const nextRun = computeNextRun(desiredTask.schedule_value);

    if (!existing) {
      createTask({
        id: taskId,
        group_folder: group.folder,
        chat_jid: chatJid,
        prompt: desiredTask.prompt,
        script: null,
        schedule_type: desiredTask.schedule_type,
        schedule_value: desiredTask.schedule_value,
        context_mode: 'group',
        next_run: nextRun,
        status: 'active',
        created_at: new Date().toISOString(),
      });
      createdTaskIds.push(taskId);
      continue;
    }

    const needsUpdate =
      existing.prompt !== desiredTask.prompt ||
      existing.schedule_type !== desiredTask.schedule_type ||
      existing.schedule_value !== desiredTask.schedule_value ||
      existing.status !== 'active' ||
      existing.next_run == null;

    if (needsUpdate) {
      updateTask(taskId, {
        prompt: desiredTask.prompt,
        schedule_type: desiredTask.schedule_type,
        schedule_value: desiredTask.schedule_value,
        next_run: nextRun,
        status: 'active',
      });
      updatedTaskIds.push(taskId);
    }
  }

  writeHeartbeatAutomations(
    heartbeatPath,
    heartbeat,
    buildAutomationLines(
      desiredTasks,
      validationIssues.length,
      desiredTasks.size === 0
        ? 'No valid heartbeat cadence found for managed tasks'
        : undefined,
    ),
  );

  logger.info(
    {
      groupFolder: group.folder,
      createdTaskIds,
      updatedTaskIds,
      deletedTaskIds,
    },
    'Heartbeat tasks synchronized',
  );

  return {
    status: desiredTasks.size > 0 ? 'scheduled' : 'noop',
    reason:
      desiredTasks.size > 0
        ? 'Heartbeat tasks synchronized'
        : 'No valid heartbeat cadence found for managed tasks',
    createdTaskIds,
    updatedTaskIds,
    deletedTaskIds,
    validationIssueCount: validationIssues.length,
  };
}
