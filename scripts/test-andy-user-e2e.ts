/**
 * Live user-point-of-view smoke for andy-developer.
 *
 * This test writes synthetic user messages into the live DB (same path the app
 * processes), then waits for bot replies and enforces response criteria.
 *
 * Run with:
 *   npx tsx scripts/test-andy-user-e2e.ts
 */
import Database from 'better-sqlite3';

type MessageRow = {
  id: string;
  content: string;
  timestamp: string;
};

type Scenario = {
  name: string;
  userMessage: string;
  maxLatencyMs: number;
  expected: RegExp;
  forbidden?: RegExp;
};

const DEFAULT_DB_PATH = 'store/messages.db';
const POLL_INTERVAL_MS = 250;
const DEFAULT_TIMEOUT_MS = 20_000;
const TIMESTAMP_FLOOR_TOLERANCE_MS = 1_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function nowIsoWithOffset(offsetMs = 0): string {
  return new Date(Date.now() + offsetMs).toISOString();
}

function getAndyChatJid(db: Database.Database): string {
  const row = db.prepare(
    `SELECT jid
     FROM registered_groups
     WHERE folder = 'andy-developer'
     LIMIT 1`,
  ).get() as { jid: string } | undefined;
  if (!row?.jid) {
    throw new Error('andy-developer is not registered in registered_groups');
  }
  return row.jid;
}

function countRows(
  db: Database.Database,
  sql: string,
  ...params: Database.BindParameters
): number {
  const row = db.prepare(sql).get(...params) as { count: number } | undefined;
  return Number(row?.count ?? 0);
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
  ).run(chatJid, 'Andy-Developer', nowIsoWithOffset(), 'whatsapp', 1);
}

function getBotMessageIds(db: Database.Database, chatJid: string): Set<string> {
  const rows = db.prepare(
    `SELECT id
     FROM messages
     WHERE chat_jid = ? AND is_bot_message = 1`,
  ).all(chatJid) as Array<{ id: string }>;
  return new Set(rows.map((row) => row.id));
}

function insertUserMessage(
  db: Database.Database,
  chatJid: string,
  id: string,
  content: string,
): string {
  const timestamp = nowIsoWithOffset();
  db.prepare(
    `INSERT OR REPLACE INTO messages (
      id,
      chat_jid,
      sender,
      sender_name,
      content,
      timestamp,
      is_from_me,
      is_bot_message
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 0)`,
  ).run(id, chatJid, 'uat-user@nanoclaw', 'UAT User', content, timestamp, 1);
  db.prepare(`UPDATE chats SET last_message_time = ? WHERE jid = ?`).run(timestamp, chatJid);
  return timestamp;
}

async function waitForNextBotMessage(
  db: Database.Database,
  chatJid: string,
  baselineIds: Set<string>,
  minTimestampMs: number,
  timeoutMs: number,
): Promise<MessageRow | null> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const rows = db.prepare(
      `SELECT id, content, timestamp
       FROM messages
       WHERE chat_jid = ? AND is_bot_message = 1
       ORDER BY timestamp ASC, id ASC`,
    ).all(chatJid) as MessageRow[];

    for (const row of rows) {
      if (baselineIds.has(row.id)) continue;
      const rowMs = Date.parse(row.timestamp);
      if (!Number.isFinite(rowMs) || rowMs + TIMESTAMP_FLOOR_TOLERANCE_MS < minTimestampMs) continue;
      if (!baselineIds.has(row.id)) {
        return row;
      }
    }
    await sleep(POLL_INTERVAL_MS);
  }
  return null;
}

async function runScenario(
  db: Database.Database,
  chatJid: string,
  token: string,
  baselineIds: Set<string>,
  scenario: Scenario,
): Promise<void> {
  const messageId = `uat-${token}-${scenario.name.replace(/\s+/g, '-').toLowerCase()}`;
  const sentAt = insertUserMessage(db, chatJid, messageId, scenario.userMessage);
  const sentMs = Date.parse(sentAt);

  const bot = await waitForNextBotMessage(
    db,
    chatJid,
    baselineIds,
    sentMs,
    DEFAULT_TIMEOUT_MS,
  );
  if (!bot) {
    throw new Error(`${scenario.name}: timeout waiting for bot reply`);
  }
  baselineIds.add(bot.id);

  const repliedMs = Date.parse(bot.timestamp);
  const latencyMsRaw = repliedMs - sentMs;
  if (!Number.isFinite(latencyMsRaw) || latencyMsRaw < -TIMESTAMP_FLOOR_TOLERANCE_MS) {
    throw new Error(`${scenario.name}: invalid latency computed`);
  }
  const latencyMs = Math.max(0, latencyMsRaw);
  if (latencyMs > scenario.maxLatencyMs) {
    throw new Error(
      `${scenario.name}: latency ${latencyMs}ms exceeded limit ${scenario.maxLatencyMs}ms`,
    );
  }

  if (!scenario.expected.test(bot.content)) {
    throw new Error(
      `${scenario.name}: unexpected reply content: ${bot.content.slice(0, 240)}`,
    );
  }

  if (scenario.forbidden && scenario.forbidden.test(bot.content)) {
    throw new Error(
      `${scenario.name}: reply contains forbidden pattern: ${bot.content.slice(0, 240)}`,
    );
  }

  const preview = bot.content.replace(/\s+/g, ' ').slice(0, 160);
  console.log(
    `[PASS] ${scenario.name}: ${latencyMs}ms | ${preview}`,
  );
}

async function main(): Promise<void> {
  const dbPath = process.env.DB_PATH || DEFAULT_DB_PATH;
  const db = new Database(dbPath, { readonly: false });

  try {
    const chatJid = getAndyChatJid(db);
    upsertChat(db, chatJid);

    const token = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    console.log('=== Andy User-Facing E2E ===');
    console.log(`db: ${dbPath}`);
    console.log(`chat: ${chatJid}`);
    console.log(`token: ${token}`);

    const probeStartIso = nowIsoWithOffset();
    const baselineIds = getBotMessageIds(db, chatJid);

    const scenarios: Scenario[] = [
      {
        name: 'Simple Greeting',
        userMessage: '@Andy hi',
        maxLatencyMs: 8_000,
        expected: /(Hey, I'?m here|working on something|worker is still running)/i,
        forbidden: /(error|exception|traceback|failed)/i,
      },
      {
        name: 'Natural Status Query',
        userMessage: '@Andy what are you working on right now?',
        maxLatencyMs: 8_000,
        expected: /(Right now|Current progress|Current tracked requests|No worker run is active|There are no worker runs yet|working on)/i,
        forbidden: /(error|exception|traceback)/i,
      },
      {
        name: 'Progress Query',
        userMessage: '@Andy what is the current progress',
        maxLatencyMs: 8_000,
        expected:
          /(Right now|Current progress|Current tracked requests|No worker run is active|There are no worker runs yet|working on)/i,
        forbidden: /(error|exception|traceback)/i,
      },
    ];

    for (const scenario of scenarios) {
      await runScenario(db, chatJid, token, baselineIds, scenario);
    }

    const uatMessagePrefix = `uat-${token}-`;
    const trackedAsWork = countRows(
      db,
      `SELECT COUNT(*) AS count
       FROM andy_requests
       WHERE user_message_id LIKE ?`,
      `${uatMessagePrefix}%`,
    );
    if (trackedAsWork !== 0) {
      throw new Error(
        `Internal integrity failed: expected 0 andy_requests for status/greeting probes, found ${trackedAsWork}`,
      );
    }

    const unexpectedWorkerRuns = countRows(
      db,
      `SELECT COUNT(*) AS count
       FROM worker_runs
       WHERE started_at >= ?
         AND (
           COALESCE(dispatch_payload, '') LIKE ?
           OR COALESCE(dispatch_payload, '') LIKE ?
           OR run_id LIKE ?
         )`,
      probeStartIso,
      `%${token}%`,
      `%uat-%`,
      `uat-%`,
    );
    if (unexpectedWorkerRuns !== 0) {
      throw new Error(
        `Internal integrity failed: expected no worker dispatch from status/greeting probes, found ${unexpectedWorkerRuns}`,
      );
    }

    const raceFailuresDuringProbe = countRows(
      db,
      `SELECT COUNT(*) AS count
       FROM worker_runs
       WHERE completed_at >= ?
         AND status IN ('failed', 'failed_contract')
         AND COALESCE(error_details, '') LIKE '%running_without_container%'`,
      probeStartIso,
    );
    if (raceFailuresDuringProbe !== 0) {
      throw new Error(
        `Internal integrity failed: running_without_container failures observed during probe (${raceFailuresDuringProbe})`,
      );
    }

    console.log('PASS: all user-facing scenarios satisfied criteria');
    console.log('PASS: internal integrity checks satisfied criteria');
    console.log(
      'NEXT: run manual User POV Runbook in docs/workflow/delivery/nanoclaw-andy-user-happiness-gate.md',
    );
  } finally {
    db.close();
  }
}

main().catch((err) => {
  console.error('FAIL');
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
