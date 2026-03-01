/**
 * Quality Tracker — logs conversations with implicit quality signals to JSONL.
 *
 * Host-side module. No LLM call — pure heuristic signal extraction.
 * Appends to {groupPath}/store/conversations.jsonl.
 */
import fs from 'node:fs';
import path from 'node:path';

import { logger } from './logger.js';
import { scrubCredentials } from './redaction.js';
import type { ConversationLogEntry } from './schemas.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_FILE_SIZE = 1024 * 1024; // 1 MB per group
const MAX_MESSAGE_LENGTH = 2000; // chars per message (consistent with observer)

// ---------------------------------------------------------------------------
// Signal extraction — heuristic, no LLM
// ---------------------------------------------------------------------------

/** Patterns that indicate a positive signal (user satisfied). */
const POSITIVE_PATTERNS = [
  /\bthanks?\b/i,
  /\bthank you\b/i,
  /\bgot it\b/i,
  /\bperfect\b/i,
  /\bawesome\b/i,
  /\bgreat\b/i,
  /\bnice\b/i,
  /\blooks good\b/i,
  /\bwell done\b/i,
  /\bthat works\b/i,
  /\bexactly\b/i,
  /\b(?:thumbs up|👍|🙏|❤️|🎉)\b/i,
];

/** Patterns that indicate a negative signal (user correcting or frustrated). */
const NEGATIVE_PATTERNS = [
  /\bthat'?s (?:not|wrong)\b/i,
  /\bno[,.]?\s+(?:i said|i meant|i want|that's)\b/i,
  /\bwrong\b/i,
  /\bincorrect\b/i,
  /\bstop\b/i,
  /\bdon'?t do that\b/i,
  /\byou (?:misunderstood|didn'?t understand|got it wrong)\b/i,
  /\btry again\b/i,
  /\bactually[,.]?\s+(?:i|no|that)\b/i,
  /\bi already (?:said|told|mentioned)\b/i,
  /\bnot what i (?:asked|meant|wanted)\b/i,
];

export interface SignalResult {
  signal: 'positive' | 'negative' | 'neutral';
  evidence: string;
}

/**
 * Extract quality signal from the last user message(s).
 * Only looks at the last 2 user messages — the most recent reaction
 * to the bot's response is the strongest signal.
 */
export function extractSignal(
  userMessages: Array<{ content: string }>,
): SignalResult {
  // Check last 2 messages (most recent first)
  const recentMessages = userMessages.slice(-2).reverse();

  for (const msg of recentMessages) {
    const text = msg.content;

    for (const pattern of NEGATIVE_PATTERNS) {
      if (pattern.test(text)) {
        return {
          signal: 'negative',
          evidence: `Matched negative pattern: ${text.slice(0, 100)}`,
        };
      }
    }

    for (const pattern of POSITIVE_PATTERNS) {
      if (pattern.test(text)) {
        return {
          signal: 'positive',
          evidence: `Matched positive pattern: ${text.slice(0, 100)}`,
        };
      }
    }
  }

  return {
    signal: 'neutral',
    evidence: 'No positive or negative patterns detected',
  };
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

export async function trackConversationQuality(
  groupFolder: string,
  userMessages: Array<{
    sender_name: string;
    content: string;
    timestamp: string;
  }>,
  botResponses: string[],
): Promise<void> {
  try {
    // Kill switch
    if (process.env.QUALITY_TRACKER_ENABLED === 'false') return;

    // Need at least 1 user message
    if (!userMessages || userMessages.length === 0) return;

    // Resolve path (lazy import to avoid module-load cascade in tests)
    const { resolveGroupFolderPath } = await import('./group-folder.js');
    const groupPath = resolveGroupFolderPath(groupFolder);

    const storeDir = path.join(groupPath, 'store');
    const filePath = path.join(storeDir, 'conversations.jsonl');

    // File size cap — prevent unbounded growth
    if (fs.existsSync(filePath)) {
      try {
        const stat = fs.statSync(filePath);
        if (stat && stat.size >= MAX_FILE_SIZE) {
          logger.warn(
            { filePath, size: stat.size, maxSize: MAX_FILE_SIZE },
            'Conversations JSONL exceeds 1MB — skipping append',
          );
          return;
        }
      } catch {
        // statSync failed — proceed
      }
    }

    // Extract quality signal
    const { signal, evidence } = extractSignal(userMessages);

    // Build log entry with scrubbed content
    const entry: ConversationLogEntry = {
      groupFolder,
      timestamp: new Date().toISOString(),
      userMessages: userMessages.map((m) => ({
        sender: m.sender_name,
        content: scrubCredentials(m.content.slice(0, MAX_MESSAGE_LENGTH)),
        timestamp: m.timestamp,
      })),
      botResponses: botResponses.map((r) =>
        scrubCredentials(r.slice(0, MAX_MESSAGE_LENGTH)),
      ),
      signal,
      evidence,
    };

    // Append JSONL
    fs.mkdirSync(storeDir, { recursive: true });
    fs.appendFileSync(filePath, JSON.stringify(entry) + '\n', 'utf-8');

    logger.info(
      { groupFolder, signal, filePath },
      'Quality tracker logged conversation',
    );
  } catch (err) {
    logger.error(
      { err },
      'Quality tracker unexpected error (caught at top level)',
    );
  }
}
