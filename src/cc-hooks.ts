import http, { IncomingMessage, ServerResponse } from 'http';

import { ASSISTANT_NAME, CC_HOOKS_MODEL, CC_WEBHOOK_PATH } from './config.js';
import { logger } from './logger.js';

export { CC_WEBHOOK_PATH } from './config.js';
const MAX_BODY_BYTES = 1024 * 1024;

const CC_EVENT_TYPES = [
  'task_notification',
  'task_review_ready',
  'task_failed',
  'pipeline_stalled',
  'release_closed',
] as const;

export type CcEventType = (typeof CC_EVENT_TYPES)[number];

export interface CcWebhookDeps {
  createHookSessionMessage: (
    eventType: CcEventType,
    payload: Record<string, unknown>,
    message: string,
  ) => void;
  sendAdamWhatsApp: (message: string) => Promise<void>;
}

export interface CcWebhookServerOptions {
  token: string;
  host: string;
  port: number;
  webhookUrl: string;
}

const VALID_EVENT_TYPES = new Set<string>(CC_EVENT_TYPES);

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function getNestedValue(
  payload: Record<string, unknown>,
  path: string[],
): unknown {
  let cursor: unknown = payload;
  for (const key of path) {
    const obj = asRecord(cursor);
    if (!obj) return undefined;
    cursor = obj[key];
  }
  return cursor;
}

function getFirstString(
  payload: Record<string, unknown>,
  paths: string[][],
): string | undefined {
  for (const path of paths) {
    const value = getNestedValue(payload, path);
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}

function getFirstValue(
  payload: Record<string, unknown>,
  paths: string[][],
): unknown {
  for (const path of paths) {
    const value = getNestedValue(payload, path);
    if (value !== undefined && value !== null) {
      return value;
    }
  }
  return undefined;
}

function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n...[truncated]`;
}

function stringifyContext(value: unknown, maxChars: number): string {
  if (typeof value === 'string') return truncate(value, maxChars);
  try {
    return truncate(JSON.stringify(value, null, 2), maxChars);
  } catch {
    return '[unserializable payload context]';
  }
}

function extractTaskId(payload: Record<string, unknown>): string | undefined {
  return getFirstString(payload, [
    ['task_id'],
    ['taskId'],
    ['task', 'id'],
    ['data', 'task_id'],
    ['data', 'taskId'],
    ['data', 'task', 'id'],
  ]);
}

function extractTaskTitle(
  payload: Record<string, unknown>,
): string | undefined {
  return getFirstString(payload, [
    ['task_title'],
    ['taskTitle'],
    ['task', 'title'],
    ['task', 'name'],
    ['data', 'task_title'],
    ['data', 'taskTitle'],
    ['data', 'task', 'title'],
    ['data', 'task', 'name'],
  ]);
}

function extractPrUrl(payload: Record<string, unknown>): string | undefined {
  return getFirstString(payload, [
    ['pr_url'],
    ['pull_request_url'],
    ['pullRequestUrl'],
    ['pull_request', 'url'],
    ['pull_request', 'html_url'],
    ['review', 'pr_url'],
    ['data', 'pr_url'],
    ['data', 'pull_request', 'url'],
    ['data', 'pull_request', 'html_url'],
  ]);
}

function extractDiffContext(payload: Record<string, unknown>): string {
  const diff = getFirstValue(payload, [
    ['pr_diff'],
    ['diff'],
    ['patch'],
    ['review', 'diff'],
    ['pull_request', 'diff'],
    ['pull_request', 'patch'],
    ['pull_request', 'files'],
    ['data', 'pr_diff'],
    ['data', 'diff'],
    ['data', 'review', 'diff'],
    ['data', 'pull_request', 'diff'],
    ['data', 'pull_request', 'patch'],
    ['data', 'pull_request', 'files'],
  ]);

  if (diff === undefined) {
    return 'No inline diff provided by CC. Use PR URL and local git history to retrieve changes before reviewing.';
  }

  return stringifyContext(diff, 12000);
}

function buildTaskNotificationMessage(
  payload: Record<string, unknown>,
): string {
  const taskId = extractTaskId(payload) || 'unknown';
  const taskTitle = extractTaskTitle(payload) || 'unknown';
  const summary = getFirstString(payload, [
    ['summary'],
    ['message'],
    ['data', 'summary'],
    ['data', 'message'],
  ]);

  const details = summary || stringifyContext(payload, 4000);

  return [
    `@${ASSISTANT_NAME}`,
    `[CC task_notification | model: ${CC_HOOKS_MODEL}]`,
    `Task: ${taskTitle} (${taskId})`,
    'System event from Command Center. Assess whether follow-up action is required.',
    `Context:\n${details}`,
  ].join('\n\n');
}

function buildTaskReviewReadyMessage(payload: Record<string, unknown>): string {
  const taskId = extractTaskId(payload) || 'unknown';
  const taskTitle = extractTaskTitle(payload) || 'unknown';
  const prUrl = extractPrUrl(payload) || 'unknown';
  const diffContext = extractDiffContext(payload);

  return [
    `@${ASSISTANT_NAME}`,
    `[CC task_review_ready | model: ${CC_HOOKS_MODEL}]`,
    `Task: ${taskTitle} (${taskId})`,
    `PR URL: ${prUrl}`,
    'Review Instructions:\n1. Review the diff for correctness, regressions, test coverage, and security impact.\n2. Report blocking issues first with concrete evidence from the diff.\n3. If ready, provide approval summary and merge recommendation.',
    `PR Diff Context:\n${diffContext}`,
  ].join('\n\n');
}

function buildTaskFailedMessage(payload: Record<string, unknown>): string {
  const taskId = extractTaskId(payload) || 'unknown';
  const taskTitle = extractTaskTitle(payload) || 'unknown';
  const failureSummary = getFirstString(payload, [
    ['error'],
    ['failure_reason'],
    ['reason'],
    ['message'],
    ['data', 'error'],
    ['data', 'failure_reason'],
    ['data', 'reason'],
    ['data', 'message'],
  ]);
  const retryHint = getFirstString(payload, [
    ['retry_command'],
    ['retryHint'],
    ['data', 'retry_command'],
    ['data', 'retryHint'],
  ]);

  const contextText = failureSummary || stringifyContext(payload, 6000);

  return [
    `@${ASSISTANT_NAME}`,
    `[CC task_failed | model: ${CC_HOOKS_MODEL}]`,
    `Task: ${taskTitle} (${taskId})`,
    'Investigation Instructions:\n1. Identify likely root cause from the failure context.\n2. Propose and apply the minimal safe fix.\n3. Retry the task workflow and report outcome.',
    `Failure Context:\n${contextText}`,
    retryHint ? `Retry Hint: ${retryHint}` : '',
  ]
    .filter((line) => line.length > 0)
    .join('\n\n');
}

function buildPipelineStalledAlert(payload: Record<string, unknown>): string {
  const pipeline = getFirstString(payload, [
    ['pipeline'],
    ['pipeline_name'],
    ['pipelineName'],
    ['data', 'pipeline'],
    ['data', 'pipeline_name'],
    ['data', 'pipelineName'],
  ]);
  const taskId = extractTaskId(payload);
  const url = getFirstString(payload, [
    ['url'],
    ['pipeline_url'],
    ['data', 'url'],
    ['data', 'pipeline_url'],
  ]);

  const summary = [
    'CC Alert: pipeline stalled',
    pipeline ? `Pipeline: ${pipeline}` : '',
    taskId ? `Task: ${taskId}` : '',
    url ? `Link: ${url}` : '',
  ]
    .filter((line) => line.length > 0)
    .join('\n');

  return summary;
}

function buildReleaseClosedSummary(payload: Record<string, unknown>): string {
  const release = getFirstString(payload, [
    ['release'],
    ['release_name'],
    ['releaseName'],
    ['version'],
    ['data', 'release'],
    ['data', 'release_name'],
    ['data', 'releaseName'],
    ['data', 'version'],
  ]);
  const summary = getFirstString(payload, [
    ['summary'],
    ['message'],
    ['notes'],
    ['data', 'summary'],
    ['data', 'message'],
    ['data', 'notes'],
  ]);
  const url = getFirstString(payload, [
    ['url'],
    ['release_url'],
    ['data', 'url'],
    ['data', 'release_url'],
  ]);

  return [
    'CC Update: release closed',
    release ? `Release: ${release}` : '',
    summary ? `Summary: ${summary}` : '',
    url ? `Link: ${url}` : '',
  ]
    .filter((line) => line.length > 0)
    .join('\n');
}

export function extractCcEventType(payload: unknown): CcEventType | null {
  const obj = asRecord(payload);
  if (!obj) return null;

  const directEvent =
    getFirstString(obj, [
      ['event_type'],
      ['eventType'],
      ['type'],
      ['name'],
      ['event'],
      ['data', 'event_type'],
      ['data', 'eventType'],
      ['data', 'type'],
      ['data', 'name'],
    ]) || null;

  if (directEvent && VALID_EVENT_TYPES.has(directEvent)) {
    return directEvent as CcEventType;
  }

  const eventObj = asRecord(obj.event);
  if (eventObj) {
    const nested = getFirstString(eventObj, [
      ['type'],
      ['name'],
      ['event_type'],
      ['eventType'],
    ]);
    if (nested && VALID_EVENT_TYPES.has(nested)) {
      return nested as CcEventType;
    }
  }

  return null;
}

function getRequestToken(req: IncomingMessage): string | undefined {
  const tokenHeader = req.headers['x-cc-webhook-token'];
  if (typeof tokenHeader === 'string' && tokenHeader.trim()) {
    return tokenHeader.trim();
  }

  const authorization = req.headers.authorization;
  if (typeof authorization === 'string') {
    const match = authorization.match(/^Bearer\s+(.+)$/i);
    if (match && match[1]) return match[1].trim();
  }

  return undefined;
}

export function isValidCcWebhookToken(
  req: IncomingMessage,
  expectedToken: string,
): boolean {
  if (!expectedToken) return false;
  const received = getRequestToken(req);
  if (!received) return false;
  return received === expectedToken;
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;

  for await (const chunk of req) {
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += data.length;
    if (total > MAX_BODY_BYTES) {
      throw new Error('Payload too large');
    }
    chunks.push(data);
  }

  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) return {};

  try {
    return JSON.parse(raw);
  } catch {
    throw new Error('Invalid JSON payload');
  }
}

function writeJson(
  res: ServerResponse,
  statusCode: number,
  body: Record<string, unknown>,
): void {
  const serialized = JSON.stringify(body);
  res.statusCode = statusCode;
  res.setHeader('content-type', 'application/json');
  res.end(serialized);
}

export async function routeCcEvent(
  eventType: CcEventType,
  payload: Record<string, unknown>,
  deps: CcWebhookDeps,
): Promise<void> {
  switch (eventType) {
    case 'task_notification': {
      deps.createHookSessionMessage(
        eventType,
        payload,
        buildTaskNotificationMessage(payload),
      );
      return;
    }
    case 'task_review_ready': {
      deps.createHookSessionMessage(
        eventType,
        payload,
        buildTaskReviewReadyMessage(payload),
      );
      return;
    }
    case 'task_failed': {
      deps.createHookSessionMessage(
        eventType,
        payload,
        buildTaskFailedMessage(payload),
      );
      return;
    }
    case 'pipeline_stalled': {
      await deps.sendAdamWhatsApp(buildPipelineStalledAlert(payload));
      return;
    }
    case 'release_closed': {
      await deps.sendAdamWhatsApp(buildReleaseClosedSummary(payload));
      return;
    }
  }
}

export function createCcWebhookHandler(
  deps: CcWebhookDeps,
  options: CcWebhookServerOptions,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url || '/', 'http://localhost');

    if (req.method !== 'POST' || url.pathname !== CC_WEBHOOK_PATH) {
      writeJson(res, 404, { error: 'Not found' });
      return;
    }

    if (!options.token) {
      logger.error('CC webhook token is not configured');
      writeJson(res, 503, { error: 'CC webhook is not configured' });
      return;
    }

    if (!isValidCcWebhookToken(req, options.token)) {
      writeJson(res, 401, { error: 'Invalid webhook token' });
      return;
    }

    let payload: unknown;
    try {
      payload = await readJsonBody(req);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Invalid payload';
      const status = message === 'Payload too large' ? 413 : 400;
      writeJson(res, status, { error: message });
      return;
    }

    const body = asRecord(payload);
    if (!body) {
      writeJson(res, 400, { error: 'JSON payload must be an object' });
      return;
    }

    const eventType = extractCcEventType(body);
    if (!eventType) {
      writeJson(res, 400, { error: 'Unsupported or missing event type' });
      return;
    }

    try {
      await routeCcEvent(eventType, body, deps);
      writeJson(res, 202, { ok: true, eventType });
    } catch (err) {
      logger.error({ err, eventType }, 'Failed to route CC webhook event');
      writeJson(res, 500, { error: 'Failed to process webhook event' });
    }
  };
}

export function startCcWebhookServer(
  deps: CcWebhookDeps,
  options: CcWebhookServerOptions,
): http.Server {
  const handler = createCcWebhookHandler(deps, options);
  const server = http.createServer((req, res) => {
    handler(req, res).catch((err) => {
      logger.error({ err }, 'CC webhook handler crashed');
      writeJson(res, 500, { error: 'Internal server error' });
    });
  });

  server.listen(options.port, options.host, () => {
    logger.info(
      {
        host: options.host,
        port: options.port,
        path: CC_WEBHOOK_PATH,
        webhookUrl: options.webhookUrl,
      },
      'CC webhook receiver listening',
    );
  });

  return server;
}
