import fs from 'fs';
import path from 'path';

import { logger } from '../logger.js';

import type { ContainerInput, VolumeMount } from './types.js';

/**
 * Append a concise timeout log to `logsDir`. Called when the idle
 * timer fires and the container is being stopped.
 */
export function writeTimeoutLog(
  logsDir: string,
  groupName: string,
  containerName: string,
  duration: number,
  code: number | null,
  hadStreamingOutput: boolean,
): void {
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const timeoutLog = path.join(logsDir, `container-${ts}.log`);
  fs.writeFileSync(
    timeoutLog,
    [
      `=== Container Run Log (TIMEOUT) ===`,
      `Timestamp: ${new Date().toISOString()}`,
      `Group: ${groupName}`,
      `Container: ${containerName}`,
      `Duration: ${duration}ms`,
      `Exit Code: ${code}`,
      `Had Streaming Output: ${hadStreamingOutput}`,
    ].join('\n'),
  );
}

export interface RunLogOptions {
  logsDir: string;
  groupName: string;
  input: ContainerInput;
  containerArgs: string[];
  mounts: VolumeMount[];
  duration: number;
  code: number | null;
  stdout: string;
  stdoutTruncated: boolean;
  stderr: string;
  stderrTruncated: boolean;
}

/**
 * Write the detailed per-run log for a container invocation.
 * Verbose mode (LOG_LEVEL=debug|trace) includes the full input prompt;
 * normal mode only logs length + session id to avoid persisting user
 * conversation content on every non-zero exit.
 */
export function writeRunLog(opts: RunLogOptions): void {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const logFile = path.join(opts.logsDir, `container-${timestamp}.log`);
  const isVerbose =
    process.env.LOG_LEVEL === 'debug' || process.env.LOG_LEVEL === 'trace';

  const logLines = [
    `=== Container Run Log ===`,
    `Timestamp: ${new Date().toISOString()}`,
    `Group: ${opts.groupName}`,
    `IsMain: ${opts.input.isMain}`,
    `Duration: ${opts.duration}ms`,
    `Exit Code: ${opts.code}`,
    `Stdout Truncated: ${opts.stdoutTruncated}`,
    `Stderr Truncated: ${opts.stderrTruncated}`,
    ``,
  ];

  const isError = opts.code !== 0;

  if (isVerbose || isError) {
    if (isVerbose) {
      logLines.push(`=== Input ===`, JSON.stringify(opts.input, null, 2), ``);
    } else {
      logLines.push(
        `=== Input Summary ===`,
        `Prompt length: ${opts.input.prompt.length} chars`,
        `Session ID: ${opts.input.sessionId || 'new'}`,
        ``,
      );
    }
    logLines.push(
      `=== Container Args ===`,
      opts.containerArgs.join(' '),
      ``,
      `=== Mounts ===`,
      opts.mounts
        .map(
          (m) =>
            `${m.hostPath} -> ${m.containerPath}${m.readonly ? ' (ro)' : ''}`,
        )
        .join('\n'),
      ``,
      `=== Stderr${opts.stderrTruncated ? ' (TRUNCATED)' : ''} ===`,
      opts.stderr,
      ``,
      `=== Stdout${opts.stdoutTruncated ? ' (TRUNCATED)' : ''} ===`,
      opts.stdout,
    );
  } else {
    logLines.push(
      `=== Input Summary ===`,
      `Prompt length: ${opts.input.prompt.length} chars`,
      `Session ID: ${opts.input.sessionId || 'new'}`,
      ``,
      `=== Mounts ===`,
      opts.mounts
        .map((m) => `${m.containerPath}${m.readonly ? ' (ro)' : ''}`)
        .join('\n'),
      ``,
    );
  }

  fs.writeFileSync(logFile, logLines.join('\n'));
  logger.debug({ logFile, verbose: isVerbose }, 'Container log written');
}
