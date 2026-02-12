/**
 * Shared output stream parser for NanoClaw backends.
 * Parses OUTPUT_START_MARKER/OUTPUT_END_MARKER pairs from agent stdout,
 * handles timeout management and startup detection.
 */

import { logger } from '../logger.js';
import { ContainerOutput } from './types.js';

// Sentinel markers for robust output parsing (must match agent-runner)
export const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
export const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

export interface StreamParserOptions {
  groupName: string;
  containerName: string;
  timeoutMs: number;
  startupTimeoutMs: number;
  maxOutputSize: number;
  onOutput?: (output: ContainerOutput) => Promise<void>;
  onTimeout: () => void;
}

export interface StreamParserState {
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  timedOut: boolean;
  hadStreamingOutput: boolean;
  newSessionId: string | undefined;
  outputChain: Promise<void>;
}

export class StreamParser {
  private parseBuffer = '';
  private state: StreamParserState;
  private timeout: ReturnType<typeof setTimeout>;
  private startupTimer: ReturnType<typeof setTimeout> | null;
  private opts: StreamParserOptions;

  constructor(opts: StreamParserOptions) {
    this.opts = opts;
    this.state = {
      stdout: '',
      stderr: '',
      stdoutTruncated: false,
      stderrTruncated: false,
      timedOut: false,
      hadStreamingOutput: false,
      newSessionId: undefined,
      outputChain: Promise.resolve(),
    };

    this.timeout = setTimeout(() => this.handleTimeout(), opts.timeoutMs);

    this.startupTimer = setTimeout(() => {
      logger.error(
        { group: opts.groupName, container: opts.containerName, timeoutMs: opts.startupTimeoutMs },
        'Container produced no stderr output during startup — likely stuck, killing',
      );
      this.handleTimeout();
    }, opts.startupTimeoutMs);
  }

  private handleTimeout(): void {
    this.state.timedOut = true;
    this.opts.onTimeout();
  }

  private resetTimeout(): void {
    clearTimeout(this.timeout);
    this.timeout = setTimeout(() => this.handleTimeout(), this.opts.timeoutMs);
  }

  /** Feed a chunk of stderr data. Clears startup timer on first chunk. */
  feedStderr(chunk: string): void {
    if (this.startupTimer) {
      clearTimeout(this.startupTimer);
      this.startupTimer = null;
    }

    const lines = chunk.trim().split('\n');
    for (const line of lines) {
      if (line) logger.info({ container: this.opts.groupName }, line);
    }

    if (this.state.stderrTruncated) return;
    const remaining = this.opts.maxOutputSize - this.state.stderr.length;
    if (chunk.length > remaining) {
      this.state.stderr += chunk.slice(0, remaining);
      this.state.stderrTruncated = true;
      logger.warn(
        { group: this.opts.groupName, size: this.state.stderr.length },
        'Container stderr truncated due to size limit',
      );
    } else {
      this.state.stderr += chunk;
    }
  }

  /** Feed a chunk of stdout data. Parses output markers and triggers callbacks. */
  feedStdout(chunk: string): void {
    // Accumulate for logging
    if (!this.state.stdoutTruncated) {
      const remaining = this.opts.maxOutputSize - this.state.stdout.length;
      if (chunk.length > remaining) {
        this.state.stdout += chunk.slice(0, remaining);
        this.state.stdoutTruncated = true;
        logger.warn(
          { group: this.opts.groupName, size: this.state.stdout.length },
          'Container stdout truncated due to size limit',
        );
      } else {
        this.state.stdout += chunk;
      }
    }

    // Stream-parse for output markers
    if (this.opts.onOutput) {
      this.parseBuffer += chunk;
      let startIdx: number;
      while ((startIdx = this.parseBuffer.indexOf(OUTPUT_START_MARKER)) !== -1) {
        const endIdx = this.parseBuffer.indexOf(OUTPUT_END_MARKER, startIdx);
        if (endIdx === -1) break; // Incomplete pair, wait for more data

        const jsonStr = this.parseBuffer
          .slice(startIdx + OUTPUT_START_MARKER.length, endIdx)
          .trim();
        this.parseBuffer = this.parseBuffer.slice(endIdx + OUTPUT_END_MARKER.length);

        try {
          const parsed: ContainerOutput = JSON.parse(jsonStr);
          if (parsed.newSessionId) {
            this.state.newSessionId = parsed.newSessionId;
          }
          this.state.hadStreamingOutput = true;
          this.resetTimeout();
          const onOutput = this.opts.onOutput;
          this.state.outputChain = this.state.outputChain.then(() => onOutput(parsed));
        } catch (err) {
          logger.warn(
            { group: this.opts.groupName, error: err },
            'Failed to parse streamed output chunk',
          );
        }
      }
    }
  }

  /** Parse the final stdout for legacy (non-streaming) mode. */
  parseFinalOutput(): ContainerOutput {
    const { stdout } = this.state;
    const startIdx = stdout.indexOf(OUTPUT_START_MARKER);
    const endIdx = stdout.indexOf(OUTPUT_END_MARKER);

    let jsonLine: string;
    if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
      jsonLine = stdout
        .slice(startIdx + OUTPUT_START_MARKER.length, endIdx)
        .trim();
    } else {
      const lines = stdout.trim().split('\n');
      jsonLine = lines[lines.length - 1];
    }

    return JSON.parse(jsonLine);
  }

  /** Clean up all timers. Call when the process exits. */
  cleanup(): void {
    clearTimeout(this.timeout);
    if (this.startupTimer) {
      clearTimeout(this.startupTimer);
      this.startupTimer = null;
    }
  }

  getState(): StreamParserState {
    return this.state;
  }
}
