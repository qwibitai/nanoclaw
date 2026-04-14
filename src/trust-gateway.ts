/**
 * Trust Gateway HTTP Server
 *
 * Containers call this before executing write/transact operations.
 * Evaluates trust via the trust engine, auto-approves high-confidence actions,
 * and creates pending approvals for low-confidence ones.
 *
 * Endpoints:
 *   POST /trust/evaluate  — evaluate whether an action can auto-execute
 *   GET  /trust/approval/:id — poll for approval resolution
 *   GET  /trust/status — debug: dump trust levels for a group
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'http';
import { randomUUID } from 'crypto';
import {
  evaluateTrust,
  classifyTool,
  recordTrustDecision,
} from './trust-engine.js';
import {
  insertTrustApproval,
  getTrustApproval,
  resolveTrustApproval,
  getExpiredTrustApprovals,
  getAllTrustLevels,
  type TrustApproval,
} from './db.js';
import { eventBus } from './event-bus.js';
import { logger } from './logger.js';
import type {
  TrustRequestEvent,
  TrustApprovedEvent,
  TrustDeniedEvent,
  VerifyFailedEvent,
} from './events.js';

const APPROVAL_TIMEOUT_S = 1800; // 30 minutes
const TIMEOUT_CHECK_INTERVAL_MS = 30_000; // check every 30s

/** Read the full request body as a string. */
function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString()));
    req.on('error', reject);
  });
}

/** Send a JSON response. */
function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

/** Parse URL query string into a simple key-value map. */
function parseQuery(url: string): Record<string, string> {
  const idx = url.indexOf('?');
  if (idx < 0) return {};
  const params = new URLSearchParams(url.slice(idx));
  const result: Record<string, string> = {};
  for (const [k, v] of params) result[k] = v;
  return result;
}

/** Check for expired pending approvals and resolve them as timeout. */
export function checkExpiredApprovals(): void {
  const expired = getExpiredTrustApprovals();
  for (const approval of expired) {
    resolveTrustApproval(approval.id, 'timeout');
    logger.info(
      { approvalId: approval.id, actionClass: approval.action_class },
      'Trust approval expired',
    );

    const deniedEvent: TrustDeniedEvent = {
      type: 'trust.denied',
      source: 'trust-gateway',
      groupId: approval.group_id,
      timestamp: Date.now(),
      payload: {
        approvalId: approval.id,
        actionClass: approval.action_class,
        toolName: approval.tool_name,
        groupId: approval.group_id,
        reason: 'timeout',
      },
    };
    eventBus.emit('trust.denied', deniedEvent);
  }
}

/**
 * Resolve a pending approval (called by the approval handler when a user
 * replies "yes"/"no" in chat). Returns true if the approval existed and was
 * still pending.
 */
export function resolveApproval(
  approvalId: string,
  decision: 'approved' | 'denied',
): boolean {
  const approval = getTrustApproval(approvalId);
  if (!approval || approval.status !== 'pending') return false;

  resolveTrustApproval(approvalId, decision);
  recordTrustDecision(
    approval.tool_name,
    approval.group_id,
    decision,
    approval.description,
  );

  if (decision === 'approved') {
    const approvedEvent: TrustApprovedEvent = {
      type: 'trust.approved',
      source: 'trust-gateway',
      groupId: approval.group_id,
      timestamp: Date.now(),
      payload: {
        approvalId,
        actionClass: approval.action_class,
        toolName: approval.tool_name,
        groupId: approval.group_id,
        auto: false,
      },
    };
    eventBus.emit('trust.approved', approvedEvent);
  } else {
    const deniedEvent: TrustDeniedEvent = {
      type: 'trust.denied',
      source: 'trust-gateway',
      groupId: approval.group_id,
      timestamp: Date.now(),
      payload: {
        approvalId,
        actionClass: approval.action_class,
        toolName: approval.tool_name,
        groupId: approval.group_id,
        reason: 'user_denied',
      },
    };
    eventBus.emit('trust.denied', deniedEvent);
  }

  logger.info(
    { approvalId, decision, actionClass: approval.action_class },
    'Trust approval resolved',
  );
  return true;
}

/**
 * Rule-based pre-action intent validation (v1).
 *
 * Checks that the action's tool name is plausibly consistent with the
 * description. Returns null if validation passes, or a string reason
 * if it fails.
 *
 * This is intentionally lightweight — no LLM call. The goal is to catch
 * obvious mismatches (e.g. a "write email" description paired with a
 * "delete_file" tool) without adding latency.
 *
 * LLM-based validation (Haiku cross-check) is deferred to a later plan.
 */
function validateActionIntent(
  toolName: string,
  description: string | undefined,
): string | null {
  if (!description) return null; // no description to check against

  const desc = description.toLowerCase();
  const tool = toolName.toLowerCase();

  // Destructive tools should not appear with purely read-intent descriptions
  const destructiveTools = ['delete', 'remove', 'drop', 'truncate', 'wipe'];
  const readOnlyDescriptions = [
    'read',
    'fetch',
    'list',
    'get',
    'search',
    'find',
    'check',
    'view',
  ];

  const toolIsDestructive = destructiveTools.some((d) => tool.includes(d));
  const descIsReadOnly =
    readOnlyDescriptions.some(
      (r) => desc.startsWith(r) || desc.includes(`to ${r}`),
    ) && !destructiveTools.some((d) => desc.includes(d));

  if (toolIsDestructive && descIsReadOnly) {
    return `tool "${toolName}" appears destructive but description implies read-only: "${description}"`;
  }

  return null;
}

/** Handle POST /trust/evaluate */
async function handleEvaluate(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const raw = await readBody(req);
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(raw);
  } catch {
    json(res, 400, { error: 'Invalid JSON' });
    return;
  }

  const { tool_name, description, group_id, chat_jid, action_class } = body as {
    tool_name?: string;
    description?: string;
    group_id?: string;
    chat_jid?: string;
    action_class?: string;
  };

  // Validate required fields
  if (!tool_name || !group_id || !chat_jid) {
    json(res, 400, {
      error: 'Missing required fields: tool_name, group_id, chat_jid',
    });
    return;
  }

  const toolName = String(tool_name);
  const groupId = String(group_id);
  const chatJid = String(chat_jid);
  const desc = description ? String(description) : undefined;
  const selfClass = action_class ? String(action_class) : undefined;

  // Pre-action intent validation (v1: rule-based)
  const intentMismatch = validateActionIntent(toolName, desc);
  if (intentMismatch) {
    logger.warn(
      { toolName, groupId, reason: intentMismatch },
      'Intent mismatch detected',
    );
    const failedEvent: VerifyFailedEvent = {
      type: 'verify.failed',
      source: 'trust-gateway',
      groupId,
      timestamp: Date.now(),
      payload: {
        taskId: '',
        groupId,
        toolName,
        reason: intentMismatch,
      },
    };
    eventBus.emit('verify.failed', failedEvent);
    // Log the mismatch but do not block — trust evaluation proceeds normally.
    // A future plan will optionally reject here or escalate to the user.
  }

  const result = evaluateTrust(toolName, groupId, selfClass);
  const resolvedClass = classifyTool(toolName, selfClass);

  if (result.decision === 'approved') {
    // Auto-approved — log and return immediately
    recordTrustDecision(toolName, groupId, 'approved', desc, selfClass);

    const approvedEvent: TrustApprovedEvent = {
      type: 'trust.approved',
      source: 'trust-gateway',
      groupId,
      timestamp: Date.now(),
      payload: {
        approvalId: '',
        actionClass: resolvedClass,
        toolName,
        groupId,
        auto: true,
      },
    };
    eventBus.emit('trust.approved', approvedEvent);

    logger.info(
      {
        toolName,
        groupId,
        actionClass: resolvedClass,
        confidence: result.confidence,
      },
      'Trust auto-approved',
    );

    json(res, 200, {
      decision: 'approved',
      reason: result.reason,
    });
    return;
  }

  // Needs approval — create a pending approval record
  const approvalId = randomUUID();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + APPROVAL_TIMEOUT_S * 1000);

  const approval: TrustApproval = {
    id: approvalId,
    action_class: resolvedClass,
    tool_name: toolName,
    description: desc,
    group_id: groupId,
    chat_jid: chatJid,
    status: 'pending',
    created_at: now.toISOString(),
    expires_at: expiresAt.toISOString(),
  };

  insertTrustApproval(approval);

  const requestEvent: TrustRequestEvent = {
    type: 'trust.request',
    source: 'trust-gateway',
    groupId,
    timestamp: Date.now(),
    payload: {
      approvalId,
      actionClass: resolvedClass,
      toolName,
      description: desc ?? '',
      groupId,
      chatJid,
      confidence: result.confidence,
      threshold: result.threshold,
    },
  };
  eventBus.emit('trust.request', requestEvent);

  logger.info(
    { approvalId, toolName, groupId, actionClass: resolvedClass },
    'Trust approval requested',
  );

  json(res, 200, {
    decision: 'pending',
    approval_id: approvalId,
    timeout_s: APPROVAL_TIMEOUT_S,
  });
}

/** Handle GET /trust/approval/:id */
function handleApprovalPoll(res: ServerResponse, approvalId: string): void {
  const approval = getTrustApproval(approvalId);

  if (!approval) {
    json(res, 404, { error: 'Approval not found' });
    return;
  }

  json(res, 200, { decision: approval.status });
}

/** Handle GET /trust/status */
function handleStatus(
  res: ServerResponse,
  query: Record<string, string>,
): void {
  const groupId = query.group_id || 'default';
  const levels = getAllTrustLevels(groupId);
  json(res, 200, { levels });
}

/**
 * Start the trust gateway HTTP server.
 * Containers call this to evaluate trust before executing write/transact operations.
 */
export function startTrustGateway(port: number = 10255): { close: () => void } {
  const server = createServer(async (req, res) => {
    const method = req.method ?? '';
    const url = req.url ?? '/';
    const pathname = url.split('?')[0];
    const query = parseQuery(url);

    try {
      // POST /trust/evaluate
      if (method === 'POST' && pathname === '/trust/evaluate') {
        await handleEvaluate(req, res);
        return;
      }

      // GET /trust/approval/:id
      const approvalMatch = pathname.match(/^\/trust\/approval\/(.+)$/);
      if (method === 'GET' && approvalMatch) {
        handleApprovalPoll(res, approvalMatch[1]);
        return;
      }

      // GET /trust/status
      if (method === 'GET' && pathname === '/trust/status') {
        handleStatus(res, query);
        return;
      }

      // 404 for everything else
      json(res, 404, { error: 'Not found' });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ error: message, method, url }, 'Trust gateway error');
      json(res, 500, { error: 'Internal server error' });
    }
  });

  server.listen(port, '0.0.0.0');
  logger.info({ port }, 'Trust gateway started');

  // Background timeout checker
  const timeoutChecker = setInterval(
    checkExpiredApprovals,
    TIMEOUT_CHECK_INTERVAL_MS,
  );

  return {
    close: () => {
      clearInterval(timeoutChecker);
      server.close();
    },
  };
}
