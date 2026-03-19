/**
 * Output utilities — container result framing and transcript archiving.
 * Extracted from index.ts for testability (kaizen #167).
 * No SDK dependencies — only uses fs, path, and lib.ts functions.
 */

import fs from 'fs';
import path from 'path';
import {
  ContainerOutput,
  sanitizeFilename,
  generateFallbackName,
  parseTranscript,
  formatTranscriptMarkdown,
  getSessionSummary,
} from './lib.js';

export const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
export const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

/**
 * Write a container output result wrapped in start/end markers.
 * The host parses these markers to extract results from container stdout.
 *
 * @param output The container output object
 * @param logFn Optional log function (defaults to console.log). Injectable for testing.
 */
export function writeOutput(
  output: ContainerOutput,
  logFn: (msg: string) => void = console.log,
): void {
  logFn(OUTPUT_START_MARKER);
  logFn(JSON.stringify(output));
  logFn(OUTPUT_END_MARKER);
}

/**
 * Create a PreCompact hook that archives the full transcript before compaction.
 *
 * @param conversationsDir Directory to write archived conversations to
 * @param assistantName Optional name for the assistant in the transcript
 */
export function createPreCompactHook(
  conversationsDir: string,
  assistantName?: string,
) {
  return async (
    input: { transcript_path?: string; session_id?: string },
    _toolUseId: unknown,
    _context: unknown,
  ): Promise<Record<string, unknown>> => {
    const transcriptPath = input.transcript_path;
    const sessionId = input.session_id;

    if (!transcriptPath || !fs.existsSync(transcriptPath)) {
      return {};
    }

    try {
      const content = fs.readFileSync(transcriptPath, 'utf-8');
      const messages = parseTranscript(content);

      if (messages.length === 0) {
        return {};
      }

      const summary = getSessionSummary(sessionId || '', transcriptPath);
      const name = summary ? sanitizeFilename(summary) : generateFallbackName();

      fs.mkdirSync(conversationsDir, { recursive: true });

      const date = new Date().toISOString().split('T')[0];
      const filename = `${date}-${name}.md`;
      const filePath = path.join(conversationsDir, filename);

      const markdown = formatTranscriptMarkdown(
        messages,
        summary,
        assistantName,
      );
      fs.writeFileSync(filePath, markdown);
    } catch {
      // Fail silently — archiving should never block compaction
    }

    return {};
  };
}
