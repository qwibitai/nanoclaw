/**
 * Output parsing for container agent stdout.
 *
 * Extracts structured JSON output from between sentinel markers emitted by
 * the agent-runner inside the container.
 */

import { logger } from './logger.js';

// Sentinel markers for robust output parsing (must match agent-runner)
export const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
export const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

export interface ParsedOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  error?: string;
}

/**
 * Parse the last output marker pair from accumulated stdout (legacy mode).
 * Falls back to reading the last non-empty line if no markers are found.
 */
export function parseLastOutput(stdout: string): ParsedOutput {
  const startIdx = stdout.indexOf(OUTPUT_START_MARKER);
  const endIdx = stdout.indexOf(OUTPUT_END_MARKER);

  let jsonLine: string;
  if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
    jsonLine = stdout
      .slice(startIdx + OUTPUT_START_MARKER.length, endIdx)
      .trim();
  } else {
    // Fallback: last non-empty line (backwards compatibility)
    const lines = stdout.trim().split('\n');
    jsonLine = lines[lines.length - 1];
  }

  return JSON.parse(jsonLine);
}

/**
 * Creates a streaming parser that extracts output marker pairs as they arrive
 * on stdout. Returns `push(chunk)` to feed data and the tracked `newSessionId`.
 */
export function createStreamParser(
  groupName: string,
  onOutput: (output: ParsedOutput) => Promise<void>,
  onActivity: () => void,
): {
  push: (chunk: string) => void;
  getNewSessionId: () => string | undefined;
  getHadOutput: () => boolean;
  waitForChain: () => Promise<void>;
} {
  let parseBuffer = '';
  let newSessionId: string | undefined;
  let hadOutput = false;
  let outputChain = Promise.resolve();

  return {
    push(chunk: string) {
      parseBuffer += chunk;
      let startIdx: number;
      while ((startIdx = parseBuffer.indexOf(OUTPUT_START_MARKER)) !== -1) {
        const endIdx = parseBuffer.indexOf(OUTPUT_END_MARKER, startIdx);
        if (endIdx === -1) break; // Incomplete pair, wait for more data

        const jsonStr = parseBuffer
          .slice(startIdx + OUTPUT_START_MARKER.length, endIdx)
          .trim();
        parseBuffer = parseBuffer.slice(endIdx + OUTPUT_END_MARKER.length);

        try {
          const parsed: ParsedOutput = JSON.parse(jsonStr);
          if (parsed.newSessionId) {
            newSessionId = parsed.newSessionId;
          }
          hadOutput = true;
          onActivity();
          outputChain = outputChain.then(() => onOutput(parsed));
        } catch (err) {
          logger.warn(
            { group: groupName, error: err },
            'Failed to parse streamed output chunk',
          );
        }
      }
    },
    getNewSessionId: () => newSessionId,
    getHadOutput: () => hadOutput,
    waitForChain: () => outputChain,
  };
}
