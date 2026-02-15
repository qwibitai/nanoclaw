/**
 * Governance Dispatch Loop
 *
 * Polls for governance tasks in actionable states and auto-dispatches them:
 * 1. READY + assigned_group → transition to DOING, dispatch to developer container
 * 2. REVIEW + gate != None → transition to APPROVAL, dispatch to gate approver container
 *
 * Uses gov_dispatches table for idempotent dispatch (crash-safe).
 */
import { ChildProcess } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

import {
  DATA_DIR,
  GROUPS_DIR,
  IDLE_TIMEOUT,
  MAIN_GROUP_FOLDER,
} from './config.js';
import {
  ContainerOutput,
  runContainerAgent,
  writeTasksSnapshot,
} from './container-runner.js';
import {
  getAllActiveCapabilities,
} from './ext-broker-db.js';
import {
  getAllProviderNames,
  getProviderActionCatalog,
} from './ext-broker-providers.js';
import {
  getAllGovTasks,
  getDispatchableGovTasks,
  getGovTaskById,
  getReviewableGovTasks,
  logGovActivity,
  tryCreateDispatch,
  updateDispatchStatus,
  updateGovTask,
} from './gov-db.js';
import { getAllTasks } from './db.js';
import { GATE_APPROVER } from './governance/gates.js';
import type { GateType } from './governance/gates.js';
import { validateTransition } from './governance/policy.js';
import type { GovTask } from './governance/constants.js';
import { GroupQueue } from './group-queue.js';
import { logger } from './logger.js';
import { RegisteredGroup } from './types.js';

export const GOV_POLL_INTERVAL = parseInt(
  process.env.GOV_POLL_INTERVAL || '10000',
  10,
);

export interface GovLoopDeps {
  registeredGroups: () => Record<string, RegisteredGroup>;
  queue: GroupQueue;
  onProcess: (
    groupJid: string,
    proc: ChildProcess,
    containerName: string,
    groupFolder: string,
  ) => void;
  sendMessage: (jid: string, text: string) => Promise<void>;
  getSessions: () => Record<string, string>;
}

let govLoopRunning = false;

export function startGovLoop(deps: GovLoopDeps): void {
  if (govLoopRunning) {
    logger.debug('Governance loop already running, skipping duplicate start');
    return;
  }
  govLoopRunning = true;
  logger.info('Governance dispatch loop started');

  const loop = async () => {
    try {
      await dispatchReadyTasks(deps);
      await dispatchReviewTasks(deps);
    } catch (err) {
      logger.error({ err }, 'Error in governance loop');
    }

    setTimeout(loop, GOV_POLL_INTERVAL);
  };

  loop();
}

/**
 * READY + assigned_group → DOING (dispatch to developer)
 */
async function dispatchReadyTasks(deps: GovLoopDeps): Promise<void> {
  const readyTasks = getDispatchableGovTasks();

  for (const task of readyTasks) {
    if (!task.assigned_group) continue;

    const groupJid = resolveGroupJid(task.assigned_group, deps);
    if (!groupJid) {
      logger.warn(
        { taskId: task.id, group: task.assigned_group },
        'Gov dispatch: assigned group not registered, skipping',
      );
      continue;
    }

    // Idempotent dispatch via gov_dispatches UNIQUE key
    const dispatchKey = `${task.id}:READY->DOING:v${task.version}`;
    const now = new Date().toISOString();

    const claimed = tryCreateDispatch({
      task_id: task.id,
      from_state: 'READY',
      to_state: 'DOING',
      dispatch_key: dispatchKey,
      group_jid: groupJid,
      status: 'ENQUEUED',
      created_at: now,
      updated_at: now,
    });

    if (!claimed) {
      // Already dispatched (previous loop iteration or crash recovery)
      continue;
    }

    // Validate transition
    const result = validateTransition('READY', 'DOING');
    if (!result.ok) {
      logger.warn({ taskId: task.id, errors: result.errors }, 'Gov dispatch: policy denied READY->DOING');
      updateDispatchStatus(dispatchKey, 'FAILED');
      continue;
    }

    // Optimistic locking update
    const updated = updateGovTask(task.id, task.version, { state: 'DOING' });
    if (!updated) {
      logger.warn({ taskId: task.id }, 'Gov dispatch: version conflict on READY->DOING');
      updateDispatchStatus(dispatchKey, 'FAILED');
      continue;
    }

    logGovActivity({
      task_id: task.id,
      action: 'transition',
      from_state: 'READY',
      to_state: 'DOING',
      actor: 'system',
      reason: 'Auto-dispatched by governance loop',
      created_at: now,
    });

    // Enqueue container execution
    const group = deps.registeredGroups()[groupJid];
    deps.queue.enqueueTask(groupJid, `gov-${task.id}`, async () => {
      updateDispatchStatus(dispatchKey, 'STARTED');
      try {
        await runGovTask(task, group, groupJid, deps);
        updateDispatchStatus(dispatchKey, 'DONE');
      } catch (err) {
        logger.error({ taskId: task.id, err }, 'Gov task execution failed');
        updateDispatchStatus(dispatchKey, 'FAILED');
      }
    });

    logger.info(
      { taskId: task.id, group: task.assigned_group, dispatchKey },
      'Gov dispatch: READY -> DOING',
    );
  }
}

/**
 * REVIEW + gate != None → APPROVAL (dispatch to gate approver)
 */
async function dispatchReviewTasks(deps: GovLoopDeps): Promise<void> {
  const reviewTasks = getReviewableGovTasks();

  for (const task of reviewTasks) {
    const gate = task.gate as GateType;
    if (!gate || gate === ('None' as string)) continue;

    const approverFolder = GATE_APPROVER[gate];
    if (!approverFolder) continue;

    const groupJid = resolveGroupJid(approverFolder, deps);
    if (!groupJid) {
      logger.warn(
        { taskId: task.id, gate, approverFolder },
        'Gov dispatch: gate approver group not registered, skipping',
      );
      continue;
    }

    // Idempotent dispatch
    const dispatchKey = `${task.id}:REVIEW->APPROVAL:v${task.version}`;
    const now = new Date().toISOString();

    const claimed = tryCreateDispatch({
      task_id: task.id,
      from_state: 'REVIEW',
      to_state: 'APPROVAL',
      dispatch_key: dispatchKey,
      group_jid: groupJid,
      status: 'ENQUEUED',
      created_at: now,
      updated_at: now,
    });

    if (!claimed) continue;

    // Validate transition
    const result = validateTransition('REVIEW', 'APPROVAL');
    if (!result.ok) {
      logger.warn({ taskId: task.id, errors: result.errors }, 'Gov dispatch: policy denied REVIEW->APPROVAL');
      updateDispatchStatus(dispatchKey, 'FAILED');
      continue;
    }

    // Optimistic locking update
    const updated = updateGovTask(task.id, task.version, {
      state: 'APPROVAL',
    });
    if (!updated) {
      logger.warn({ taskId: task.id }, 'Gov dispatch: version conflict on REVIEW->APPROVAL');
      updateDispatchStatus(dispatchKey, 'FAILED');
      continue;
    }

    logGovActivity({
      task_id: task.id,
      action: 'transition',
      from_state: 'REVIEW',
      to_state: 'APPROVAL',
      actor: 'system',
      reason: `Auto-dispatched to ${approverFolder} for ${gate} gate approval`,
      created_at: now,
    });

    // Enqueue container execution for the approver
    const group = deps.registeredGroups()[groupJid];
    deps.queue.enqueueTask(groupJid, `gov-approve-${task.id}`, async () => {
      updateDispatchStatus(dispatchKey, 'STARTED');
      try {
        await runGovApprovalTask(task, gate, group, groupJid, deps);
        updateDispatchStatus(dispatchKey, 'DONE');
      } catch (err) {
        logger.error({ taskId: task.id, err }, 'Gov approval task execution failed');
        updateDispatchStatus(dispatchKey, 'FAILED');
      }
    });

    logger.info(
      { taskId: task.id, gate, approver: approverFolder, dispatchKey },
      'Gov dispatch: REVIEW -> APPROVAL',
    );
  }
}

// --- Task execution ---

function buildGovTaskPrompt(task: GovTask): string {
  const lines = [
    `You have a governance task assigned:`,
    `- ID: ${task.id}`,
    `- Title: ${task.title}`,
    `- Type: ${task.task_type} | Priority: ${task.priority}`,
  ];
  if (task.description) lines.push(`- Description: ${task.description}`);
  if (task.product) lines.push(`- Product: ${task.product}`);

  lines.push('');
  lines.push('When you finish, use the gov_transition tool to move this task to REVIEW.');
  lines.push('If you are blocked, move it to BLOCKED with a reason.');

  return lines.join('\n');
}

function buildApprovalPrompt(task: GovTask, gate: string): string {
  const lines = [
    `A governance task requires your ${gate} gate approval:`,
    `- ID: ${task.id}`,
    `- Title: ${task.title}`,
    `- Type: ${task.task_type} | Priority: ${task.priority}`,
    `- Current State: APPROVAL`,
  ];
  if (task.description) lines.push(`- Description: ${task.description}`);
  if (task.executor) lines.push(`- Executor: ${task.executor}`);
  if (task.assigned_group) lines.push(`- Developer group: ${task.assigned_group}`);

  lines.push('');
  lines.push(`Use gov_approve to approve the ${gate} gate.`);
  lines.push('Then use gov_transition to move the task to DONE.');
  lines.push('If there are concerns, use gov_transition to move back to REVIEW or BLOCKED.');

  return lines.join('\n');
}

async function runGovTask(
  task: GovTask,
  group: RegisteredGroup,
  groupJid: string,
  deps: GovLoopDeps,
): Promise<void> {
  const groupDir = path.join(GROUPS_DIR, group.folder);
  fs.mkdirSync(groupDir, { recursive: true });

  const isMain = group.folder === MAIN_GROUP_FOLDER;
  const sessions = deps.getSessions();
  const sessionId = sessions[group.folder];
  const prompt = buildGovTaskPrompt(task);

  // Write snapshots before spawn
  writeGovSnapshot(group.folder, isMain);
  writeExtCapabilitiesSnapshot(group.folder, isMain);
  ensureIpcGroupSecret(group.folder);
  const scheduledTasks = getAllTasks();
  writeTasksSnapshot(
    group.folder,
    isMain,
    scheduledTasks.map((t) => ({
      id: t.id,
      groupFolder: t.group_folder,
      prompt: t.prompt,
      schedule_type: t.schedule_type,
      schedule_value: t.schedule_value,
      status: t.status,
      next_run: t.next_run,
    })),
  );

  // Idle timer
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  const resetIdleTimer = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      logger.debug({ taskId: task.id }, 'Gov task idle timeout');
      deps.queue.closeStdin(groupJid);
    }, IDLE_TIMEOUT);
  };

  try {
    await runContainerAgent(
      group,
      {
        prompt,
        sessionId,
        groupFolder: group.folder,
        chatJid: groupJid,
        isMain,
        isScheduledTask: true,
      },
      (proc, containerName) =>
        deps.onProcess(groupJid, proc, containerName, group.folder),
      async (output: ContainerOutput) => {
        if (output.result) {
          await deps.sendMessage(groupJid, output.result);
          resetIdleTimer();
        }
      },
    );
  } finally {
    if (idleTimer) clearTimeout(idleTimer);
  }
}

async function runGovApprovalTask(
  task: GovTask,
  gate: string,
  group: RegisteredGroup,
  groupJid: string,
  deps: GovLoopDeps,
): Promise<void> {
  const groupDir = path.join(GROUPS_DIR, group.folder);
  fs.mkdirSync(groupDir, { recursive: true });

  const isMain = group.folder === MAIN_GROUP_FOLDER;
  const sessions = deps.getSessions();
  const sessionId = sessions[group.folder];

  // Re-read task for latest version (may have been updated since dispatch)
  const currentTask = getGovTaskById(task.id);
  const prompt = buildApprovalPrompt(currentTask || task, gate);

  writeGovSnapshot(group.folder, isMain);
  writeExtCapabilitiesSnapshot(group.folder, isMain);
  ensureIpcGroupSecret(group.folder);

  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  const resetIdleTimer = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      logger.debug({ taskId: task.id }, 'Gov approval task idle timeout');
      deps.queue.closeStdin(groupJid);
    }, IDLE_TIMEOUT);
  };

  try {
    await runContainerAgent(
      group,
      {
        prompt,
        sessionId,
        groupFolder: group.folder,
        chatJid: groupJid,
        isMain,
        isScheduledTask: true,
      },
      (proc, containerName) =>
        deps.onProcess(groupJid, proc, containerName, group.folder),
      async (output: ContainerOutput) => {
        if (output.result) {
          await deps.sendMessage(groupJid, output.result);
          resetIdleTimer();
        }
      },
    );
  } finally {
    if (idleTimer) clearTimeout(idleTimer);
  }
}

// --- Snapshot ---

/**
 * Write governance pipeline snapshot for a group's container.
 * Includes task.version for staleness detection (P0-5).
 */
export function writeGovSnapshot(
  groupFolder: string,
  isMain: boolean,
): void {
  const groupIpcDir = path.join(DATA_DIR, 'ipc', groupFolder);
  fs.mkdirSync(groupIpcDir, { recursive: true });

  const allTasks = getAllGovTasks();

  // Main sees all tasks; non-main sees only assigned tasks
  const visibleTasks = isMain
    ? allTasks
    : allTasks.filter((t) => t.assigned_group === groupFolder);

  const snapshot = {
    generatedAt: new Date().toISOString(),
    tasks: visibleTasks.map((t) => ({
      id: t.id,
      title: t.title,
      description: t.description,
      task_type: t.task_type,
      state: t.state,
      priority: t.priority,
      product: t.product,
      assigned_group: t.assigned_group,
      executor: t.executor,
      gate: t.gate,
      version: t.version,
      created_at: t.created_at,
      updated_at: t.updated_at,
    })),
  };

  const snapshotFile = path.join(groupIpcDir, 'gov_pipeline.json');
  const tempPath = `${snapshotFile}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(snapshot, null, 2));
  fs.renameSync(tempPath, snapshotFile);
}

// --- Ext Capabilities Snapshot ---

/**
 * Write ext_capabilities.json snapshot for a group's container.
 * Shows available providers, actions, and the group's access levels.
 */
export function writeExtCapabilitiesSnapshot(
  groupFolder: string,
  _isMain: boolean,
): void {
  const groupIpcDir = path.join(DATA_DIR, 'ipc', groupFolder);
  fs.mkdirSync(groupIpcDir, { recursive: true });

  const caps = getAllActiveCapabilities().filter(
    (c) => c.group_folder === groupFolder,
  );

  const capabilities = caps.map((cap) => {
    const catalog = getProviderActionCatalog(cap.provider) || {};
    const denied: string[] = cap.denied_actions ? JSON.parse(cap.denied_actions) : [];

    // Annotate actions: show level, mark denied
    const actions: Record<string, { level: number; description: string; status: string }> = {};
    for (const [name, info] of Object.entries(catalog)) {
      let status = 'available';
      if (info.level > cap.access_level) status = 'requires_higher_level';
      if (denied.includes(name)) status = 'DENIED';
      actions[name] = { level: info.level, description: info.description, status };
    }

    return {
      provider: cap.provider,
      access_level: cap.access_level,
      allowed_actions: cap.allowed_actions ? JSON.parse(cap.allowed_actions) : null,
      denied_actions: denied.length > 0 ? denied : null,
      expires_at: cap.expires_at,
      actions,
    };
  });

  const snapshot = {
    generatedAt: new Date().toISOString(),
    capabilities,
    providers_available: getAllProviderNames(),
  };

  const snapshotFile = path.join(groupIpcDir, 'ext_capabilities.json');
  const tempPath = `${snapshotFile}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(snapshot, null, 2));
  fs.renameSync(tempPath, snapshotFile);
}

/**
 * P0-7: Ensure IPC group secret exists for request signing.
 * Generated once per group, stored at ipc/{groupFolder}/.ipc_secret.
 */
export function ensureIpcGroupSecret(groupFolder: string): void {
  const secretPath = path.join(DATA_DIR, 'ipc', groupFolder, '.ipc_secret');
  if (fs.existsSync(secretPath)) return;

  const dir = path.dirname(secretPath);
  fs.mkdirSync(dir, { recursive: true });

  const secret = crypto.randomBytes(32).toString('hex');
  const tempPath = `${secretPath}.tmp`;
  fs.writeFileSync(tempPath, secret);
  fs.renameSync(tempPath, secretPath);
}

// --- Helpers ---

function resolveGroupJid(
  groupFolder: string,
  deps: GovLoopDeps,
): string | null {
  const groups = deps.registeredGroups();
  const entry = Object.entries(groups).find(
    ([, g]) => g.folder === groupFolder,
  );
  return entry ? entry[0] : null;
}
