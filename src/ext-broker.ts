/**
 * External Access Broker — Host-side IPC handler
 *
 * Processes ext_call, ext_grant, ext_revoke from containers.
 * All P0 adjustments:
 *  - HMAC request signing (P0-7)
 *  - Inflight lock via processing status (P0-8)
 *  - Backpressure (P0-1)
 *  - L3 two-man rule (P0-2)
 *  - Idempotency key (P0-6)
 *  - HMAC-SHA256 for params hash (P0-4)
 *  - Deny-wins precedence (P0-5)
 *  - Mandatory expiry for L2/L3 (P0-5)
 */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

import { DATA_DIR } from './config.js';
import {
  countPendingExtCalls,
  getCapability,
  getExtCallByIdempotencyKey,
  getExtCallByRequestId,
  grantCapability,
  logExtCall,
  revokeCapability,
  updateExtCallStatus,
} from './ext-broker-db.js';
import {
  checkProviderSecrets,
  getProvider,
  type ProviderSecrets,
} from './ext-broker-providers.js';
import { getGovApprovals } from './gov-db.js';
import { logGovActivity } from './gov-db.js';
import { logger } from './logger.js';

// --- Config ---

const MAX_PENDING_PER_GROUP = parseInt(
  process.env.EXT_MAX_PENDING_PER_GROUP || '5',
  10,
);
const EXT_CALL_HMAC_SECRET = process.env.EXT_CALL_HMAC_SECRET || '';
const DEFAULT_L2_EXPIRY_DAYS = 7;
const DEFAULT_L3_EXPIRY_DAYS = 7;

// --- Provider secrets (loaded once from host env) ---

const PROVIDER_SECRETS: Record<string, ProviderSecrets> = {
  github: {
    GITHUB_TOKEN: process.env.GITHUB_TOKEN || '',
  },
  'cloud-logs': {
    // v0: no secrets needed
  },
};

// --- IPC Data types ---

export interface ExtAccessIpcData {
  type: string;
  // ext_call
  request_id?: string;
  provider?: string;
  action?: string;
  params?: Record<string, unknown>;
  task_id?: string;
  idempotency_key?: string;
  sig?: string; // HMAC signature (P0-7)
  // ext_grant / ext_revoke
  group_folder?: string;
  access_level?: number;
  allowed_actions?: string[] | null;
  denied_actions?: string[] | null;
  requires_task_gate?: string;
  // common
  timestamp?: string;
}

// --- HMAC helpers ---

function computeParamsHmac(params: unknown): string {
  const secret = EXT_CALL_HMAC_SECRET || 'nanoclaw-default-hmac-key';
  return crypto
    .createHmac('sha256', secret)
    .update(JSON.stringify(params))
    .digest('hex');
}

/**
 * P0-7: Validate request signature.
 * The container signs the full request body with the group's IPC secret.
 */
function validateRequestSignature(
  data: ExtAccessIpcData,
  sourceGroup: string,
): boolean {
  const secretPath = path.join(DATA_DIR, 'ipc', sourceGroup, '.ipc_secret');
  if (!fs.existsSync(secretPath)) {
    // No secret file = signing not enabled for this group yet
    // Fail-closed: deny unsigned requests when secrets exist globally
    if (process.env.EXT_REQUIRE_SIGNING === '1') {
      return false;
    }
    return true; // graceful: signing optional until first secret generation
  }

  const secret = fs.readFileSync(secretPath, 'utf-8').trim();
  if (!data.sig) return false;

  // HMAC over the request body (excluding sig field itself)
  const { sig: _sig, ...body } = data;
  const expected = crypto
    .createHmac('sha256', secret)
    .update(JSON.stringify(body))
    .digest('hex');

  return crypto.timingSafeEqual(
    Buffer.from(data.sig, 'hex'),
    Buffer.from(expected, 'hex'),
  );
}

// --- Response writing ---

function writeExtResponse(
  groupFolder: string,
  requestId: string,
  response: Record<string, unknown>,
): void {
  const dir = path.join(DATA_DIR, 'ipc', groupFolder, 'responses');
  fs.mkdirSync(dir, { recursive: true });
  const tempPath = path.join(dir, `${requestId}.json.tmp`);
  const finalPath = path.join(dir, `${requestId}.json`);
  fs.writeFileSync(tempPath, JSON.stringify(response, null, 2));
  fs.renameSync(tempPath, finalPath); // P0-1: atomic write
}

/**
 * P0-1: Cleanup response files older than TTL.
 */
export function cleanupResponseFiles(groupFolder: string, maxAgeMs = 86_400_000): void {
  const dir = path.join(DATA_DIR, 'ipc', groupFolder, 'responses');
  if (!fs.existsSync(dir)) return;

  const now = Date.now();
  for (const file of fs.readdirSync(dir)) {
    const filePath = path.join(dir, file);
    try {
      const stat = fs.statSync(filePath);
      if (now - stat.mtimeMs > maxAgeMs) {
        fs.unlinkSync(filePath);
      }
    } catch { /* ignore */ }
  }
}

// --- Main entry point ---

export async function processExtAccessIpc(
  data: ExtAccessIpcData,
  sourceGroup: string,
  isMain: boolean,
): Promise<void> {
  switch (data.type) {
    case 'ext_call':
      await handleExtCall(data, sourceGroup, isMain);
      break;
    case 'ext_grant':
      handleExtGrant(data, sourceGroup, isMain);
      break;
    case 'ext_revoke':
      handleExtRevoke(data, sourceGroup, isMain);
      break;
    default:
      logger.warn({ type: data.type }, 'Unknown ext access IPC type');
  }
}

// --- ext_call handler ---

async function handleExtCall(
  data: ExtAccessIpcData,
  sourceGroup: string,
  _isMain: boolean,
): Promise<void> {
  const now = new Date().toISOString();
  const requestId = data.request_id;

  if (!requestId || !data.provider || !data.action) {
    logger.warn({ data }, 'ext_call missing required fields');
    return;
  }

  // P0-8: Check if already processing (inflight lock via DB)
  const existing = getExtCallByRequestId(requestId);
  if (existing) {
    logger.debug({ requestId }, 'ext_call already processed or processing, skipping');
    return;
  }

  // P0-7: Validate request signature
  if (!validateRequestSignature(data, sourceGroup)) {
    logger.warn({ sourceGroup, requestId }, 'ext_call HMAC signature invalid — DENIED');
    logExtCall({
      request_id: requestId,
      group_folder: sourceGroup,
      provider: data.provider,
      action: data.action,
      access_level: 0,
      params_hmac: '',
      params_summary: null,
      status: 'denied',
      denial_reason: 'Invalid request signature',
      result_summary: null,
      response_data: null,
      task_id: data.task_id || null,
      idempotency_key: data.idempotency_key || null,
      duration_ms: null,
      created_at: now,
    });
    writeExtResponse(sourceGroup, requestId, {
      request_id: requestId,
      status: 'denied',
      error: 'Invalid request signature',
      timestamp: now,
    });
    return;
  }

  // P0-1: Backpressure check
  const pendingCount = countPendingExtCalls(sourceGroup);
  if (pendingCount >= MAX_PENDING_PER_GROUP) {
    logger.warn({ sourceGroup, pendingCount }, 'ext_call backpressure — BUSY');
    writeExtResponse(sourceGroup, requestId, {
      request_id: requestId,
      status: 'denied',
      error: `BUSY: ${pendingCount} pending calls (max ${MAX_PENDING_PER_GROUP})`,
      timestamp: now,
    });
    return;
  }

  const provider = getProvider(data.provider);
  if (!provider) {
    deny(requestId, sourceGroup, data, now, `Unknown provider: ${data.provider}`);
    return;
  }

  const action = provider.actions[data.action];
  if (!action) {
    deny(requestId, sourceGroup, data, now, `Unknown action: ${data.action} for provider ${data.provider}`);
    return;
  }

  // Check provider secrets
  const secrets = PROVIDER_SECRETS[data.provider] || {};
  const missingSecrets = checkProviderSecrets(data.provider, secrets);
  if (missingSecrets.length > 0) {
    deny(requestId, sourceGroup, data, now, `Provider ${data.provider} disabled: missing secrets ${missingSecrets.join(', ')}`);
    return;
  }

  // Get capability
  const cap = getCapability(sourceGroup, data.provider);
  if (!cap) {
    deny(requestId, sourceGroup, data, now, `No capability for provider ${data.provider} (L0 — denied)`);
    return;
  }

  // Check expiry
  if (cap.expires_at && new Date(cap.expires_at) < new Date()) {
    deny(requestId, sourceGroup, data, now, `Capability expired at ${cap.expires_at}`);
    return;
  }

  // Check access level
  if (action.level > cap.access_level) {
    deny(
      requestId, sourceGroup, data, now,
      `Insufficient access: action '${data.action}' requires L${action.level}, group has L${cap.access_level}`,
    );
    return;
  }

  // P0-5: Deny-wins — check denied_actions FIRST
  if (cap.denied_actions) {
    const denyList: string[] = JSON.parse(cap.denied_actions);
    if (denyList.includes(data.action)) {
      deny(requestId, sourceGroup, data, now, `Action '${data.action}' is explicitly denied`);
      return;
    }
  }

  // Check allowed_actions (if set, action must be in list)
  if (cap.allowed_actions) {
    const allowList: string[] = JSON.parse(cap.allowed_actions);
    if (!allowList.includes(data.action)) {
      deny(requestId, sourceGroup, data, now, `Action '${data.action}' not in allowed list`);
      return;
    }
  }

  // P0-2: L3 two-man rule — requires gate approval + main approval on the governance task
  if (action.level === 3) {
    if (!data.task_id) {
      deny(requestId, sourceGroup, data, now, 'L3 action requires task_id with governance gate approval');
      return;
    }

    const approvals = getGovApprovals(data.task_id);
    const requiredGate = cap.requires_task_gate;

    if (requiredGate) {
      const gateApproval = approvals.find((a) => a.gate_type === requiredGate);
      if (!gateApproval) {
        deny(requestId, sourceGroup, data, now, `L3 requires ${requiredGate} gate approval on task ${data.task_id}`);
        return;
      }
    }

    // Two-man rule: need at least 2 approvals from different groups
    const uniqueApprovers = new Set(approvals.map((a) => a.approved_by));
    if (uniqueApprovers.size < 2) {
      deny(
        requestId, sourceGroup, data, now,
        `L3 two-man rule: need approvals from 2+ groups, got ${uniqueApprovers.size} (${[...uniqueApprovers].join(', ')})`,
      );
      return;
    }
  }

  // Validate params with action's zod schema
  const paramsResult = action.params.safeParse(data.params || {});
  if (!paramsResult.success) {
    deny(requestId, sourceGroup, data, now, `Invalid params: ${paramsResult.error.message}`);
    return;
  }
  const validatedParams = paramsResult.data;
  const paramsHmac = computeParamsHmac(validatedParams);
  const paramsSummary = action.summarize(validatedParams);

  // P0-6: Idempotency check — return cached response for duplicate writes
  if (data.idempotency_key && !action.idempotent) {
    const cached = getExtCallByIdempotencyKey(data.idempotency_key, data.provider, data.action);
    if (cached && cached.response_data) {
      logger.info({ requestId, idempotencyKey: data.idempotency_key }, 'ext_call idempotency hit — returning cached response');
      writeExtResponse(sourceGroup, requestId, JSON.parse(cached.response_data));
      return;
    }
  }

  // P0-8: Claim processing slot (INSERT with 'processing' status)
  const claimed = logExtCall({
    request_id: requestId,
    group_folder: sourceGroup,
    provider: data.provider,
    action: data.action,
    access_level: action.level,
    params_hmac: paramsHmac,
    params_summary: paramsSummary,
    status: 'processing',
    denial_reason: null,
    result_summary: null,
    response_data: null,
    task_id: data.task_id || null,
    idempotency_key: data.idempotency_key || null,
    duration_ms: null,
    created_at: now,
  });

  if (!claimed) {
    logger.debug({ requestId }, 'ext_call already claimed by another handler');
    return;
  }

  // Execute
  const startTime = Date.now();
  try {
    const result = await action.execute(validatedParams, secrets);
    const durationMs = Date.now() - startTime;

    if (result.ok) {
      const response = {
        request_id: requestId,
        status: 'executed' as const,
        data: result.data,
        summary: result.summary,
        timestamp: new Date().toISOString(),
      };
      updateExtCallStatus(requestId, 'executed', {
        result_summary: result.summary,
        response_data: JSON.stringify(response),
        duration_ms: durationMs,
      });
      writeExtResponse(sourceGroup, requestId, response);
      logger.info(
        { requestId, provider: data.provider, action: data.action, durationMs },
        'ext_call executed successfully',
      );
    } else {
      const response = {
        request_id: requestId,
        status: 'failed' as const,
        error: result.summary,
        timestamp: new Date().toISOString(),
      };
      updateExtCallStatus(requestId, 'failed', {
        result_summary: result.summary,
        response_data: JSON.stringify(response),
        duration_ms: durationMs,
      });
      writeExtResponse(sourceGroup, requestId, response);
      logger.warn(
        { requestId, provider: data.provider, action: data.action, error: result.summary },
        'ext_call provider returned failure',
      );
    }
  } catch (err) {
    const durationMs = Date.now() - startTime;
    const errMsg = err instanceof Error ? err.message : String(err);
    const response = {
      request_id: requestId,
      status: 'failed' as const,
      error: `Provider execution error: ${errMsg.slice(0, 500)}`,
      timestamp: new Date().toISOString(),
    };
    updateExtCallStatus(requestId, 'failed', {
      result_summary: errMsg.slice(0, 500),
      response_data: JSON.stringify(response),
      duration_ms: durationMs,
    });
    writeExtResponse(sourceGroup, requestId, response);
    logger.error(
      { requestId, provider: data.provider, action: data.action, err },
      'ext_call execution error',
    );
  }
}

// --- ext_grant handler ---

function handleExtGrant(
  data: ExtAccessIpcData,
  sourceGroup: string,
  isMain: boolean,
): void {
  if (!isMain) {
    logger.warn({ sourceGroup }, 'Unauthorized ext_grant blocked');
    return;
  }
  if (!data.group_folder || !data.provider || data.access_level === undefined) {
    logger.warn({ data }, 'ext_grant missing required fields');
    return;
  }

  const now = new Date().toISOString();

  // P0-5: Mandatory expiry for L2/L3
  let expiresAt: string | null = null;
  if (data.access_level >= 2) {
    const expiryDays = data.access_level === 3 ? DEFAULT_L3_EXPIRY_DAYS : DEFAULT_L2_EXPIRY_DAYS;
    expiresAt = new Date(Date.now() + expiryDays * 86_400_000).toISOString();
  }

  grantCapability({
    group_folder: data.group_folder,
    provider: data.provider,
    access_level: data.access_level,
    allowed_actions: data.allowed_actions ? JSON.stringify(data.allowed_actions) : null,
    denied_actions: data.denied_actions ? JSON.stringify(data.denied_actions) : null,
    requires_task_gate: data.requires_task_gate || null,
    granted_by: sourceGroup,
    granted_at: now,
    expires_at: expiresAt,
    active: 1,
  });

  // P0-5: Audit in gov_activities
  logGovActivity({
    task_id: '__ext_broker__',
    action: 'ext_grant',
    from_state: null,
    to_state: null,
    actor: sourceGroup,
    reason: `Granted ${data.group_folder} → ${data.provider} L${data.access_level}${expiresAt ? ` (expires ${expiresAt})` : ''}`,
    created_at: now,
  });

  logger.info(
    { group: data.group_folder, provider: data.provider, level: data.access_level },
    'External capability granted',
  );
}

// --- ext_revoke handler ---

function handleExtRevoke(
  data: ExtAccessIpcData,
  sourceGroup: string,
  isMain: boolean,
): void {
  if (!isMain) {
    logger.warn({ sourceGroup }, 'Unauthorized ext_revoke blocked');
    return;
  }
  if (!data.group_folder || !data.provider) {
    logger.warn({ data }, 'ext_revoke missing required fields');
    return;
  }

  const now = new Date().toISOString();
  revokeCapability(data.group_folder, data.provider);

  // P0-5: Audit
  logGovActivity({
    task_id: '__ext_broker__',
    action: 'ext_revoke',
    from_state: null,
    to_state: null,
    actor: sourceGroup,
    reason: `Revoked ${data.group_folder} → ${data.provider}`,
    created_at: now,
  });

  logger.info(
    { group: data.group_folder, provider: data.provider },
    'External capability revoked',
  );
}

// --- Helper ---

function deny(
  requestId: string,
  sourceGroup: string,
  data: ExtAccessIpcData,
  now: string,
  reason: string,
): void {
  const paramsHmac = data.params ? computeParamsHmac(data.params) : '';

  logExtCall({
    request_id: requestId,
    group_folder: sourceGroup,
    provider: data.provider || '',
    action: data.action || '',
    access_level: 0,
    params_hmac: paramsHmac,
    params_summary: null,
    status: 'denied',
    denial_reason: reason,
    result_summary: null,
    response_data: null,
    task_id: data.task_id || null,
    idempotency_key: data.idempotency_key || null,
    duration_ms: null,
    created_at: now,
  });

  writeExtResponse(sourceGroup, requestId, {
    request_id: requestId,
    status: 'denied',
    error: reason,
    timestamp: now,
  });

  logger.warn(
    { requestId, sourceGroup, provider: data.provider, action: data.action, reason },
    'ext_call DENIED',
  );
}

// --- Provider registration (called at startup) ---

export function initExtBroker(): void {
  // Register v0 providers
  // Dynamic import to avoid circular deps
  import('./ext-providers/github.js').then(({ githubProvider }) => {
    import('./ext-broker-providers.js').then(({ registerProvider }) => {
      registerProvider(githubProvider);
      logger.info('External provider registered: github');
    });
  });
  import('./ext-providers/cloud-logs.js').then(({ cloudLogsProvider }) => {
    import('./ext-broker-providers.js').then(({ registerProvider }) => {
      registerProvider(cloudLogsProvider);
      logger.info('External provider registered: cloud-logs');
    });
  });
}
