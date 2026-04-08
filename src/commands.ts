/**
 * Atlas Telegram command handler.
 * Intercepts /command messages from the main group and handles them
 * mechanically (no LLM, no container) for instant responses.
 *
 * Commands: /pause, /resume, /status, /approve, /reject, /quota
 */

import fs from 'fs';
import path from 'path';

import { getPauseStatus, resumeGroup } from './auto-pause.js';
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

// Mission state paths
const MISSIONS_DIR = path.join(ATLAS_STATE_DIR, 'swarm', 'missions');
const MISSION_TEMPLATES_PATH = path.join(
  ATLAS_STATE_DIR,
  'swarm',
  'mission-templates.json',
);
const HOST_TASKS_PENDING = path.join(ATLAS_STATE_DIR, 'host-tasks', 'pending');
const CODEX_TOGGLE_PATH = path.join(
  ATLAS_STATE_DIR,
  'state',
  'codex-toggle.json',
);
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
    case '/mission':
      return { handled: true, response: handleMission(args) };
    case '/reset-mode':
      return { handled: true, response: handleResetMode() };
    case '/codex':
      return { handled: true, response: handleCodex(args) };
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
  const lines: string[] = [];

  // Always clear group-level auto-pause (the building lockdown, not individual doors)
  const pauseStatus = getPauseStatus();
  const pausedGroupNames = Object.keys(pauseStatus.pausedGroups);
  if (pausedGroupNames.length > 0) {
    for (const group of pausedGroupNames) {
      resumeGroup(group);
    }
    logger.info(
      { groups: pausedGroupNames },
      'Auto-paused groups resumed via /resume',
    );
    lines.push(
      `Cleared auto-pause on ${pausedGroupNames.length} group(s): ${pausedGroupNames.join(', ')}`,
    );
  }

  if (args.length > 0) {
    // Resume specific task
    const taskId = args[0];
    const task = getTaskById(taskId);
    if (!task) {
      lines.push(`Task not found: ${taskId}`);
      return lines.join('\n') || 'Nothing to resume.';
    }
    if (task.status === 'active') {
      lines.push(`Task already active: ${taskId}`);
      return lines.join('\n');
    }
    if (task.status !== 'paused') {
      lines.push(`Task is ${task.status}, cannot resume: ${taskId}`);
      return lines.join('\n');
    }

    updateTask(taskId, { status: 'active' });
    logger.info({ taskId }, 'Task resumed via command');
    lines.push(`Resumed task: ${taskId}\n${task.prompt.slice(0, 80)}...`);
    return lines.join('\n');
  }

  // Resume all paused tasks
  const tasks = getAllTasks().filter((t) => t.status === 'paused');
  if (tasks.length > 0) {
    let count = 0;
    for (const task of tasks) {
      updateTask(task.id, { status: 'active' });
      count++;
    }
    logger.info({ count }, 'All tasks resumed via command');
    lines.push(`Resumed ${count} task${count === 1 ? '' : 's'}.`);
  }

  return lines.join('\n') || 'Nothing to resume — no paused groups or tasks.';
}

function handleStatus(): string {
  const lines: string[] = [];

  // Mode
  const mode = readMode();
  lines.push(`Mode: ${mode}`);

  // Auto-pause state (group-level safety lockdowns)
  const pauseStatus = getPauseStatus();
  const autoPausedGroups = Object.entries(pauseStatus.pausedGroups);
  if (autoPausedGroups.length > 0) {
    lines.push('');
    lines.push(`⚠️ Auto-paused groups: ${autoPausedGroups.length}`);
    for (const [group, info] of autoPausedGroups) {
      lines.push(`  ${group}: ${info.reason} (since ${info.pausedAt})`);
    }
    lines.push('  Use /resume to clear.');
  }

  // Failure tracking (groups approaching auto-pause threshold)
  const failingGroups = Object.entries(pauseStatus.failureCounts).filter(
    ([, c]) => c > 0,
  );
  if (failingGroups.length > 0) {
    lines.push('');
    lines.push('Failure counts:');
    for (const [group, count] of failingGroups) {
      lines.push(`  ${group}: ${count}/3 consecutive failures`);
    }
  }

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

function handleMission(args: string[]): string {
  if (args.length === 0) {
    return `Usage:
  /mission list — Show recent missions
  /mission status <id> — Mission details
  /mission create <type> [entity] — Create mission (queues for approval)
  /mission approve <id> — Execute approved mission
  /mission stop <id> — Stop running mission
  /mission types — List available mission types`;
  }

  const subcmd = args[0].toLowerCase();
  const subargs = args.slice(1);

  switch (subcmd) {
    case 'list':
      return missionList();
    case 'status':
      return missionStatus(subargs[0]);
    case 'create':
      return missionCreate(subargs[0], subargs[1]);
    case 'approve':
      return missionApprove(subargs[0]);
    case 'stop':
      return missionStop(subargs[0]);
    case 'types':
      return missionTypes();
    default:
      return `Unknown mission command: ${subcmd}`;
  }
}

function missionTypes(): string {
  try {
    if (!fs.existsSync(MISSION_TEMPLATES_PATH))
      return 'No mission templates found.';
    const data = JSON.parse(fs.readFileSync(MISSION_TEMPLATES_PATH, 'utf-8'));
    const templates = data.templates || {};
    const lines = ['Available mission types:'];
    for (const [key, tmpl] of Object.entries(templates)) {
      const t = tmpl as {
        name: string;
        estimated_cost: number;
        estimated_minutes: number;
        roles: Record<string, unknown>;
      };
      const roleCount = Object.keys(t.roles || {}).length;
      lines.push(
        `  ${key} — ${t.name} (${roleCount} roles, ~$${t.estimated_cost}, ~${t.estimated_minutes}min)`,
      );
    }
    return lines.join('\n');
  } catch (err) {
    return `Error reading templates: ${err}`;
  }
}

function missionList(): string {
  try {
    if (!fs.existsSync(MISSIONS_DIR)) return 'No missions yet.';
    const dirs = fs
      .readdirSync(MISSIONS_DIR)
      .filter((d) => fs.statSync(path.join(MISSIONS_DIR, d)).isDirectory())
      .sort()
      .reverse()
      .slice(0, 10);

    if (dirs.length === 0) return 'No missions yet.';

    const lines = ['Recent missions:'];
    for (const dir of dirs) {
      const statusPath = path.join(MISSIONS_DIR, dir, 'status.json');
      try {
        const status = JSON.parse(fs.readFileSync(statusPath, 'utf-8'));
        const roleCount = Object.keys(status.roles || {}).length;
        lines.push(
          `  ${dir} | ${status.status} | ${roleCount} roles | ${status.started_at || 'pending'}`,
        );
      } catch {
        lines.push(`  ${dir} | (no status file)`);
      }
    }
    return lines.join('\n');
  } catch (err) {
    return `Error: ${err}`;
  }
}

function missionStatus(id?: string): string {
  if (!id) return 'Usage: /mission status <mission-id>';
  try {
    // Find mission by partial match
    if (!fs.existsSync(MISSIONS_DIR)) return 'No missions directory.';
    const dirs = fs.readdirSync(MISSIONS_DIR);
    const match = dirs.find((d) => d.includes(id));
    if (!match) return `Mission not found: ${id}`;

    const statusPath = path.join(MISSIONS_DIR, match, 'status.json');
    const status = JSON.parse(fs.readFileSync(statusPath, 'utf-8'));
    const lines = [
      `Mission: ${match}`,
      `Status: ${status.status}`,
      `Started: ${status.started_at || 'n/a'}`,
      `Completed: ${status.completed_at || 'running'}`,
      '',
      'Roles:',
    ];
    for (const [role, roleStatus] of Object.entries(status.roles || {})) {
      lines.push(`  ${role}: ${roleStatus}`);
    }

    // Check for outputs
    const workspace = path.join(MISSIONS_DIR, match, 'workspace');
    if (fs.existsSync(workspace)) {
      const outputs = fs
        .readdirSync(workspace)
        .filter((f) => f.endsWith('-output.md'));
      if (outputs.length > 0) {
        lines.push('');
        lines.push('Outputs:');
        for (const f of outputs) {
          const size = fs.statSync(path.join(workspace, f)).size;
          lines.push(`  ${f} (${size} bytes)`);
        }
      }
    }

    return lines.join('\n');
  } catch (err) {
    return `Error: ${err}`;
  }
}

function missionCreate(missionType?: string, entity?: string): string {
  if (!missionType)
    return 'Usage: /mission create <type> [entity]\nRun /mission types for available types.';
  try {
    if (!fs.existsSync(MISSION_TEMPLATES_PATH))
      return 'No mission templates found.';
    const data = JSON.parse(fs.readFileSync(MISSION_TEMPLATES_PATH, 'utf-8'));
    const template = data.templates?.[missionType];
    if (!template)
      return `Unknown mission type: ${missionType}\nRun /mission types for available types.`;

    const missionId = `mission-${Date.now()}`;
    const missionEntity = entity || 'atlas_main';

    // Queue as host-executor task
    const task = {
      task_id: missionId,
      type: 'mission',
      entity: missionEntity,
      brief: template.brief_template,
      roster: { roles: template.roles },
      model: 'sonnet',
      status: 'pending_approval',
      created_at: new Date().toISOString(),
      created_via: 'telegram',
      mission_type: missionType,
    };

    // Write to approval queue, not directly to pending
    const approvalDir = path.join(ATLAS_STATE_DIR, 'approval-queue', 'pending');
    fs.mkdirSync(approvalDir, { recursive: true });
    fs.writeFileSync(
      path.join(approvalDir, `${missionId}.json`),
      JSON.stringify(task, null, 2),
    );

    const roleNames = Object.keys(template.roles).join(', ');
    return `Mission created: ${missionId}\nType: ${template.name}\nEntity: ${missionEntity}\nRoles: ${roleNames}\nEst. cost: ~$${template.estimated_cost}\n\n⏳ Awaiting approval. Run: /mission approve ${missionId}`;
  } catch (err) {
    return `Error: ${err}`;
  }
}

function missionApprove(id?: string): string {
  if (!id) return 'Usage: /mission approve <mission-id>';
  try {
    const approvalDir = path.join(ATLAS_STATE_DIR, 'approval-queue', 'pending');
    if (!fs.existsSync(approvalDir)) return 'No pending approvals.';

    const files = fs
      .readdirSync(approvalDir)
      .filter((f) => f === `${id}.json` || f.startsWith(`${id}-`));
    if (files.length === 0) return `No pending mission found: ${id}`;

    const filePath = path.join(approvalDir, files[0]);
    const task = JSON.parse(fs.readFileSync(filePath, 'utf-8'));

    if (task.type !== 'mission') return `Item ${id} is not a mission.`;

    // Move to host-executor pending tasks
    delete task.status;
    fs.mkdirSync(HOST_TASKS_PENDING, { recursive: true });
    fs.writeFileSync(
      path.join(HOST_TASKS_PENDING, files[0]),
      JSON.stringify(task, null, 2),
    );

    // Remove from approval queue
    try {
      fs.unlinkSync(filePath);
    } catch (unlinkErr) {
      logger.error(
        { missionId: id, error: unlinkErr },
        'Failed to remove from approval queue after writing to pending — task may execute twice',
      );
      throw unlinkErr;
    }

    logger.info({ missionId: id }, 'Mission approved and queued for execution');
    return `✅ Mission approved: ${id}\nQueued for execution. Use /mission list to track.`;
  } catch (err) {
    return `Error: ${err}`;
  }
}

function missionStop(id?: string): string {
  if (!id) return 'Usage: /mission stop <mission-id>';
  try {
    if (!fs.existsSync(MISSIONS_DIR)) return 'No missions directory.';
    const dirs = fs.readdirSync(MISSIONS_DIR);
    const match = dirs.find((d) => d.includes(id));
    if (!match) return `Mission not found: ${id}`;

    const statusPath = path.join(MISSIONS_DIR, match, 'status.json');
    const status = JSON.parse(fs.readFileSync(statusPath, 'utf-8'));

    if (status.status !== 'running') {
      return `Mission ${match} is ${status.status}, not running.`;
    }

    status.status = 'stopped';
    status.stopped_at = new Date().toISOString();
    status.stopped_by = 'ceo_telegram';
    fs.writeFileSync(statusPath, JSON.stringify(status, null, 2));

    // Note: actual process termination happens via host-executor monitoring
    // This sets the flag that the monitor checks
    logger.info({ missionId: match }, 'Mission stop requested via Telegram');
    return `🛑 Mission stopped: ${match}\nRunning processes will be terminated by host-executor.`;
  } catch (err) {
    return `Error: ${err}`;
  }
}
function handleCodex(args: string[]): string {
  // /codex        — show current toggle state
  // /codex on     — enable Codex (default behavior)
  // /codex off    — disable Codex, use Claude subagents instead
  try {
    const subcommand = args[0]?.toLowerCase();

    if (!subcommand) {
      // Show current state
      const state = readCodexToggle();
      const status = state.codex_enabled
        ? 'ON (Codex active)'
        : 'OFF (Claude subagents)';
      const updated = state.updated_at
        ? `\nLast changed: ${state.updated_at}`
        : '';
      const by = state.updated_by ? ` by ${state.updated_by}` : '';
      return `Codex toggle: ${status}${updated}${by}`;
    }

    if (subcommand === 'on') {
      writeCodexToggle(true);
      logger.info('Codex enabled via /codex on command');
      return (
        'Codex toggle: ON\n' +
        'All delegation, cross-review, and challenge routes through Codex.\n' +
        'Delegation gate enforces cx wrapper usage.'
      );
    }

    if (subcommand === 'off') {
      writeCodexToggle(false);
      logger.info('Codex disabled via /codex off command');
      return (
        'Codex toggle: OFF\n' +
        'All Codex processes replaced by Claude subagents:\n' +
        '- Delegation gate: passes (Atlas writes directly)\n' +
        '- Cross-review: routes to Claude\n' +
        '- Challenge: routes to Claude\n' +
        '- Routing gate: skipped\n' +
        '- Pre-push receipts: skipped (certificates only)'
      );
    }

    return 'Usage: /codex [on|off]\n  /codex     — show current state\n  /codex on  — enable Codex\n  /codex off — disable Codex';
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return `Error handling codex toggle: ${msg}`;
  }
}

function readCodexToggle(): {
  codex_enabled: boolean;
  updated_at?: string;
  updated_by?: string;
} {
  try {
    if (!fs.existsSync(CODEX_TOGGLE_PATH)) {
      return { codex_enabled: true }; // Default: Codex ON
    }
    return JSON.parse(fs.readFileSync(CODEX_TOGGLE_PATH, 'utf-8'));
  } catch {
    return { codex_enabled: true };
  }
}

function writeCodexToggle(enabled: boolean): void {
  const stateDir = path.dirname(CODEX_TOGGLE_PATH);
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(
    CODEX_TOGGLE_PATH,
    JSON.stringify(
      {
        codex_enabled: enabled,
        updated_at: new Date().toISOString(),
        updated_by: 'CEO',
      },
      null,
      2,
    ),
  );
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
