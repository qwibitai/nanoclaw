/**
 * Output Reader for NanoClaw
 * Handles polling output files and parsing sentinel markers from agent sessions.
 */
import fs from 'fs';

import type { ContainerOutput } from './container-runner.js';

// Sentinel markers for robust output parsing (must match agent-runner)
export const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
export const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

// Polling interval for reading output file (ms)
export const OUTPUT_POLL_INTERVAL = 250;

export interface OutputReaderState {
  stdout: string;
  stdoutTruncated: boolean;
  bytesRead: number;
  parseBuffer: string;
  newSessionId: string | undefined;
  outputChain: Promise<void>;
  hadStreamingOutput: boolean;
}

export function createOutputReaderState(): OutputReaderState {
  return {
    stdout: '',
    stdoutTruncated: false,
    bytesRead: 0,
    parseBuffer: '',
    newSessionId: undefined,
    outputChain: Promise.resolve(),
    hadStreamingOutput: false,
  };
}

/**
 * Poll the output file for new data and parse sentinel markers.
 * Mutates the provided state object in place.
 */
export function pollOutput(
  outputFile: string,
  state: OutputReaderState,
  maxOutputSize: number,
  sessionName: string,
  log: { warn: (obj: object, msg: string) => void },
  onOutput: ((output: ContainerOutput) => Promise<void>) | undefined,
  resetTimeout: () => void,
): void {
  try {
    const stat = fs.statSync(outputFile);
    if (stat.size > state.bytesRead) {
      const fd = fs.openSync(outputFile, 'r');
      const newBytes = stat.size - state.bytesRead;
      const buffer = Buffer.alloc(newBytes);
      fs.readSync(fd, buffer, 0, newBytes, state.bytesRead);
      fs.closeSync(fd);
      state.bytesRead = stat.size;

      const chunk = buffer.toString('utf-8');

      // Accumulate for logging
      if (!state.stdoutTruncated) {
        const remaining = maxOutputSize - state.stdout.length;
        if (chunk.length > remaining) {
          state.stdout += chunk.slice(0, remaining);
          state.stdoutTruncated = true;
          log.warn(
            { sessionName, size: state.stdout.length },
            'Session stdout truncated due to size limit',
          );
        } else {
          state.stdout += chunk;
        }
      }

      // Stream-parse for output markers
      if (onOutput) {
        state.parseBuffer += chunk;
        let startIdx: number;
        while (
          (startIdx = state.parseBuffer.indexOf(OUTPUT_START_MARKER)) !== -1
        ) {
          const endIdx = state.parseBuffer.indexOf(OUTPUT_END_MARKER, startIdx);
          if (endIdx === -1) break;

          const jsonStr = state.parseBuffer
            .slice(startIdx + OUTPUT_START_MARKER.length, endIdx)
            .trim();
          state.parseBuffer = state.parseBuffer.slice(
            endIdx + OUTPUT_END_MARKER.length,
          );

          try {
            const parsed: ContainerOutput = JSON.parse(jsonStr);
            if (parsed.newSessionId) {
              state.newSessionId = parsed.newSessionId;
            }
            state.hadStreamingOutput = true;
            resetTimeout();
            state.outputChain = state.outputChain.then(() => onOutput(parsed));
          } catch (err) {
            log.warn(
              { sessionName, error: err },
              'Failed to parse streamed output chunk',
            );
          }
        }
      }
    }
  } catch {
    // File may not exist yet or be temporarily unavailable
  }
}

/** Clean up temporary files created for the session. */
export function cleanupTempFiles(...files: string[]): void {
  for (const file of files) {
    try {
      fs.unlinkSync(file);
    } catch {
      // ignore
    }
  }
}
