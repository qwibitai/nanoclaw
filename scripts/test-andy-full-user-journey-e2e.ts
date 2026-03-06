/**
 * Full user-journey E2E for andy-developer:
 * 1) Ask to build app
 * 2) Ask to add feature
 * 3) Ask to customize
 * With status checks in-between, as a normal user would do.
 *
 * Run with:
 *   node --experimental-transform-types scripts/test-andy-full-user-journey-e2e.ts
 */
import Database from 'better-sqlite3';

type MessageRow = {
  id: string;
  content: string;
  timestamp: string;
};

type AndyRequestRow = {
  request_id: string;
  state: string;
  worker_run_id: string | null;
  updated_at: string;
};

type WorkerRunRow = {
  run_id: string;
  status: string;
  phase: string | null;
  started_at: string;
  completed_at: string | null;
};

type Stage = {
  name: string;
  prompt: string;
  retryPrompt: string;
};

const DEFAULT_DB_PATH = 'store/messages.db';
const POLL_MS = 500;
const IMMEDIATE_REPLY_MAX_MS = 8_000;
const REQUEST_ACK_TIMEOUT_MS = 30_000;
const REQUEST_LINK_TIMEOUT_MS = 180_000;
const RUN_TERMINAL_TIMEOUT_MS = 15 * 60_000;
const MAX_STAGE_ATTEMPTS = 3;
const RUN_TERMINAL_OK = new Set(['review_requested', 'done']);
const RUN_TERMINAL_FAIL = new Set(['failed', 'failed_contract']);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function nowIso(): string {
  return new Date().toISOString();
}

function getAndyChatJid(db: Database.Database): string {
  const row = db.prepare(
    `SELECT jid
     FROM registered_groups
     WHERE folder = 'andy-developer'
     LIMIT 1`,
  ).get() as { jid: string } | undefined;
  if (!row?.jid) throw new Error('andy-developer is not registered');
  return row.jid;
}

function upsertChat(db: Database.Database, chatJid: string): void {
  db.prepare(
    `INSERT INTO chats (jid, name, last_message_time, channel, is_group)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(jid) DO UPDATE SET
       name = excluded.name,
       last_message_time = excluded.last_message_time,
       channel = excluded.channel,
       is_group = excluded.is_group`,
  ).run(chatJid, 'Andy-Developer', nowIso(), 'whatsapp', 1);
}

function getBotIds(db: Database.Database, chatJid: string): Set<string> {
  const rows = db.prepare(
    `SELECT id FROM messages WHERE chat_jid = ? AND is_bot_message = 1`,
  ).all(chatJid) as Array<{ id: string }>;
  return new Set(rows.map((r) => r.id));
}

function insertUserMessage(
  db: Database.Database,
  chatJid: string,
  messageId: string,
  content: string,
): string {
  const ts = nowIso();
  db.prepare(
    `INSERT OR REPLACE INTO messages (
      id, chat_jid, sender, sender_name, content, timestamp, is_from_me, is_bot_message
    ) VALUES (?, ?, ?, ?, ?, ?, 1, 0)`,
  ).run(messageId, chatJid, 'uat-user@nanoclaw', 'UAT User', content, ts);
  db.prepare(`UPDATE chats SET last_message_time = ? WHERE jid = ?`).run(ts, chatJid);
  return ts;
}

async function waitForBotMessage(
  db: Database.Database,
  chatJid: string,
  baselineBotIds: Set<string>,
  minTsMs: number,
  timeoutMs: number,
  predicate: (message: MessageRow) => boolean,
): Promise<MessageRow | null> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const rows = db.prepare(
      `SELECT id, content, timestamp
       FROM messages
       WHERE chat_jid = ? AND is_bot_message = 1
       ORDER BY timestamp ASC, id ASC`,
    ).all(chatJid) as MessageRow[];

    for (const row of rows) {
      if (baselineBotIds.has(row.id)) continue;
      const rowMs = Date.parse(row.timestamp);
      if (!Number.isFinite(rowMs) || rowMs < minTsMs) continue;
      if (!predicate(row)) continue;
      baselineBotIds.add(row.id);
      return row;
    }
    await sleep(POLL_MS);
  }
  return null;
}

async function waitForAndyRequestByMessageId(
  db: Database.Database,
  messageId: string,
  timeoutMs: number,
): Promise<AndyRequestRow | null> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const row = db.prepare(
      `SELECT request_id, state, worker_run_id, updated_at
       FROM andy_requests
       WHERE user_message_id = ?`,
    ).get(messageId) as AndyRequestRow | undefined;
    if (row) return row;
    await sleep(POLL_MS);
  }
  return null;
}

function getAndyRequestById(db: Database.Database, requestId: string): AndyRequestRow | null {
  const row = db.prepare(
    `SELECT request_id, state, worker_run_id, updated_at
     FROM andy_requests
     WHERE request_id = ?`,
  ).get(requestId) as AndyRequestRow | undefined;
  return row || null;
}

async function waitForRunLinkOrDispatchBlock(
  db: Database.Database,
  chatJid: string,
  requestId: string,
  baselineBotIds: Set<string>,
  minTsMs: number,
  timeoutMs: number,
): Promise<{ kind: 'linked'; runId: string } | { kind: 'dispatch_blocked'; detail: string } | { kind: 'timeout' }> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const request = getAndyRequestById(db, requestId);
    if (request?.worker_run_id) {
      return { kind: 'linked', runId: request.worker_run_id };
    }

    const rows = db.prepare(
      `SELECT id, content, timestamp
       FROM messages
       WHERE chat_jid = ? AND is_bot_message = 1
       ORDER BY timestamp ASC, id ASC`,
    ).all(chatJid) as MessageRow[];

    for (const row of rows) {
      if (baselineBotIds.has(row.id)) continue;
      const rowMs = Date.parse(row.timestamp);
      if (!Number.isFinite(rowMs) || rowMs < minTsMs) continue;
      baselineBotIds.add(row.id);
      if (/Dispatch blocked by validator/i.test(row.content)) {
        return { kind: 'dispatch_blocked', detail: row.content.replace(/\s+/g, ' ').slice(0, 260) };
      }
    }

    await sleep(POLL_MS);
  }

  return { kind: 'timeout' };
}

function getWorkerRun(db: Database.Database, runId: string): WorkerRunRow | null {
  const row = db.prepare(
    `SELECT run_id, status, phase, started_at, completed_at
     FROM worker_runs
     WHERE run_id = ?`,
  ).get(runId) as WorkerRunRow | undefined;
  return row || null;
}

async function waitForWorkerRunTerminal(
  db: Database.Database,
  runId: string,
  timeoutMs: number,
): Promise<WorkerRunRow | null> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const row = getWorkerRun(db, runId);
    if (row && (RUN_TERMINAL_OK.has(row.status) || RUN_TERMINAL_FAIL.has(row.status))) {
      return row;
    }
    await sleep(POLL_MS);
  }
  return null;
}

// request_id is sourced from the DB andy_requests row, not ack text.

async function askStatusAndValidateImmediate(
  db: Database.Database,
  chatJid: string,
  baselineBotIds: Set<string>,
  token: string,
  requestId: string,
): Promise<void> {
  const messageId = `uat-full-${token}-status-${Math.random().toString(36).slice(2, 8)}`;
  const statusPrompt = `@Andy status ${requestId}`;
  const sentAt = insertUserMessage(db, chatJid, messageId, statusPrompt);
  const sentMs = Date.parse(sentAt);
  const reply = await waitForBotMessage(
    db,
    chatJid,
    baselineBotIds,
    sentMs,
    IMMEDIATE_REPLY_MAX_MS,
    (m) => m.content.includes(requestId),
  );
  if (!reply) {
    throw new Error(`status(${requestId}) did not get immediate reply <= ${IMMEDIATE_REPLY_MAX_MS}ms`);
  }
  const latencyMs = Date.parse(reply.timestamp) - sentMs;
  if (!Number.isFinite(latencyMs) || latencyMs < 0 || latencyMs > IMMEDIATE_REPLY_MAX_MS) {
    throw new Error(`status(${requestId}) latency invalid: ${latencyMs}`);
  }
  const preview = reply.content.replace(/\s+/g, ' ').slice(0, 160);
  console.log(`  [PASS] immediate status reply ${latencyMs}ms | ${preview}`);
}

async function askProgressAndValidateImmediate(
  db: Database.Database,
  chatJid: string,
  baselineBotIds: Set<string>,
  token: string,
): Promise<void> {
  const messageId = `uat-full-${token}-progress-${Math.random().toString(36).slice(2, 8)}`;
  const prompt = '@Andy what is the current progress';
  const sentAt = insertUserMessage(db, chatJid, messageId, prompt);
  const sentMs = Date.parse(sentAt);
  const reply = await waitForBotMessage(
    db,
    chatJid,
    baselineBotIds,
    sentMs,
    IMMEDIATE_REPLY_MAX_MS,
    (m) => /Current progress|Current tracked requests|No worker run is active|There are no worker runs yet/i.test(m.content),
  );
  if (!reply) {
    throw new Error(`progress query did not get immediate reply <= ${IMMEDIATE_REPLY_MAX_MS}ms`);
  }
  const latencyMs = Date.parse(reply.timestamp) - sentMs;
  if (!Number.isFinite(latencyMs) || latencyMs < 0 || latencyMs > IMMEDIATE_REPLY_MAX_MS) {
    throw new Error(`progress latency invalid: ${latencyMs}`);
  }
  const preview = reply.content.replace(/\s+/g, ' ').slice(0, 160);
  console.log(`  [PASS] immediate progress reply ${latencyMs}ms | ${preview}`);
}

async function runStage(
  db: Database.Database,
  chatJid: string,
  baselineBotIds: Set<string>,
  token: string,
  stage: Stage,
): Promise<void> {
  console.log(`\n== Stage: ${stage.name} ==`);
  for (let attempt = 1; attempt <= MAX_STAGE_ATTEMPTS; attempt += 1) {
    const attemptSuffix = attempt === 1 ? 'primary' : `retry-${attempt}`;
    const messageId = `uat-full-${token}-${stage.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${attemptSuffix}`;
    const prompt = attempt === 1 ? stage.prompt : stage.retryPrompt;
    const sentAt = insertUserMessage(db, chatJid, messageId, prompt);
    const sentMs = Date.parse(sentAt);

    const request = await waitForAndyRequestByMessageId(db, messageId, REQUEST_ACK_TIMEOUT_MS);
    if (!request) {
      throw new Error(`${stage.name}: request row not created (attempt ${attempt})`);
    }
    console.log(`  attempt ${attempt}: request_id=${request.request_id} state=${request.state}`);

    // Ack validation: match actual conversational ack text (not request_id echo).
    // Source of truth for request_id is the DB row, not ack text.
    const ack = await waitForBotMessage(
      db,
      chatJid,
      baselineBotIds,
      sentMs,
      REQUEST_ACK_TIMEOUT_MS,
      (m) => /coordinating this with Jarvis|Got it/i.test(m.content),
    );
    if (!ack) {
      throw new Error(`${stage.name}: intake ack not received (attempt ${attempt})`);
    }
    const ackLatencyMs = Date.parse(ack.timestamp) - sentMs;
    if (!Number.isFinite(ackLatencyMs) || ackLatencyMs < 0 || ackLatencyMs > IMMEDIATE_REPLY_MAX_MS) {
      throw new Error(`${stage.name}: intake ack latency invalid ${ackLatencyMs} (attempt ${attempt})`);
    }
    console.log(`  [PASS] intake ack ${ackLatencyMs}ms, request_id=${request.request_id} (attempt ${attempt})`);

    await askStatusAndValidateImmediate(db, chatJid, baselineBotIds, token, request.request_id);

    const linkOutcome = await waitForRunLinkOrDispatchBlock(
      db,
      chatJid,
      request.request_id,
      baselineBotIds,
      sentMs,
      REQUEST_LINK_TIMEOUT_MS,
    );
    if (linkOutcome.kind === 'dispatch_blocked') {
      console.log(`  [WARN] dispatch blocked (attempt ${attempt}): ${linkOutcome.detail}`);
      if (attempt < MAX_STAGE_ATTEMPTS) {
        continue;
      }
      throw new Error(`${stage.name}: dispatch blocked after ${MAX_STAGE_ATTEMPTS} attempts`);
    }
    if (linkOutcome.kind === 'timeout') {
      console.log(`  [WARN] no worker link within timeout (attempt ${attempt})`);
      if (attempt < MAX_STAGE_ATTEMPTS) {
        continue;
      }
      throw new Error(`${stage.name}: request was not linked to worker run`);
    }

    const runId = linkOutcome.runId;
    console.log(`  linked worker_run_id=${runId} (attempt ${attempt})`);

    await askProgressAndValidateImmediate(db, chatJid, baselineBotIds, token);

    const terminal = await waitForWorkerRunTerminal(db, runId, RUN_TERMINAL_TIMEOUT_MS);
    if (!terminal) {
      throw new Error(`${stage.name}: worker run did not reach terminal status in time`);
    }
    if (RUN_TERMINAL_FAIL.has(terminal.status)) {
      throw new Error(`${stage.name}: worker run failed with status=${terminal.status}`);
    }
    console.log(`  [PASS] worker run terminal status=${terminal.status} phase=${terminal.phase ?? '-'}`);

    await askStatusAndValidateImmediate(db, chatJid, baselineBotIds, token, request.request_id);
    return;
  }

  throw new Error(`${stage.name}: exhausted attempts`);
}

async function main(): Promise<void> {
  const dbPath = process.env.DB_PATH || DEFAULT_DB_PATH;
  const db = new Database(dbPath, { readonly: false });
  const token = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const appFile = `userflow-${token}.html`;

  const stages: Stage[] = [
    {
      name: 'Build App',
      prompt: `@Andy Please delegate this to jarvis-worker-1 with a strict valid worker dispatch JSON. Build a tiny single-file todo web app named ${appFile}. Keep it minimal (input, add button, list) with inline JS/CSS and complete through the normal worker flow. Ensure required_fields includes run_id, branch, commit_sha, files_changed, test_result, risk, pr_skipped_reason.`,
      retryPrompt: `@Andy Retry Build App for ${appFile}. Previous dispatch was blocked or not linked. Send a strict validator-compliant dispatch to jarvis-worker-1. REQUIRED: output_contract.required_fields must include run_id, branch, commit_sha, files_changed, test_result, risk, pr_skipped_reason.`,
    },
    {
      name: 'Add Feature',
      prompt: `@Andy Please delegate this follow-up to jarvis-worker-1 with strict valid dispatch JSON: add filter controls (All, Active, Completed) to ${appFile} and keep implementation small. Keep required_fields validator-compliant.`,
      retryPrompt: `@Andy Retry Add Feature for ${appFile}. Previous dispatch was blocked or not linked. Send strict validator-compliant dispatch to jarvis-worker-1 with required_fields including run_id, branch, commit_sha, files_changed, test_result, risk, pr_skipped_reason.`,
    },
    {
      name: 'Customization',
      prompt: `@Andy Please delegate this customization to jarvis-worker-1 with strict valid dispatch JSON: apply a clean light theme, compact spacing, and clearer typography to ${appFile}. Keep required_fields validator-compliant.`,
      retryPrompt: `@Andy Retry Customization for ${appFile}. Previous dispatch was blocked or not linked. Send strict validator-compliant dispatch to jarvis-worker-1 with required_fields including run_id, branch, commit_sha, files_changed, test_result, risk, pr_skipped_reason.`,
    },
  ];

  try {
    const chatJid = getAndyChatJid(db);
    upsertChat(db, chatJid);
    const baselineBotIds = getBotIds(db, chatJid);

    console.log('=== Andy Full User Journey E2E ===');
    console.log(`db=${dbPath}`);
    console.log(`chat=${chatJid}`);
    console.log(`token=${token}`);
    console.log(`appFile=${appFile}`);

    for (const stage of stages) {
      await runStage(db, chatJid, baselineBotIds, token, stage);
    }

    console.log('\nPASS: full build -> feature -> customization user journey validated');
  } finally {
    db.close();
  }
}

main().catch((err) => {
  console.error('\nFAIL');
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
