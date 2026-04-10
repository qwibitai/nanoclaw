/**
 * Agent memory hooks — recall and capture.
 *
 * Recall: fetch relevant memories before each AI turn, format as
 * context block to prepend to the user prompt.
 *
 * Capture: after each AI turn, send the exchange to Supermemory
 * for fact extraction and profile building.
 *
 * Inspired by the OpenClaw Supermemory plugin pattern.
 */

import {
  isMemoryEnabled,
  recall,
  capture,
  type MemoryContext,
} from '../shared/memory-client.ts';
import { logger } from '../shared/logger.ts';

/**
 * Recall relevant memories for a user message.
 * Returns a formatted context block to prepend to the prompt,
 * or null if memory is disabled or no memories found.
 */
export async function recallMemories(
  userMessage: string,
): Promise<string | null> {
  if (!isMemoryEnabled()) return null;

  const ctx = await recall(userMessage);
  if (!ctx) return null;

  const block = formatMemoryContext(ctx);
  if (!block) return null;

  logger.info(
    {
      profileStatic: ctx.profile.static.length,
      profileDynamic: ctx.profile.dynamic.length,
      memories: ctx.searchResults.length,
    },
    'Memories recalled',
  );

  return block;
}

/**
 * Capture a conversation exchange for memory extraction.
 * Fire and forget — errors are logged but never block the response.
 */
export async function captureMemory(
  userMessage: string,
  assistantResponse: string,
  channel: string,
): Promise<void> {
  if (!isMemoryEnabled()) return;

  const content = formatCapturePayload(userMessage, assistantResponse);

  const ok = await capture(content, {
    source: 'nexus',
    channel,
    timestamp: new Date().toISOString(),
  });

  if (ok) {
    logger.debug({ channel }, 'Memory captured');
  }
}

// --- Formatting ---

/**
 * Format recalled memories into an XML context block.
 * Returns null if there's nothing to inject.
 */
function formatMemoryContext(ctx: MemoryContext): string | null {
  const sections: string[] = [];

  if (ctx.profile.static.length > 0) {
    sections.push(
      '## Profile\n' + ctx.profile.static.map((f) => `- ${f}`).join('\n'),
    );
  }

  if (ctx.profile.dynamic.length > 0) {
    sections.push(
      '## Recent Context\n' +
        ctx.profile.dynamic.map((f) => `- ${f}`).join('\n'),
    );
  }

  if (ctx.searchResults.length > 0) {
    const lines = ctx.searchResults.map((m) => {
      const pct = Math.round(m.score * 100);
      return `- [${pct}%] ${m.content}`;
    });
    sections.push('## Relevant Memories\n' + lines.join('\n'));
  }

  if (sections.length === 0) return null;

  return (
    '<nexus-memory>\n' +
    'Background context from long-term memory. Use this silently to inform ' +
    'your responses — do not mention these memories unless the conversation ' +
    'naturally calls for it.\n\n' +
    sections.join('\n\n') +
    '\n</nexus-memory>'
  );
}

/**
 * Format a conversation exchange for capture.
 * Sends the last user/assistant turn (not the full history).
 */
function formatCapturePayload(
  userMessage: string,
  assistantResponse: string,
): string {
  // Strip any previously injected memory context from the user message
  const cleanMessage = userMessage
    .replace(/<nexus-memory>[\s\S]*?<\/nexus-memory>\s*/g, '')
    .trim();

  return (
    `[role: user]\n${cleanMessage}\n[user:end]\n\n` +
    `[role: assistant]\n${assistantResponse}\n[assistant:end]`
  );
}
