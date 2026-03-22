/**
 * Atlas Telegram command handler.
 * Intercepts /command messages from the main group and handles them
 * mechanically (no LLM, no container) for instant responses.
 *
 * Commands: /pause, /resume, /status, /approve, /reject, /quota
 */

import fs from 'fs';
import path from 'path';

import { ATLAS_STATE_DIR } from './config.js';
import { getAllTasks, getTaskById, updateTask } from './db.js';
import { logger } from './logger.js';

// Atlas state paths (host-level)
const GRADUATION_STATUS_PATH = path.join(
  ATLAS_STATE_DIR,
  'autonomy',
  'graduation-status.json',
);
const QUOTA_TRACKING_PATH = path.join(
  ATLAS_STATE_DIR,
  'autonomy',
  'quota-tracking.jsonl',
);
const MODE_PATH = path.join(ATLAS_STATE_DIR, 'state', 'mode.json');
const APPROVAL_PENDING_DIR = path.join(
  ATLAS_STATE_DIR,
  'approval-queue',
  'pending',
);
const APPROVAL_APPROVED_DIR = path.join(
  ATLAS_STATE_DIR,
  'approval-queue',
  'approved',
);
const APPROVAL_REJECTED_DIR = path.join(
  ATLAS_STATE_DIR,
  'approval-queue',
  'rejected',
);

// Model weights for quota display (mirrors governance/quota.ts)
const MODEL_WEIGHTS: Record<string, number> = {
  haiku: 0.1,
  sonnet: 1.0,
  opus: 5.0,
};

interface CommandResult {
  handled: boolean;
  response?: string;
}

/**
 * Try to handle a message as a command.
 * Returns { handled: true, response } if it was a command, { handled: false } otherwise.
 * Only processes commands from main group.
 */
export function handleCommand(text: string): CommandResult {
  const trimmed = text.trim();
  if (!trimmed.startsWith('/')) return { handled: false };

  const parts = trimmed.split(/\s+/);
  const cmd = parts[0].toLowerCase();
  const args = parts.slice(1);

  switch (cmd) {
    case '/pause':
      return { handled: true, response: handlePause(args) };
    case '/resume':
      return { handled: true, response: handleResume(args) };
    case '/status':
      return { handled: true, response: handleStatus() };
    case '/approve':
      return { handled: true, response: handleApprove(args) };
    case '/reject':
      return { handled: true, response: handleReject(args) };
    case '/quota':
      return { handled: true, response: handleQuota() };
    case '/reset-mode':
      return { handled: true, response: handleResetMode() };
    default:
      return { handled: false };
  }
}

// --- Command handlers ---

function handlePause(args: string[]): string {
  if (args.length > 0) {
    // Pause specific task
    const taskId = args[0];
    const task = getTaskById(taskId);
    if (!task) return `Task not found: ${taskId}`;
    if (task.status === 'paused') return `Task already paused: ${taskId}`;
    if (task.status !== 'active')
      return `Task is ${task.status}, cannot pause: ${taskId}`;

    updateTask(taskId, { status: 'paused' });
    logger.info({ taskId }, 'Task paused via command');
    return `Paused task: ${taskId}\n${task.prompt.slice(0, 80)}...`;
  }

  // Pause all active tasks
  const tasks = getAllTasks().filter((t) => t.status === 'active');
  if (tasks.length === 0) return 'No active tasks to pause.';

  let count = 0;
  for (const task of tasks) {
    updateTask(task.id, { status: 'paused' });
    count++;
  }
  logger.info({ count }, 'All tasks paused via command');
  return `Paused ${count} active task${count === 1 ? '' : 's'}.\nUse /resume to reactivate.`;
}

function handleResume(args: string[]): string {
  if (args.length > 0) {
    // Resume specific task
    const taskId = args[0];
    const task = getTaskById(taskId);
    if (!task) return `Task not found: ${taskId}`;
    if (task.status === 'active') return `Task already active: ${taskId}`;
    if (task.status !== 'paused')
      return `Task is ${task.status}, cannot resume: ${taskId}`;

    updateTask(taskId, { status: 'active' });
    logger.info({ taskId }, 'Task resumed via command');
    return `Resumed task: ${taskId}\n${task.prompt.slice(0, 80)}...`;
  }

  // Resume all paused tasks
  const tasks = getAllTasks().filter((t) => t.status === 'paused');
  if (tasks.length === 0) return 'No paused tasks to resume.';

  let count = 0;
  for (const task of tasks) {
    updateTask(task.id, { status: 'active' });
    count++;
  }
  logger.info({ count }, 'All tasks resumed via command');
  return `Resumed ${count} task${count === 1 ? '' : 's'}.`;
}

function handleStatus(): string {
  const lines: string[] = [];

  // Mode
  const mode = readMode();
  lines.push(`Mode: ${mode}`);

  // Scheduled tasks
  const tasks = getAllTasks();
  const active = tasks.filter((t) => t.status === 'active');
  const paused = tasks.filter((t) => t.status === 'paused');
  lines.push('');
  lines.push(
    `Tasks: ${active.length} active, ${paused.length} paused, ${tasks.length} total`,
  );

  for (const t of active) {
    const schedule =
      t.schedule_type === 'cron' ? t.schedule_value : t.schedule_type;
    const nextRun = t.next_run ? formatRelativeTime(t.next_run) : 'none';
    lines.push(`  [active] ${t.id} | ${schedule} | next: ${nextRun}`);
    lines.push(`    ${t.prompt.slice(0, 60)}...`);
  }
  for (const t of paused) {
    lines.push(`  [paused] ${t.id} | ${t.group_folder}`);
  }

  // Graduation
  const grad = readGraduationStatus();
  if (grad) {
    lines.push('');
    lines.push('Graduation:');
    for (const [key, milestone] of Object.entries(grad.milestones || {})) {
      const m = milestone as {
        status: string;
        progress?: Record<string, unknown>;
      };
      const progressStr = m.progress ? summarizeProgress(m.progress) : '';
      lines.push(
        `  ${key}: ${m.status}${progressStr ? ` (${progressStr})` : ''}`,
      );
    }
  }

  // Quota
  const quota = readQuotaStatus();
  lines.push('');
  lines.push(
    `Quota: ${quota.todayTotal} invocations | ${quota.weightedUsage} weighted | ${quota.throttleLevel}`,
  );

  // Approval queue
  const pending = readApprovalQueue();
  if (pending.length > 0) {
    lines.push('');
    lines.push(`Approval queue: ${pending.length} pending`);
    for (const item of pending.slice(0, 5)) {
      lines.push(`  ${item.id}: ${item.summary || 'no summary'}`);
    }
    if (pending.length > 5) {
      lines.push(`  ...and ${pending.length - 5} more`);
    }
  }

  return lines.join('\n');
}

function handleApprove(args: string[]): string {
  if (args.length === 0) return 'Usage: /approve <item-id>';

  const itemId = args[0];
  return moveApprovalItem(itemId, 'approved');
}

function handleReject(args: string[]): string {
  if (args.length === 0) return 'Usage: /reject <item-id>';

  const itemId = args[0];
  return moveApprovalItem(itemId, 'rejected');
}

function handleQuota(): string {
  const quota = readQuotaStatus();
  const lines: string[] = [];

  lines.push(`Quota Status: ${quota.throttleLevel.toUpperCase()}`);
  lines.push(`Today: ${quota.todayTotal} invocations`);
  lines.push(`  Autonomous: ${quota.autonomousCount}`);
  lines.push(`  CEO sessions: ${quota.ceoCount}`);
  lines.push(
    `  Weighted usage: ${quota.weightedUsage} (limit ~${quota.dailyLimit}, self-calibrating)`,
  );
  lines.push('');

  if (quota.throttleLevel === 'normal') {
    lines.push('All systems operating normally.');
  } else if (quota.throttleLevel === 'throttled') {
    lines.push('Autonomous tasks throttled (60%+ usage).');
    lines.push('CEO sessions unaffected.');
  } else {
    lines.push('Autonomous tasks PAUSED (90%+ usage).');
    lines.push('CEO sessions only.');
  }

  return lines.join('\n');
}

function handleResetMode(): string {
  try {
    const stateDir = path.dirname(MODE_PATH);
    fs.mkdirSync(stateDir, { recursive: true });

    // Read current mode first
    let previousMode = 'unknown';
    try {
      if (fs.existsSync(MODE_PATH)) {
        const data = JSON.parse(fs.readFileSync(MODE_PATH, 'utf-8'));
        previousMode = data.mode || 'unknown';
      }
    } catch {
      /* ignore */
    }

    if (previousMode === 'active') {
      return 'Mode is already active. No reset needed.';
    }

    // Write active mode
    fs.writeFileSync(
      MODE_PATH,
      JSON.stringify(
        {
          mode: 'active',
          previous_mode: previousMode,
          reset_by: 'telegram_command',
          reset_at: new Date().toISOString(),
        },
        null,
        2,
      ),
    );

    logger.info(
      { previousMode },
      'Mode reset to active via /reset-mode command',
    );
    return `Mode reset: ${previousMode} → active\nAll autonomous operations restored.`;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return `Error resetting mode: ${msg}`;
  }
}

// --- Helper functions ---

function readMode(): string {
  try {
    if (!fs.existsSync(MODE_PATH)) return 'active (no mode file)';
    const data = JSON.parse(fs.readFileSync(MODE_PATH, 'utf-8'));
    return data.mode || data.status || 'unknown';
  } catch {
    return 'unknown (read error)';
  }
}

interface GraduationData {
  milestones?: Record<string, unknown>;
  last_updated?: string;
}

function readGraduationStatus(): GraduationData | null {
  try {
    if (!fs.existsSync(GRADUATION_STATUS_PATH)) return null;
    return JSON.parse(fs.readFileSync(GRADUATION_STATUS_PATH, 'utf-8'));
  } catch {
    return null;
  }
}

interface QuotaResult {
  todayTotal: number;
  autonomousCount: number;
  ceoCount: number;
  weightedUsage: number;
  throttleLevel: string;
  dailyLimit: number;
}

function readCalibratedLimit(): number {
  const calibrationPath = path.join(
    ATLAS_STATE_DIR,
    'autonomy',
    'quota-calibration.json',
  );
  try {
    if (fs.existsSync(calibrationPath)) {
      const data = JSON.parse(fs.readFileSync(calibrationPath, 'utf-8'));
      return data.estimated_limit || 1000;
    }
  } catch {
    /* use default */
  }
  return 1000;
}

function readQuotaStatus(): QuotaResult {
  const dailyLimit = readCalibratedLimit();
  const result: QuotaResult = {
    todayTotal: 0,
    autonomousCount: 0,
    ceoCount: 0,
    weightedUsage: 0,
    throttleLevel: 'normal',
    dailyLimit,
  };

  try {
    if (!fs.existsSync(QUOTA_TRACKING_PATH)) return result;

    const today = new Date().toISOString().split('T')[0];
    const content = fs.readFileSync(QUOTA_TRACKING_PATH, 'utf-8');
    let totalWeighted = 0;

    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line);
        if (!entry.timestamp?.startsWith(today)) continue;

        result.todayTotal++;
        const model = (entry.model || 'sonnet').toLowerCase();
        let weight = 1.0;
        for (const [key, w] of Object.entries(MODEL_WEIGHTS)) {
          if (model.includes(key)) {
            weight = w;
            break;
          }
        }
        totalWeighted += weight;

        if (entry.type === 'autonomous') {
          result.autonomousCount++;
        } else {
          result.ceoCount++;
        }
      } catch {
        /* skip malformed */
      }
    }

    result.weightedUsage = Math.round(totalWeighted * 100) / 100;
    const usagePercent = totalWeighted / dailyLimit;
    if (usagePercent >= 0.9) {
      result.throttleLevel = 'paused';
    } else if (usagePercent >= 0.6) {
      result.throttleLevel = 'throttled';
    }
  } catch {
    // Non-fatal — return defaults
  }

  return result;
}

interface ApprovalItem {
  id: string;
  summary?: string;
  [key: string]: unknown;
}

function readApprovalQueue(): ApprovalItem[] {
  try {
    if (!fs.existsSync(APPROVAL_PENDING_DIR)) return [];

    const files = fs
      .readdirSync(APPROVAL_PENDING_DIR)
      .filter((f) => f.endsWith('.json'));
    const items: ApprovalItem[] = [];

    for (const file of files) {
      try {
        const data = JSON.parse(
          fs.readFileSync(path.join(APPROVAL_PENDING_DIR, file), 'utf-8'),
        );
        items.push({
          id: data.id || path.basename(file, '.json'),
          summary: data.summary || data.description || data.action,
          ...data,
        });
      } catch {
        /* skip */
      }
    }

    return items;
  } catch {
    return [];
  }
}

function moveApprovalItem(
  itemId: string,
  destination: 'approved' | 'rejected',
): string {
  try {
    if (!fs.existsSync(APPROVAL_PENDING_DIR)) {
      return `No approval queue found at ${APPROVAL_PENDING_DIR}`;
    }

    // Find the item file (could be {id}.json or contain the id)
    const files = fs
      .readdirSync(APPROVAL_PENDING_DIR)
      .filter((f) => f.endsWith('.json'));
    let matchedFile: string | null = null;

    for (const file of files) {
      if (
        file === `${itemId}.json` ||
        path.basename(file, '.json') === itemId
      ) {
        matchedFile = file;
        break;
      }
      // Check inside the file for matching id
      try {
        const data = JSON.parse(
          fs.readFileSync(path.join(APPROVAL_PENDING_DIR, file), 'utf-8'),
        );
        if (data.id === itemId) {
          matchedFile = file;
          break;
        }
      } catch {
        /* skip */
      }
    }

    if (!matchedFile) {
      return `Item not found in approval queue: ${itemId}`;
    }

    const srcPath = path.join(APPROVAL_PENDING_DIR, matchedFile);
    const destDir =
      destination === 'approved'
        ? APPROVAL_APPROVED_DIR
        : APPROVAL_REJECTED_DIR;
    const destPath = path.join(destDir, matchedFile);

    fs.mkdirSync(destDir, { recursive: true });

    // Read, add disposition metadata, write to destination
    const data = JSON.parse(fs.readFileSync(srcPath, 'utf-8'));
    data.disposition = destination;
    data.disposition_at = new Date().toISOString();
    data.disposition_via = 'telegram_command';

    fs.writeFileSync(destPath, JSON.stringify(data, null, 2));
    fs.unlinkSync(srcPath);

    logger.info(
      { itemId, destination },
      `Approval item ${destination} via command`,
    );
    const verb = destination === 'approved' ? 'Approved' : 'Rejected';
    return `${verb}: ${itemId}\n${data.summary || data.description || ''}`;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return `Error: ${msg}`;
  }
}

function formatRelativeTime(isoString: string): string {
  try {
    const target = new Date(isoString).getTime();
    const now = Date.now();
    const diffMs = target - now;

    if (diffMs < 0) return 'overdue';

    const minutes = Math.floor(diffMs / 60000);
    if (minutes < 60) return `in ${minutes}m`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `in ${hours}h ${minutes % 60}m`;
    const days = Math.floor(hours / 24);
    return `in ${days}d ${hours % 24}h`;
  } catch {
    return isoString;
  }
}

function summarizeProgress(progress: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(progress)) {
    if (key === 'target') continue;
    if (typeof value === 'number' || typeof value === 'string') {
      const target = progress.target;
      const label = key.replace(/_/g, ' ');
      parts.push(
        target ? `${label}: ${value}/${target}` : `${label}: ${value}`,
      );
    }
  }
  return parts.join(', ');
}
