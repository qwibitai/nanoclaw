/**
 * Custom session compaction for non-Claude models (Ollama).
 *
 * When a session's input_tokens exceed COMPACT_TOKEN_THRESHOLD, this module
 * summarizes recent conversation via a fast Ollama model (COMPACT_MODEL) and
 * writes the summary to the group directory. On the next fresh session, the
 * agent picks up the summary file for prior context.
 */

import fs from 'fs';
import path from 'path';
import {
  COMPACT_MODEL,
  COMPACT_TOKEN_THRESHOLD,
  GROUPS_DIR,
} from './config.js';
import { getRecentMessages, deleteSession } from './db.js';
import { logger } from './logger.js';

const OLLAMA_URL = 'http://localhost:11434';
const SUMMARY_FILENAME = 'conversation_summary.md';

export { COMPACT_TOKEN_THRESHOLD };

/**
 * Check whether a session should be compacted based on token usage.
 */
export function shouldCompact(inputTokens: number): boolean {
  return inputTokens >= COMPACT_TOKEN_THRESHOLD;
}

/**
 * Run compaction: summarize recent messages, write summary file, delete session.
 */
export async function compactSession(
  groupFolder: string,
  chatJid: string,
): Promise<boolean> {
  const messages = getRecentMessages(chatJid, 60);
  if (messages.length === 0) {
    logger.warn({ groupFolder }, 'Compaction: no messages to summarize');
    return false;
  }

  // Build a conversation transcript for the summarizer
  const transcript = messages
    .map((m) => {
      const name = m.sender_name || m.sender || 'Unknown';
      return `[${name}]: ${m.content}`;
    })
    .join('\n');

  const summaryPrompt = `You are a concise summarizer. Below is a conversation transcript from a family Discord channel. Summarize the key information, decisions, and context that would be useful for an assistant resuming this conversation. Focus on:
- What topics were discussed
- Any pending tasks or requests
- Important facts mentioned (names, times, events)
- The emotional tone and any ongoing situations

Keep the summary under 500 words. Write in present tense as a briefing.

---
${transcript}
---

Summary:`;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 60000);

    const res = await fetch(`${OLLAMA_URL}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: COMPACT_MODEL,
        prompt: summaryPrompt,
        stream: false,
        options: { num_predict: 1024 },
      }),
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!res.ok) {
      logger.error(
        { groupFolder, status: res.status },
        'Compaction: Ollama request failed',
      );
      return false;
    }

    const data = (await res.json()) as { response?: string };
    const summary = data.response?.trim();
    if (!summary) {
      logger.warn({ groupFolder }, 'Compaction: empty summary returned');
      return false;
    }

    // Write summary to group directory
    const groupDir = path.resolve(GROUPS_DIR, groupFolder);
    const summaryPath = path.join(groupDir, SUMMARY_FILENAME);
    const header = `<!-- Auto-generated conversation summary (${new Date().toISOString()}) -->\n\n`;
    fs.writeFileSync(summaryPath, header + summary + '\n');

    // Delete the session so next message starts fresh
    deleteSession(groupFolder);

    logger.info(
      {
        groupFolder,
        messageCount: messages.length,
        summaryLen: summary.length,
      },
      'Compaction: session summarized and reset',
    );

    return true;
  } catch (err) {
    logger.error(
      { groupFolder, err: err instanceof Error ? err.message : String(err) },
      'Compaction: failed',
    );
    return false;
  }
}
