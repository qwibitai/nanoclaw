import fs from 'fs';
import path from 'path';

import { GROUPS_DIR } from './config.js';
import { logger } from './logger.js';
import type { Channel } from './types.js';

export interface ThreadStreamContext {
  channel: Channel | undefined;
  chatJid: string;
  streamIntermediates: boolean;
  groupName: string;
  groupFolder: string;
  label: string; // for thought log filename slug
}

export interface ThreadStreamer {
  handleIntermediate(raw: string): Promise<void>;
  writeThoughtLog(): void;
}

/**
 * Create a ThreadStreamer that buffers intermediate output to a thought log
 * and optionally streams it to a channel thread (e.g. Discord).
 *
 * Graceful degradation: if thread creation fails, intermediates are still
 * captured in the thought log. No errors are thrown to the caller.
 */
export function createThreadStreamer(
  ctx: ThreadStreamContext,
  parentMessageId: string | null,
  threadName: string,
): ThreadStreamer {
  const thoughtLogBuffer: string[] = [];
  let thread: any = null;
  let threadCreationAttempted = false;

  const canStream =
    ctx.streamIntermediates &&
    !!ctx.channel?.createThread &&
    !!ctx.channel?.sendToThread &&
    !!parentMessageId;

  return {
    async handleIntermediate(raw: string): Promise<void> {
      thoughtLogBuffer.push(raw);

      if (!canStream) return;

      if (!threadCreationAttempted) {
        threadCreationAttempted = true;
        try {
          thread = await ctx.channel!.createThread!(ctx.chatJid, parentMessageId!, threadName);
        } catch {
          // Thread creation failed — silently degrade to thought-log only
        }
      }

      if (thread) {
        try {
          await ctx.channel!.sendToThread!(thread, raw);
        } catch {
          // Send failed — continue without thread output
        }
      }
    },

    writeThoughtLog(): void {
      if (thoughtLogBuffer.length === 0) return;

      try {
        const now = new Date();
        const date = now.toISOString().split('T')[0];
        const time = now.toISOString().split('T')[1].slice(0, 5).replace(':', '');
        const slug =
          ctx.label
            .trim()
            .slice(0, 50)
            .replace(/[^a-z0-9]+/gi, '-')
            .toLowerCase() || 'query';
        const filename = `${date}-${time}-${slug}.md`;
        const dir = path.join(GROUPS_DIR, 'global', 'thoughts', ctx.groupFolder);
        fs.mkdirSync(dir, { recursive: true });
        const header = `# ${ctx.groupName} — ${now.toLocaleString()}\n\n`;
        fs.writeFileSync(path.join(dir, filename), header + thoughtLogBuffer.join('\n\n---\n\n'));
        logger.debug({ group: ctx.groupName, filename }, 'Thought log written');
      } catch (err) {
        logger.warn({ group: ctx.groupName, err }, 'Failed to write thought log');
      }
    },
  };
}
