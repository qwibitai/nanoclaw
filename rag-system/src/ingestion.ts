import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { getConfig } from './config.js';
import { embedBatch } from './embeddings.js';
import {
  qdrantClient,
  messageIdToUuid,
  MessageEmbedding,
} from './database/qdrant-client.js';

const WATERMARK_DIR = path.join(process.cwd(), 'data');
const WATERMARK_PATH = path.join(WATERMARK_DIR, 'ingestion-watermark.json');

interface WatermarkData {
  lastTimestamp: string;
}

interface RawMessage {
  id: string;
  chat_jid: string;
  sender: string;
  sender_name: string;
  content: string;
  timestamp: string;
  group_name: string | null;
}

function readWatermark(): WatermarkData | null {
  try {
    if (fs.existsSync(WATERMARK_PATH)) {
      return JSON.parse(fs.readFileSync(WATERMARK_PATH, 'utf-8'));
    }
  } catch {
    // Corrupt watermark file — treat as fresh start
  }
  return null;
}

function writeWatermark(data: WatermarkData): void {
  fs.mkdirSync(WATERMARK_DIR, { recursive: true });
  fs.writeFileSync(WATERMARK_PATH, JSON.stringify(data, null, 2));
}

function openNanoclawDb(): Database.Database {
  const config = getConfig();
  const dbPath = config.ingestion.nanoclawDbPath;

  if (!fs.existsSync(dbPath)) {
    throw new Error(`NanoClaw database not found at ${dbPath}`);
  }

  return new Database(dbPath, { readonly: true });
}

function fetchMessages(
  db: Database.Database,
  afterTimestamp: string,
  limit: number,
): RawMessage[] {
  return db
    .prepare(
      `
      SELECT m.id, m.chat_jid, m.sender, m.sender_name, m.content, m.timestamp,
             c.name AS group_name
      FROM messages m
      LEFT JOIN chats c ON m.chat_jid = c.jid
      WHERE m.timestamp > ?
        AND m.is_bot_message = 0
        AND m.content IS NOT NULL
        AND m.content != ''
      ORDER BY m.timestamp ASC
      LIMIT ?
      `,
    )
    .all(afterTimestamp, limit) as RawMessage[];
}

async function processBatch(messages: RawMessage[]): Promise<number> {
  if (messages.length === 0) return 0;

  const texts = messages.map((m) => {
    const prefix = m.sender_name || m.sender;
    const group = m.group_name ? ` [${m.group_name}]` : '';
    return `${prefix}${group}: ${m.content}`;
  });

  const vectors = await embedBatch(texts);

  const embeddings: MessageEmbedding[] = messages.map((m, i) => ({
    id: messageIdToUuid(m.id, m.chat_jid),
    vector: vectors[i],
    payload: {
      message_id: m.id,
      chat_jid: m.chat_jid,
      sender: m.sender,
      sender_name: m.sender_name,
      content: m.content,
      timestamp: m.timestamp,
      group_name: m.group_name || undefined,
    },
  }));

  await qdrantClient.upsertEmbeddings(embeddings);
  return embeddings.length;
}

/**
 * Ingest new messages since the last watermark.
 * Returns the number of messages ingested.
 */
export async function ingestNewMessages(): Promise<number> {
  const config = getConfig();
  const watermark = readWatermark();

  if (!watermark) {
    console.log('No watermark found — run backfill first');
    return 0;
  }

  const db = openNanoclawDb();
  try {
    const messages = fetchMessages(
      db,
      watermark.lastTimestamp,
      config.ingestion.batchSize,
    );

    if (messages.length === 0) return 0;

    const count = await processBatch(messages);
    const lastTimestamp = messages[messages.length - 1].timestamp;
    writeWatermark({ lastTimestamp });
    console.log(
      `Ingested ${count} messages (up to ${lastTimestamp})`,
    );
    return count;
  } finally {
    db.close();
  }
}

/**
 * Backfill all messages from scratch. Processes in batches with a delay
 * between batches to stay under OpenAI rate limits.
 */
export async function runBackfillIfNeeded(): Promise<void> {
  const watermark = readWatermark();
  if (watermark) {
    console.log(`Watermark exists at ${watermark.lastTimestamp}, skipping backfill`);
    return;
  }

  console.log('Starting full backfill...');

  const config = getConfig();
  const db = openNanoclawDb();
  let lastTimestamp = '1970-01-01T00:00:00.000Z';
  let totalIngested = 0;

  try {
    while (true) {
      const messages = fetchMessages(
        db,
        lastTimestamp,
        config.ingestion.batchSize,
      );

      if (messages.length === 0) break;

      const count = await processBatch(messages);
      totalIngested += count;
      lastTimestamp = messages[messages.length - 1].timestamp;
      writeWatermark({ lastTimestamp });

      console.log(
        `Backfill progress: ${totalIngested} messages (up to ${lastTimestamp})`,
      );

      // 1s delay between batches to avoid API rate limits
      if (messages.length === config.ingestion.batchSize) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }
  } finally {
    db.close();
  }

  console.log(`Backfill complete: ${totalIngested} messages indexed`);
}

/**
 * Run periodic ingestion loop. Keeps ingesting until no new messages remain,
 * to handle cases where more than one batch arrived since last poll.
 */
export async function runIngestionCycle(): Promise<void> {
  try {
    let totalIngested = 0;
    let batchCount: number;

    do {
      batchCount = await ingestNewMessages();
      totalIngested += batchCount;
    } while (batchCount > 0);

    if (totalIngested > 0) {
      console.log(`Ingestion cycle complete: ${totalIngested} new messages`);
    }
  } catch (error) {
    console.error('Ingestion cycle failed:', error);
  }
}

// Allow running directly: tsx src/ingestion.ts
if (process.argv[1]?.endsWith('ingestion.ts')) {
  (async () => {
    const { loadConfig } = await import('./config.js');
    const { initialize } = await import('./embeddings.js');

    loadConfig();
    initialize();
    await qdrantClient.initializeCollection();
    await runBackfillIfNeeded();

    // Keep ingesting until caught up
    let count: number;
    do {
      count = await ingestNewMessages();
    } while (count > 0);

    console.log('Manual ingestion complete');
    process.exit(0);
  })();
}
