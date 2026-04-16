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
import {
  ATLAS_STATE_DIR,
  ATLAS_OPS_DIR,
  TELEGRAM_CEO_USER_ID,
} from './config.js';
import {
  createMission,
  createMissionRole,
  getActiveMissions,
  getMission,
  getMissionByPrefix,
  getMissionEvents,
  getMissionRoles,
  getRecentMissions,
  logMissionEvent,
  updateMission,
  updateMissionRole,
  getAllTasks,
  getTaskById,
  updateTask,
} from './db.js';
import { logger } from './logger.js';

// Atlas state paths (host-level, engineering repo)
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

// Mission state paths (operations repo — post three-repo split)
const MISSIONS_DIR = path.join(ATLAS_OPS_DIR, 'swarm', 'missions');
const MISSION_TEMPLATES_PATH = path.join(
  ATLAS_OPS_DIR,
  'swarm',
  'mission-templates.json',
);
const HOST_TASKS_PENDING = path.join(ATLAS_STATE_DIR, 'host-tasks', 'pending');
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

// Dangerous commands that require CEO sender verification
const CEO_ONLY_COMMANDS = new Set([
  '/approve',
  '/reject',
  '/pause',
  '/resume',
  '/reset-mode',
  '/mission',
]);

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
 *
 * @param sender - Telegram user ID (ctx.from.id) for CEO-only command gating
 */
export function handleCommand(text: string, sender?: string): CommandResult {
  const trimmed = text.trim();
  if (!trimmed.startsWith('/')) return { handled: false };

  const parts = trimmed.split(/\s+/);
  const cmd = parts[0].toLowerCase();
  const args = parts.slice(1);

  // CEO-only gate: dangerous commands require verified sender
  if (CEO_ONLY_COMMANDS.has(cmd) && TELEGRAM_CEO_USER_ID) {
    if (!sender || sender !== TELEGRAM_CEO_USER_ID) {
      logger.warn(
        { cmd, sender, expected: TELEGRAM_CEO_USER_ID },
        'CEO-only command rejected: sender mismatch',
      );
      return {
        handled: true,
        response: `Command ${cmd} requires CEO authorization.`,
      };
    }
  }

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
  /mission list — Show active + recent missions
  /mission status <id> — Mission details with role progress
  /mission create <type> [entity] — Create mission for approval
  /mission approve <id> — Approve and execute mission
  /mission stop <id> — Stop running mission
  /mission types — List available mission types
  /mission history — Last 20 completed missions
  /mission show <id> — Full mission report with outputs`;
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
    case 'history':
      return missionHistory();
    case 'show':
      return missionShow(subargs[0]);
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
  // SQLite-backed: read from missions table instead of filesystem
  try {
    const active = getActiveMissions();
    const recent = getRecentMissions(10);

    if (active.length === 0 && recent.length === 0) return 'No missions yet.';

    const lines: string[] = [];

    if (active.length > 0) {
      lines.push(`Active (${active.length}):`);
      for (const m of active) {
        const roles = getMissionRoles(m.id);
        const done = roles.filter((r) => r.status === 'success').length;
        const statusEmoji =
          m.status === 'proposed'
            ? '📋'
            : m.status === 'approved'
              ? '⏳'
              : m.status === 'running'
                ? '🚀'
                : m.status === 'synthesizing'
                  ? '🔀'
                  : '❓';
        lines.push(
          `  ${statusEmoji} ${m.title}  ${m.entity.toUpperCase()}  ${done}/${roles.length} roles  $${m.cost_actual_usd.toFixed(2)}`,
        );
      }
    }

    // Show recent completed/failed that aren't in active
    const activeIds = new Set(active.map((m) => m.id));
    const completed = recent.filter((m) => !activeIds.has(m.id));
    if (completed.length > 0) {
      if (lines.length > 0) lines.push('');
      lines.push('Recent:');
      for (const m of completed.slice(0, 7)) {
        const emoji =
          m.status === 'complete' ? '✅' : m.status === 'failed' ? '❌' : '⏸️';
        const date = m.completed_at
          ? new Date(m.completed_at).toLocaleDateString('en-US', {
              month: 'short',
              day: 'numeric',
            })
          : '';
        lines.push(
          `  ${emoji} ${m.title}  ${m.entity.toUpperCase()}  $${m.cost_actual_usd.toFixed(2)}  ${date}`,
        );
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
    // SQLite-backed: find by prefix match
    const mission = getMissionByPrefix(id) || getMission(id);
    if (!mission) return `Mission not found: ${id}`;

    const roles = getMissionRoles(mission.id);
    const events = getMissionEvents(mission.id);

    const statusEmoji: Record<string, string> = {
      proposed: '📋',
      approved: '⏳',
      running: '🚀',
      synthesizing: '🔀',
      complete: '✅',
      failed: '❌',
      stopped: '⏸️',
    };

    const roleEmoji: Record<string, string> = {
      pending: '⏳',
      running: '🔄',
      success: '✅',
      error: '❌',
      timeout: '❌',
      cancelled: '⏸️',
    };

    const lines = [
      `${statusEmoji[mission.status] || '❓'} ${mission.title}`,
      `Entity: ${mission.entity.toUpperCase()}  |  Status: ${mission.status}`,
      `Cost: $${mission.cost_actual_usd.toFixed(2)}${mission.cost_estimate_usd ? ` / ~$${mission.cost_estimate_usd.toFixed(2)} est.` : ''}`,
      '',
      'Roles:',
    ];
    for (const r of roles) {
      const dur =
        r.started_at && r.completed_at
          ? `${Math.round((new Date(r.completed_at).getTime() - new Date(r.started_at).getTime()) / 1000)}s`
          : '';
      lines.push(
        `  ${roleEmoji[r.status] || '❓'} ${r.role_name} (${r.model})${dur ? ` — ${dur}` : ''}${r.error ? ` — ${r.error.slice(0, 60)}` : ''}`,
      );
    }

    if (mission.result_summary) {
      lines.push('');
      lines.push('Summary:');
      lines.push(mission.result_summary.slice(0, 500));
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

    const missionEntity = entity || 'gpg';
    const missionId = `m-${Date.now()}`;

    // Create mission in SQLite (single source of truth)
    createMission({
      id: missionId,
      entity: missionEntity,
      template_type: missionType,
      title: template.name,
      brief: template.brief_template,
      roster: JSON.stringify(template.roles),
      cost_estimate_usd: template.estimated_cost,
      correlation_id: `${missionEntity.toUpperCase().slice(0, 3)}-${missionId.slice(2, 10)}-${Math.floor(Date.now() / 1000)}`,
    });

    // Create role entries
    for (const [roleName, roleConfig] of Object.entries(template.roles)) {
      const rc = roleConfig as { model: string; task: string };
      createMissionRole({
        mission_id: missionId,
        role_name: roleName,
        model: rc.model || 'sonnet',
        task: rc.task,
      });
    }

    logMissionEvent(
      missionId,
      'created',
      undefined,
      `Template: ${missionType}, Entity: ${missionEntity}`,
    );

    const roleNames = Object.keys(template.roles).join(', ');
    logger.info(
      { missionId, missionType, entity: missionEntity },
      'Mission created via /mission create',
    );

    return `📋 Mission: ${template.name}\nEntity: ${missionEntity.toUpperCase()}\n\nRoster:\n${Object.entries(
      template.roles,
    )
      .map(([name, cfg]) => `  • ${name} (${(cfg as { model: string }).model})`)
      .join(
        '\n',
      )}\n\nEst. cost: ~$${template.estimated_cost}  |  Est. time: ~${template.estimated_minutes}min\n\n⏳ ID: ${missionId}\nApprove: /mission approve ${missionId}`;
  } catch (err) {
    return `Error: ${err}`;
  }
}

function missionApprove(id?: string): string {
  if (!id) return 'Usage: /mission approve <mission-id>';
  try {
    const mission = getMissionByPrefix(id) || getMission(id);
    if (!mission) return `Mission not found: ${id}`;

    if (mission.status !== 'proposed') {
      return `Mission ${mission.id} is ${mission.status}, not proposed.`;
    }

    // Update status to approved — bridge server will pick it up and spawn roles
    updateMission(mission.id, {
      status: 'approved',
      approved_at: new Date().toISOString(),
    });
    logMissionEvent(
      mission.id,
      'approved',
      undefined,
      'CEO approved via Telegram',
    );

    logger.info(
      { missionId: mission.id },
      'Mission approved via /mission approve',
    );

    const roles = getMissionRoles(mission.id);
    return `🚀 Mission approved: ${mission.title}\n\n${roles.length} roles spawning...\n${roles.map((r) => `  🔄 ${r.role_name} (${r.model})`).join('\n')}\n\nTrack: /mission status ${mission.id}`;
  } catch (err) {
    return `Error: ${err}`;
  }
}

function missionStop(id?: string): string {
  if (!id) return 'Usage: /mission stop <mission-id>';
  try {
    const mission = getMissionByPrefix(id) || getMission(id);
    if (!mission) return `Mission not found: ${id}`;

    if (!['running', 'approved', 'synthesizing'].includes(mission.status)) {
      return `Mission ${mission.id} is ${mission.status}, cannot stop.`;
    }

    updateMission(mission.id, {
      status: 'stopped' as any,
      completed_at: new Date().toISOString(),
    });
    logMissionEvent(
      mission.id,
      'stopped',
      undefined,
      'CEO stopped via Telegram',
    );

    // Mark any running roles as cancelled
    const roles = getMissionRoles(mission.id);
    for (const r of roles) {
      if (['pending', 'running'].includes(r.status)) {
        updateMissionRole(mission.id, r.role_name, {
          status: 'cancelled' as any,
          completed_at: new Date().toISOString(),
        });
      }
    }

    logger.info({ missionId: mission.id }, 'Mission stopped via /mission stop');
    return `🛑 Mission stopped: ${mission.title}\nRunning containers will be terminated.`;
  } catch (err) {
    return `Error: ${err}`;
  }
}

function missionHistory(): string {
  try {
    const missions = getRecentMissions(20);
    const completed = missions.filter((m) =>
      ['complete', 'failed', 'stopped'].includes(m.status),
    );
    if (completed.length === 0) return 'No completed missions yet.';

    const lines = ['Mission History (last 20):'];
    for (const m of completed) {
      const emoji =
        m.status === 'complete' ? '✅' : m.status === 'failed' ? '❌' : '⏸️';
      const date = m.completed_at
        ? new Date(m.completed_at).toLocaleDateString('en-US', {
            month: 'short',
            day: 'numeric',
            hour: 'numeric',
            minute: '2-digit',
          })
        : '';
      lines.push(
        `${emoji} ${m.title}  ${m.entity.toUpperCase()}  $${m.cost_actual_usd.toFixed(2)}  ${date}`,
      );
      lines.push(`   ID: ${m.id}  |  /mission show ${m.id}`);
    }
    return lines.join('\n');
  } catch (err) {
    return `Error: ${err}`;
  }
}

function missionShow(id?: string): string {
  if (!id) return 'Usage: /mission show <mission-id>';
  try {
    const mission = getMissionByPrefix(id) || getMission(id);
    if (!mission) return `Mission not found: ${id}`;

    const roles = getMissionRoles(mission.id);
    const events = getMissionEvents(mission.id);

    const statusEmoji: Record<string, string> = {
      proposed: '📋',
      approved: '⏳',
      running: '🚀',
      synthesizing: '🔀',
      complete: '✅',
      failed: '❌',
      stopped: '⏸️',
    };
    const roleEmoji: Record<string, string> = {
      pending: '⏳',
      running: '🔄',
      success: '✅',
      error: '❌',
      timeout: '❌',
      cancelled: '⏸️',
    };

    const lines = [
      `${statusEmoji[mission.status] || '❓'} *${mission.title}*`,
      `Entity: ${mission.entity.toUpperCase()}  |  Type: ${mission.template_type}`,
      `Status: ${mission.status}  |  Cost: $${mission.cost_actual_usd.toFixed(2)}`,
      '',
    ];

    // Timeline
    if (events.length > 0) {
      lines.push('*Timeline:*');
      for (const evt of events) {
        const time = new Date(evt.timestamp).toLocaleTimeString('en-US', {
          hour: 'numeric',
          minute: '2-digit',
          hour12: true,
        });
        const role = evt.role_name ? ` [${evt.role_name}]` : '';
        lines.push(`  ${time}  ${evt.event_type}${role}`);
      }
      lines.push('');
    }

    // Roles
    lines.push('*Roles:*');
    for (const r of roles) {
      const dur =
        r.started_at && r.completed_at
          ? `${Math.round((new Date(r.completed_at).getTime() - new Date(r.started_at).getTime()) / 1000)}s`
          : '';
      lines.push(
        `  ${roleEmoji[r.status] || '❓'} ${r.role_name} (${r.model})  $${r.cost_usd.toFixed(2)}${dur ? `  ${dur}` : ''}`,
      );
      if (r.error) lines.push(`    Error: ${r.error.slice(0, 100)}`);
    }

    // Summary
    if (mission.result_summary) {
      lines.push('');
      lines.push('*Summary:*');
      lines.push(mission.result_summary.slice(0, 1000));
    }

    // Dashboard link
    lines.push('');
    lines.push(
      `Full report: https://atlas.gainpropertygroup.com/missions/${mission.id}`,
    );

    return lines.join('\n');
  } catch (err) {
    return `Error: ${err}`;
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
