/**
 * Write action endpoints for the cockpit.
 * Dual-secret auth (X-OS-SECRET + X-WRITE-SECRET), fail-closed.
 * Attached to the same HTTP server as ops-http.ts via routeWriteAction().
 */
import http from 'http';

import {
  archiveCockpitTopic,
  createCockpitTopic,
  getCockpitTopicById,
  getCockpitTopics,
  getDb,
  storeChatMetadata,
  storeMessageDirect,
  updateTopicActivity,
  updateTopicTitle,
} from './db.js';
import {
  createNotification,
  getGovApprovals,
  getGovTaskById,
  logGovActivity,
  markNotificationsRead,
  updateGovTask,
} from './gov-db.js';
import { processGovIpc } from './gov-ipc.js';
import { enforceCockpitLimits } from './limits/enforce.js';
import { logger } from './logger.js';
import { emitOpsEvent } from './ops-events.js';

function json(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'X-OS-SECRET, X-WRITE-SECRET, Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  });
  res.end(JSON.stringify(body));
}

function authenticateWrite(req: http.IncomingMessage): boolean {
  const readSecret = process.env.OS_HTTP_SECRET || '';
  // Dual-secret rotation: accept CURRENT or PREVIOUS
  const writeCurrent = process.env.COCKPIT_WRITE_SECRET_CURRENT
    || process.env.COCKPIT_WRITE_SECRET || '';
  const writePrevious = process.env.COCKPIT_WRITE_SECRET_PREVIOUS || '';

  if (!readSecret || !writeCurrent) return false; // fail-closed

  if (req.headers['x-os-secret'] !== readSecret) return false;

  const provided = req.headers['x-write-secret'] as string | undefined;
  if (!provided) return false;

  return provided === writeCurrent || (!!writePrevious && provided === writePrevious);
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function parseUrl(url: string): string {
  return new URL(url, 'http://localhost').pathname;
}

// --- Constants ---

const VALID_TASK_TYPES = [
  'EPIC', 'FEATURE', 'BUG', 'SECURITY', 'REVOPS',
  'OPS', 'RESEARCH', 'CONTENT', 'DOC', 'INCIDENT',
] as const;

const VALID_PRIORITIES = ['P0', 'P1', 'P2', 'P3'] as const;
const VALID_GATES = ['None', 'Security', 'RevOps', 'Claims', 'Product'] as const;
const VALID_SCOPES = ['COMPANY', 'PRODUCT'] as const;

// --- Handlers ---

async function handleActionCreate(
  body: Record<string, unknown>,
  res: http.ServerResponse,
): Promise<void> {
  const { title, task_type, priority, description, product_id, gate, scope, assigned_group, metadata } = body;

  // Required fields
  if (!title || typeof title !== 'string') {
    json(res, 400, { error: 'Missing required field: title' });
    return;
  }
  if (title.length > 140) {
    json(res, 400, { error: 'title exceeds 140 characters' });
    return;
  }
  if (!task_type || !VALID_TASK_TYPES.includes(task_type as typeof VALID_TASK_TYPES[number])) {
    json(res, 400, { error: `Invalid task_type. Must be one of: ${VALID_TASK_TYPES.join(', ')}` });
    return;
  }

  // Optional enums with defaults
  const effectivePriority = (priority as string) || 'P2';
  if (!VALID_PRIORITIES.includes(effectivePriority as typeof VALID_PRIORITIES[number])) {
    json(res, 400, { error: `Invalid priority. Must be one of: ${VALID_PRIORITIES.join(', ')}` });
    return;
  }
  const effectiveGate = (gate as string) || 'None';
  if (!VALID_GATES.includes(effectiveGate as typeof VALID_GATES[number])) {
    json(res, 400, { error: `Invalid gate. Must be one of: ${VALID_GATES.join(', ')}` });
    return;
  }
  const effectiveScope = (scope as string) || 'PRODUCT';
  if (!VALID_SCOPES.includes(effectiveScope as typeof VALID_SCOPES[number])) {
    json(res, 400, { error: `Invalid scope. Must be one of: ${VALID_SCOPES.join(', ')}` });
    return;
  }

  // Scope / product_id rules
  if (effectiveScope === 'PRODUCT' && !product_id) {
    json(res, 400, { error: 'product_id is required when scope is PRODUCT' });
    return;
  }
  const effectiveProductId = effectiveScope === 'COMPANY' ? null : (product_id as string);

  // Optional metadata — must be object, capped at 8 KB serialized
  let effectiveMetadata: Record<string, unknown> | undefined;
  if (metadata !== undefined && metadata !== null) {
    if (typeof metadata !== 'object' || Array.isArray(metadata)) {
      json(res, 400, { error: 'metadata must be a JSON object' });
      return;
    }
    const serialized = JSON.stringify(metadata);
    if (serialized.length > 8192) {
      json(res, 400, { error: 'metadata exceeds 8192 bytes' });
      return;
    }
    effectiveMetadata = metadata as Record<string, unknown>;
  }

  // Generate taskId: gov-<UTC_YYYYMMDDTHHMMSSZ>-<rand6>
  const now = new Date();
  const ts = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const rand = Math.random().toString(36).slice(2, 8);
  const taskId = `gov-${ts}-${rand}`;

  await processGovIpc(
    {
      type: 'gov_create',
      id: taskId,
      title: title as string,
      description: (description as string) || undefined,
      task_type: task_type as string,
      priority: effectivePriority,
      gate: effectiveGate,
      scope: effectiveScope,
      product_id: effectiveProductId || undefined,
      assigned_group: (assigned_group as string) || undefined,
      metadata: effectiveMetadata,
    },
    'cockpit',
    true,
  );

  // Verify creation — processGovIpc doesn't return errors
  const created = getGovTaskById(taskId);
  if (!created) {
    json(res, 500, { error: 'Task creation failed (validation error in governance kernel)' });
    return;
  }

  json(res, 201, { ok: true, taskId, state: created.state });
}

async function handleActionTransition(
  body: Record<string, unknown>,
  res: http.ServerResponse,
): Promise<void> {
  const { taskId, toState, reason, expectedVersion } = body;
  if (!taskId || !toState) {
    json(res, 400, { error: 'Missing required fields: taskId, toState' });
    return;
  }

  const task = getGovTaskById(taskId as string);
  if (!task) {
    json(res, 404, { error: 'Task not found' });
    return;
  }

  const fromState = task.state;
  const prevVersion = task.version;

  await processGovIpc(
    {
      type: 'gov_transition',
      taskId: taskId as string,
      toState: toState as string,
      reason: (reason as string) || undefined,
      expectedVersion: expectedVersion !== undefined ? Number(expectedVersion) : undefined,
    },
    'main',
    true,
  );

  // Verify outcome — processGovIpc doesn't return errors
  const updated = getGovTaskById(taskId as string);
  if (!updated || updated.state !== toState) {
    json(res, 409, {
      error: 'Transition failed',
      current_state: updated?.state || fromState,
      current_version: updated?.version || prevVersion,
    });
    return;
  }

  json(res, 200, {
    ok: true,
    taskId,
    from: fromState,
    to: toState,
    version: updated.version,
  });
}

async function handleActionApprove(
  body: Record<string, unknown>,
  res: http.ServerResponse,
): Promise<void> {
  const { taskId, gate_type, notes } = body;
  if (!taskId || !gate_type) {
    json(res, 400, { error: 'Missing required fields: taskId, gate_type' });
    return;
  }

  const task = getGovTaskById(taskId as string);
  if (!task) {
    json(res, 404, { error: 'Task not found' });
    return;
  }
  if (task.state !== 'APPROVAL') {
    json(res, 409, { error: 'Task not in APPROVAL state', current_state: task.state });
    return;
  }

  const approvalsBefore = getGovApprovals(taskId as string);
  const alreadyApproved = approvalsBefore.some(
    (a) => a.gate_type === gate_type,
  );

  await processGovIpc(
    {
      type: 'gov_approve',
      taskId: taskId as string,
      gate_type: gate_type as string,
      notes: (notes as string) || undefined,
    },
    'main',
    true,
  );

  // Verify approval recorded
  const approvalsAfter = getGovApprovals(taskId as string);
  const wasRecorded = approvalsAfter.some(
    (a) => a.gate_type === gate_type,
  );

  if (!wasRecorded && !alreadyApproved) {
    json(res, 409, { error: 'Approval failed' });
    return;
  }

  json(res, 200, { ok: true, taskId, gate_type });
}

async function handleActionOverride(
  body: Record<string, unknown>,
  res: http.ServerResponse,
): Promise<void> {
  const { taskId, reason, acceptedRisk, reviewDeadlineIso } = body;
  if (!taskId || !reason || !acceptedRisk || !reviewDeadlineIso) {
    json(res, 400, {
      error: 'Missing required fields: taskId, reason, acceptedRisk, reviewDeadlineIso',
    });
    return;
  }

  const task = getGovTaskById(taskId as string);
  if (!task) {
    json(res, 404, { error: 'Task not found' });
    return;
  }

  // Only REVIEW or APPROVAL can be overridden
  if (task.state !== 'REVIEW' && task.state !== 'APPROVAL') {
    json(res, 409, {
      error: 'Override only allowed from REVIEW or APPROVAL state',
      current_state: task.state,
    });
    return;
  }

  const fromState = task.state;
  const now = new Date().toISOString();

  // Merge override into existing metadata
  let existingMeta: Record<string, unknown> = {};
  try {
    if (task.metadata) existingMeta = JSON.parse(task.metadata);
  } catch { /* ignore */ }

  const metadata = JSON.stringify({
    ...existingMeta,
    override: {
      used: true,
      by: 'founder',
      reason,
      acceptedRisk,
      reviewDeadlineIso,
      timestamp: now,
    },
  });

  // Atomic: set state + metadata in one optimistic-locked call
  const updated = updateGovTask(taskId as string, task.version, {
    state: 'DONE',
    metadata,
  });

  if (!updated) {
    json(res, 409, {
      error: 'Version conflict (concurrent update)',
      current_version: task.version,
    });
    return;
  }

  // Log both override and transition activities
  logGovActivity({
    task_id: taskId as string,
    action: 'override',
    from_state: fromState,
    to_state: 'DONE',
    actor: 'founder',
    reason: reason as string,
    created_at: now,
  });
  logGovActivity({
    task_id: taskId as string,
    action: 'transition',
    from_state: fromState,
    to_state: 'DONE',
    actor: 'founder',
    reason: null,
    created_at: now,
  });

  logger.info(
    { taskId, from: fromState, to: 'DONE', override: true },
    'Founder override applied',
  );

  json(res, 200, {
    ok: true,
    taskId,
    from: fromState,
    to: 'DONE',
    override: true,
  });
}

// --- Sprint 10B: DoD / Evidence / DocsUpdated handlers ---

const MAX_METADATA_BYTES = 8192;

/** Helper: read + parse existing metadata from a task, fail-closed. */
function parseTaskMetadata(task: { metadata: string | null }): Record<string, unknown> {
  if (!task.metadata) return {};
  try {
    return JSON.parse(task.metadata);
  } catch {
    return {};
  }
}

/** Generate a short stable ID for a DoD item: dod-<random6>. */
function generateDodItemId(): string {
  return 'dod-' + Math.random().toString(36).slice(2, 8);
}

/** Simple hash of a string list for low-noise audit (no raw text in activity). */
function hashDodItems(items: { id: string; done: boolean }[]): string {
  // Lightweight fingerprint: id:done pairs joined, then simple numeric hash
  const input = items.map((i) => `${i.id}:${i.done ? '1' : '0'}`).join('|');
  let h = 0;
  for (let i = 0; i < input.length; i++) {
    h = ((h << 5) - h + input.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(36);
}

async function handleActionUpdateDoD(
  body: Record<string, unknown>,
  res: http.ServerResponse,
): Promise<void> {
  const { taskId, dodChecklist } = body;
  if (!taskId || typeof taskId !== 'string') {
    json(res, 400, { error: 'Missing required field: taskId' });
    return;
  }
  if (!Array.isArray(dodChecklist)) {
    json(res, 400, { error: 'dodChecklist must be an array' });
    return;
  }
  if (dodChecklist.length > 50) {
    json(res, 400, { error: 'dodChecklist exceeds 50 items' });
    return;
  }

  // Validate + normalize each item: { id?: string, text: string, done: boolean }
  const normalized: { id: string; text: string; done: boolean }[] = [];
  for (let i = 0; i < dodChecklist.length; i++) {
    const item = dodChecklist[i];
    if (
      !item ||
      typeof item !== 'object' ||
      typeof item.text !== 'string' ||
      typeof item.done !== 'boolean'
    ) {
      json(res, 400, { error: `dodChecklist[${i}] must have {text: string, done: boolean}` });
      return;
    }
    const trimmed = item.text.trim();
    if (trimmed.length < 4) {
      json(res, 400, { error: `dodChecklist[${i}].text must be at least 4 characters` });
      return;
    }
    if (trimmed.length > 200) {
      json(res, 400, { error: `dodChecklist[${i}].text exceeds 200 characters` });
      return;
    }
    // Preserve existing stable ID or assign a new one server-side
    const id = (typeof item.id === 'string' && item.id.startsWith('dod-')) ? item.id : generateDodItemId();
    normalized.push({ id, text: trimmed, done: item.done });
  }

  const task = getGovTaskById(taskId);
  if (!task) {
    json(res, 404, { error: 'Task not found' });
    return;
  }

  const existingMeta = parseTaskMetadata(task);
  const newMeta = {
    ...existingMeta,
    dodChecklist: normalized.map((i) => i.text),
    dodStatus: normalized.map((i) => ({ id: i.id, text: i.text, done: i.done })),
  };
  const serialized = JSON.stringify(newMeta);
  if (serialized.length > MAX_METADATA_BYTES) {
    json(res, 400, { error: `metadata exceeds ${MAX_METADATA_BYTES} bytes after update` });
    return;
  }

  const updated = updateGovTask(taskId, task.version, { metadata: serialized });
  if (!updated) {
    json(res, 409, { error: 'Version conflict (concurrent update)', current_version: task.version });
    return;
  }

  const now = new Date().toISOString();
  const doneCount = normalized.filter((i) => i.done).length;
  const hash = hashDodItems(normalized);
  logGovActivity({
    task_id: taskId,
    action: 'DOD_UPDATED',
    from_state: task.state,
    to_state: null,
    actor: 'cockpit',
    reason: `${doneCount}/${normalized.length} done h:${hash}`,
    created_at: now,
  });

  json(res, 200, { ok: true, taskId, version: task.version + 1 });
}

async function handleActionAddEvidence(
  body: Record<string, unknown>,
  res: http.ServerResponse,
): Promise<void> {
  const { taskId, link, note } = body;
  if (!taskId || typeof taskId !== 'string') {
    json(res, 400, { error: 'Missing required field: taskId' });
    return;
  }
  if (!link || typeof link !== 'string') {
    json(res, 400, { error: 'Missing required field: link' });
    return;
  }
  if (link.length > 2000) {
    json(res, 400, { error: 'link exceeds 2000 characters' });
    return;
  }
  const effectiveNote = (note && typeof note === 'string') ? note : '';
  if (effectiveNote.length > 1000) {
    json(res, 400, { error: 'note exceeds 1000 characters' });
    return;
  }

  const task = getGovTaskById(taskId);
  if (!task) {
    json(res, 404, { error: 'Task not found' });
    return;
  }

  const existingMeta = parseTaskMetadata(task);
  const evidence = Array.isArray(existingMeta.evidence) ? existingMeta.evidence : [];
  const now = new Date().toISOString();
  evidence.push({ link, note: effectiveNote, addedAt: now });

  if (evidence.length > 100) {
    json(res, 400, { error: 'Evidence list exceeds 100 entries' });
    return;
  }

  const newMeta = { ...existingMeta, evidence };
  const serialized = JSON.stringify(newMeta);
  if (serialized.length > MAX_METADATA_BYTES) {
    json(res, 400, { error: `metadata exceeds ${MAX_METADATA_BYTES} bytes after update` });
    return;
  }

  const updated = updateGovTask(taskId, task.version, { metadata: serialized });
  if (!updated) {
    json(res, 409, { error: 'Version conflict (concurrent update)', current_version: task.version });
    return;
  }

  logGovActivity({
    task_id: taskId,
    action: 'EVIDENCE_ADDED',
    from_state: task.state,
    to_state: null,
    actor: 'cockpit',
    reason: `${link}${effectiveNote ? ' — ' + effectiveNote : ''}`,
    created_at: now,
  });

  json(res, 200, { ok: true, taskId, version: task.version + 1, evidenceCount: evidence.length });
}

async function handleActionAddEvidenceBulk(
  body: Record<string, unknown>,
  res: http.ServerResponse,
): Promise<void> {
  const { taskId, links, note } = body;
  if (!taskId || typeof taskId !== 'string') {
    json(res, 400, { error: 'Missing required field: taskId' });
    return;
  }
  if (!Array.isArray(links)) {
    json(res, 400, { error: 'links must be an array' });
    return;
  }
  if (links.length === 0) {
    json(res, 400, { error: 'links must not be empty' });
    return;
  }
  if (links.length > 20) {
    json(res, 400, { error: 'links exceeds 20 items' });
    return;
  }

  for (let i = 0; i < links.length; i++) {
    if (typeof links[i] !== 'string') {
      json(res, 400, { error: `links[${i}] must be a string` });
      return;
    }
    if (links[i].length > 2000) {
      json(res, 400, { error: `links[${i}] exceeds 2000 characters` });
      return;
    }
    try {
      const url = new URL(links[i]);
      const allowHttp = process.env.NODE_ENV !== 'production';
      if (url.protocol !== 'https:' && !(allowHttp && url.protocol === 'http:')) {
        json(res, 400, { error: `links[${i}] must use https` });
        return;
      }
    } catch {
      json(res, 400, { error: `links[${i}] is not a valid URL` });
      return;
    }
  }

  const effectiveNote = (note && typeof note === 'string') ? note : '';
  if (effectiveNote.length > 1000) {
    json(res, 400, { error: 'note exceeds 1000 characters' });
    return;
  }

  const task = getGovTaskById(taskId);
  if (!task) {
    json(res, 404, { error: 'Task not found' });
    return;
  }

  const existingMeta = parseTaskMetadata(task);
  const evidence = Array.isArray(existingMeta.evidence) ? [...(existingMeta.evidence as unknown[])] : [];
  const now = new Date().toISOString();

  for (const link of links) {
    evidence.push({ link, note: effectiveNote, addedAt: now });
  }

  if (evidence.length > 100) {
    json(res, 400, { error: 'Evidence list would exceed 100 entries' });
    return;
  }

  const newMeta = { ...existingMeta, evidence };
  const serialized = JSON.stringify(newMeta);
  if (serialized.length > MAX_METADATA_BYTES) {
    json(res, 400, { error: `metadata exceeds ${MAX_METADATA_BYTES} bytes after update` });
    return;
  }

  const updated = updateGovTask(taskId, task.version, { metadata: serialized });
  if (!updated) {
    json(res, 409, { error: 'Version conflict (concurrent update)', current_version: task.version });
    return;
  }

  logGovActivity({
    task_id: taskId,
    action: 'EVIDENCE_BULK_ADDED',
    from_state: task.state,
    to_state: null,
    actor: 'cockpit',
    reason: `${links.length} links added${effectiveNote ? ' — ' + effectiveNote : ''}`,
    created_at: now,
  });

  json(res, 200, { ok: true, taskId, version: task.version + 1, addedCount: links.length, evidenceCount: evidence.length });
}

async function handleActionSetDocsUpdated(
  body: Record<string, unknown>,
  res: http.ServerResponse,
): Promise<void> {
  const { taskId, docsUpdated } = body;
  if (!taskId || typeof taskId !== 'string') {
    json(res, 400, { error: 'Missing required field: taskId' });
    return;
  }
  if (typeof docsUpdated !== 'boolean') {
    json(res, 400, { error: 'docsUpdated must be a boolean' });
    return;
  }

  const task = getGovTaskById(taskId);
  if (!task) {
    json(res, 404, { error: 'Task not found' });
    return;
  }

  const existingMeta = parseTaskMetadata(task);
  const newMeta = { ...existingMeta, docsUpdated };
  const serialized = JSON.stringify(newMeta);

  const updated = updateGovTask(taskId, task.version, { metadata: serialized });
  if (!updated) {
    json(res, 409, { error: 'Version conflict (concurrent update)', current_version: task.version });
    return;
  }

  const now = new Date().toISOString();
  logGovActivity({
    task_id: taskId,
    action: 'DOCS_UPDATED_SET',
    from_state: task.state,
    to_state: null,
    actor: 'cockpit',
    reason: docsUpdated ? 'Docs marked as updated' : 'Docs marked as not updated',
    created_at: now,
  });

  json(res, 200, { ok: true, taskId, version: task.version + 1 });
}

async function handleActionChat(
  body: Record<string, unknown>,
  res: http.ServerResponse,
): Promise<void> {
  const { message, topic_id, group } = body;

  if (!message || typeof message !== 'string') {
    json(res, 400, { error: 'Missing required field: message' });
    return;
  }
  if (message.length > 4000) {
    json(res, 400, { error: 'message exceeds 4000 characters' });
    return;
  }

  const groupFolder = (typeof group === 'string' && group) ? group : 'main';
  const rand = Math.random().toString(36).slice(2, 8);
  const now = new Date().toISOString();

  // If topic_id provided, use it; otherwise auto-create a new topic
  let topicId = typeof topic_id === 'string' ? topic_id : '';
  if (!topicId) {
    topicId = `topic-${Date.now()}-${rand}`;
    createCockpitTopic({
      id: topicId,
      group_folder: groupFolder,
      title: (message as string).slice(0, 60),
    });
    // Create chat entry for the virtual JID so FK constraint is satisfied
    storeChatMetadata(`cockpit:${topicId}`, new Date().toISOString(), (message as string).slice(0, 60));
    logger.info({ topicId, groupFolder }, 'Auto-created cockpit topic');
  } else {
    // Verify topic exists
    const topic = getCockpitTopicById(topicId);
    if (!topic) {
      json(res, 404, { error: 'Topic not found' });
      return;
    }
    // Auto-name the topic from the first real message if still using default title
    if (topic.title === 'New Topic') {
      const newTitle = (message as string).slice(0, 60);
      updateTopicTitle(topicId, newTitle);
    }
  }

  // Virtual JID for this topic
  const virtualJid = `cockpit:${topicId}`;

  storeMessageDirect({
    id: `cockpit-${Date.now()}-${rand}`,
    chat_jid: virtualJid,
    sender: 'cockpit',
    sender_name: 'Owner',
    content: message,
    timestamp: now,
    is_from_me: false,
    is_bot_message: false,
  });

  updateTopicActivity(topicId);

  logger.info({ topicId, groupFolder, virtualJid }, 'Cockpit topic message stored');

  // Notify the message loop via the cockpit message callback
  if (cockpitMessageCallback) {
    cockpitMessageCallback(topicId, groupFolder);
  }

  json(res, 200, { ok: true, topic_id: topicId, queued: true });
}

async function handleActionCreateTopic(
  body: Record<string, unknown>,
  res: http.ServerResponse,
): Promise<void> {
  const { group, title } = body;
  const groupFolder = (typeof group === 'string' && group) ? group : 'main';
  const topicTitle = (typeof title === 'string' && title) ? title : 'New Topic';

  const rand = Math.random().toString(36).slice(2, 8);
  const topicId = `topic-${Date.now()}-${rand}`;

  createCockpitTopic({ id: topicId, group_folder: groupFolder, title: topicTitle });
  storeChatMetadata(`cockpit:${topicId}`, new Date().toISOString(), topicTitle);

  json(res, 200, { ok: true, topic: { id: topicId, group_folder: groupFolder, title: topicTitle } });
}

async function handleActionDeleteTopic(
  body: Record<string, unknown>,
  res: http.ServerResponse,
): Promise<void> {
  const { topic_id } = body;
  if (!topic_id || typeof topic_id !== 'string') {
    json(res, 400, { error: 'Missing required field: topic_id' });
    return;
  }

  const topic = getCockpitTopicById(topic_id);
  if (!topic) {
    json(res, 404, { error: 'Topic not found' });
    return;
  }

  archiveCockpitTopic(topic_id);
  logger.info({ topicId: topic_id }, 'Topic archived');
  json(res, 200, { ok: true });
}

// Callback for notifying the message loop about new cockpit messages
let cockpitMessageCallback: ((topicId: string, groupFolder: string) => void) | null = null;

export function setCockpitMessageCallback(
  cb: (topicId: string, groupFolder: string) => void,
): void {
  cockpitMessageCallback = cb;
}

// --- Sprint 10E: Comment + Notifications handlers ---

const VALID_MENTION_GROUPS = ['main', 'developer', 'security', 'revops', 'product'] as const;
const MENTION_REGEX = /@(main|developer|security|revops|product)\b/g;

async function handleActionAddComment(
  body: Record<string, unknown>,
  res: http.ServerResponse,
): Promise<void> {
  const { taskId, text, actor } = body;
  if (!taskId || typeof taskId !== 'string') {
    json(res, 400, { error: 'Missing required field: taskId' });
    return;
  }
  if (!text || typeof text !== 'string') {
    json(res, 400, { error: 'Missing required field: text' });
    return;
  }

  // Sanitize: strip HTML tags, trim
  const sanitized = text.replace(/<[^>]*>/g, '').trim();
  if (sanitized.length === 0) {
    json(res, 400, { error: 'text must not be empty after sanitization' });
    return;
  }
  if (sanitized.length > 4000) {
    json(res, 400, { error: 'text exceeds 4000 characters' });
    return;
  }

  const effectiveActor = (actor && typeof actor === 'string' && actor.length <= 50)
    ? actor : 'cockpit';

  const task = getGovTaskById(taskId);
  if (!task) {
    json(res, 404, { error: 'Task not found' });
    return;
  }

  const now = new Date().toISOString();

  // Log activity
  logGovActivity({
    task_id: taskId,
    action: 'COMMENT_ADDED',
    from_state: task.state,
    to_state: null,
    actor: effectiveActor,
    reason: sanitized.slice(0, 4000),
    created_at: now,
  });

  // Parse @mentions
  const mentions = new Set<string>();
  let match: RegExpExecArray | null;
  while ((match = MENTION_REGEX.exec(sanitized)) !== null) {
    mentions.add(match[1]);
  }

  const mentionedGroups = [...mentions];
  const snippet = sanitized.slice(0, 200);

  for (const group of mentionedGroups) {
    createNotification({
      task_id: taskId,
      target_group: group,
      actor: effectiveActor,
      snippet,
      created_at: now,
    });
  }

  if (mentionedGroups.length > 0) {
    emitOpsEvent('notification:created', { taskId, mentionedGroups });
  }

  json(res, 200, { ok: true, taskId, mentions: mentionedGroups });
}

async function handleActionMarkNotificationsRead(
  body: Record<string, unknown>,
  res: http.ServerResponse,
): Promise<void> {
  const { ids } = body;
  if (!Array.isArray(ids)) {
    json(res, 400, { error: 'ids must be an array' });
    return;
  }
  if (ids.length === 0) {
    json(res, 400, { error: 'ids must not be empty' });
    return;
  }
  if (ids.length > 100) {
    json(res, 400, { error: 'ids exceeds 100 items' });
    return;
  }
  for (let i = 0; i < ids.length; i++) {
    if (typeof ids[i] !== 'number') {
      json(res, 400, { error: `ids[${i}] must be a number` });
      return;
    }
  }

  const markedCount = markNotificationsRead(ids as number[]);
  json(res, 200, { ok: true, markedCount });
}

// --- Router ---

export async function routeWriteAction(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  const pathname = parseUrl(req.url || '/');

  if (!authenticateWrite(req)) {
    json(res, 401, { error: 'Unauthorized' });
    return;
  }

  // Rate limit cockpit writes
  const sourceIp = (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim()
    || req.socket.remoteAddress || 'unknown';
  const limitResult = enforceCockpitLimits('cockpit_write', sourceIp);
  if (!limitResult.allowed) {
    json(res, 429, { error: 'Rate limit exceeded', detail: limitResult.detail });
    return;
  }

  let body: Record<string, unknown>;
  try {
    const raw = await readBody(req);
    body = JSON.parse(raw);
  } catch {
    json(res, 400, { error: 'Invalid JSON body' });
    return;
  }

  switch (pathname) {
    case '/ops/actions/create':
      return handleActionCreate(body, res);
    case '/ops/actions/transition':
      return handleActionTransition(body, res);
    case '/ops/actions/approve':
      return handleActionApprove(body, res);
    case '/ops/actions/override':
      return handleActionOverride(body, res);
    case '/ops/actions/chat':
      return handleActionChat(body, res);
    case '/ops/actions/topic':
      return handleActionCreateTopic(body, res);
    case '/ops/actions/topic/delete':
      return handleActionDeleteTopic(body, res);
    case '/ops/actions/dod':
      return handleActionUpdateDoD(body, res);
    case '/ops/actions/evidence':
      return handleActionAddEvidence(body, res);
    case '/ops/actions/evidence/bulk':
      return handleActionAddEvidenceBulk(body, res);
    case '/ops/actions/docsUpdated':
      return handleActionSetDocsUpdated(body, res);
    case '/ops/actions/comment':
      return handleActionAddComment(body, res);
    case '/ops/actions/notifications/markRead':
      return handleActionMarkNotificationsRead(body, res);
    default:
      json(res, 404, { error: 'Not found' });
  }
}
