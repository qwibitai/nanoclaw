/**
 * Live user-point-of-view smoke for the main lane control-plane status flow.
 *
 * This validates that natural-language questions about andy-developer status
 * are answered using the main lane's deterministic status tool rather than a
 * generic "no visibility" fallback.
 *
 * Run with:
 *   node --experimental-transform-types scripts/test-main-lane-status-e2e.ts
 */
import Database from 'better-sqlite3';

type MessageRow = {
  id: string;
  content: string;
  timestamp: string;
};

type LatestMessageState = {
  latest_bot_timestamp: string | null;
  latest_user_timestamp: string | null;
};

type Scenario = {
  name: string;
  userMessage: string;
  maxLatencyMs: number;
};

const DEFAULT_DB_PATH = 'store/messages.db';
const POLL_INTERVAL_MS = 250;
const DEFAULT_TIMEOUT_MS = 30_000;
const IDLE_WAIT_TIMEOUT_MS = 60_000;
const TIMESTAMP_FLOOR_TOLERANCE_MS = 1_000;
const STATUS_SIGNAL_PATTERN =
  /(andy-developer status|Availability|Current run|Current tracked requests|requests awaiting review|Active request|worker_review_requested|\b(?:queued|busy|idle|offline)\b|No worker run is active right now|There are no worker runs yet|Latest run)/i;
const FORBIDDEN_PATTERN =
  /(I don't have direct visibility|I do not have direct visibility|can't see what andy-developer is doing|cannot see what andy-developer is doing|don't have visibility into andy-developer)/i;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function nowIsoWithOffset(offsetMs = 0): string {
  return new Date(Date.now() + offsetMs).toISOString();
}

function getMainChatJid(db: Database.Database): string {
  const row = db.prepare(
    `SELECT jid
     FROM registered_groups
     WHERE folder IN ('main', 'whatsapp_main')
     LIMIT 1`,
  ).get() as { jid: string } | undefined;
  if (!row?.jid) {
    throw new Error('main lane is not registered in registered_groups');
  }
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
  ).run(chatJid, 'main', nowIsoWithOffset(), 'whatsapp', 1);
}

function getBotMessageIds(db: Database.Database, chatJid: string): Set<string> {
  const rows = db.prepare(
    `SELECT id
     FROM messages
     WHERE chat_jid = ? AND is_bot_message = 1`,
  ).all(chatJid) as Array<{ id: string }>;
  return new Set(rows.map((row) => row.id));
}

function getLatestMessageState(
  db: Database.Database,
  chatJid: string,
): LatestMessageState {
  return db.prepare(
    `SELECT
       MAX(CASE WHEN is_bot_message = 1 THEN timestamp END) AS latest_bot_timestamp,
       MAX(CASE WHEN is_bot_message = 0 THEN timestamp END) AS latest_user_timestamp
     FROM messages
     WHERE chat_jid = ?`,
  ).get(chatJid) as LatestMessageState;
}

async function waitForIdleMainLane(
  db: Database.Database,
  chatJid: string,
): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < IDLE_WAIT_TIMEOUT_MS) {
    const state = getLatestMessageState(db, chatJid);
    const latestUserMs = state.latest_user_timestamp
      ? Date.parse(state.latest_user_timestamp)
      : NaN;
    const latestBotMs = state.latest_bot_timestamp
      ? Date.parse(state.latest_bot_timestamp)
      : NaN;

    if (!Number.isFinite(latestUserMs)) return;
    if (Number.isFinite(latestBotMs) && latestBotMs + TIMESTAMP_FLOOR_TOLERANCE_MS >= latestUserMs) {
      return;
    }

    await sleep(POLL_INTERVAL_MS);
  }

  throw new Error('main lane did not become idle before the status probe started');
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
  db.prepare(`UPDATE chats SET last_message_time = ? WHERE jid = ?`).run(
    timestamp,
    chatJid,
  );
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
      if (!Number.isFinite(rowMs) || rowMs + TIMESTAMP_FLOOR_TOLERANCE_MS < minTimestampMs) {
        continue;
      }
      return row;
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
  const messageId = `uat-main-${token}-${scenario.name.replace(/\s+/g, '-').toLowerCase()}`;
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

  if (!STATUS_SIGNAL_PATTERN.test(bot.content)) {
    throw new Error(
      `${scenario.name}: reply did not include concrete status details: ${bot.content.slice(0, 240)}`,
    );
  }

  if (FORBIDDEN_PATTERN.test(bot.content)) {
    throw new Error(
      `${scenario.name}: reply fell back to generic no-visibility text: ${bot.content.slice(0, 240)}`,
    );
  }

  const preview = bot.content.replace(/\s+/g, ' ').slice(0, 180);
  console.log(`[PASS] ${scenario.name}: ${latencyMs}ms | ${preview}`);
}

async function main(): Promise<void> {
  const dbPath = process.env.DB_PATH || DEFAULT_DB_PATH;
  const db = new Database(dbPath, { readonly: false });

  try {
    const chatJid = getMainChatJid(db);
    upsertChat(db, chatJid);
    await waitForIdleMainLane(db, chatJid);

    const token = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    console.log('=== Main Lane Control-Plane Status E2E ===');
    console.log(`db: ${dbPath}`);
    console.log(`chat: ${chatJid}`);
    console.log(`token: ${token}`);

    const baselineIds = getBotMessageIds(db, chatJid);
    const scenarios: Scenario[] = [
      {
        name: 'Natural Status Query',
        userMessage: 'Do you have a view of Andy developer and its status',
        maxLatencyMs: 30_000,
      },
      {
        name: 'What Is Andy Doing',
        userMessage: 'What is Andy developer doing right now?',
        maxLatencyMs: 30_000,
      },
    ];

    for (const scenario of scenarios) {
      await runScenario(db, chatJid, token, baselineIds, scenario);
    }

    console.log('[PASS] main lane control-plane status E2E');
  } finally {
    db.close();
  }
}

main().catch((err) => {
  console.error('[FAIL] main lane control-plane status E2E');
  console.error(err instanceof Error ? err.stack || err.message : String(err));
  process.exit(1);
});
