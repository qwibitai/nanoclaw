/**
 * Container Runner for NanoClaw
 * Spawns agent execution in containers and handles IPC.
 *
 * This file stays thin: it orchestrates spawn, stdio plumbing, and
 * exit handling. The interesting logic lives under `container-runner/`:
 *  - mount-builder.ts    — volume mount construction
 *  - container-args.ts   — argv for `docker run` / `podman run`
 *  - streaming-parser.ts — stdout OUTPUT_MARKER parsing (pure)
 *  - output-buffer.ts    — truncating stdout/stderr buffers
 *  - timeout-manager.ts  — idle-reset timer
 *  - snapshots.ts        — tasks.json + available_groups.json writers
 *  - types.ts            — shared types + sentinel markers
 */
import { ChildProcess, spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

import { OneCLI } from '@onecli-sh/sdk';

import {
  CONTAINER_MAX_OUTPUT_SIZE,
  CONTAINER_TIMEOUT,
  IDLE_TIMEOUT,
  ONECLI_URL,
} from './config.js';
import {
  CONTAINER_RUNTIME_BIN,
  stopContainer,
} from './container-runtime.js';
import { resolveGroupFolderPath } from './group-folder.js';
import { logger } from './logger.js';
import type { RegisteredGroup } from './types.js';

import { buildContainerArgs } from './container-runner/container-args.js';
import { buildVolumeMounts } from './container-runner/mount-builder.js';
import { TruncatingBuffer } from './container-runner/output-buffer.js';
import {
  consumeChunk,
  createStreamingParserState,
  parseLastOutput,
} from './container-runner/streaming-parser.js';
import { writeRunLog, writeTimeoutLog } from './container-runner/run-log.js';
import { createIdleTimer } from './container-runner/timeout-manager.js';
import type {
  ContainerInput,
  ContainerOutput,
} from './container-runner/types.js';

// Re-export the public API so `./container-runner.js` stays the single
// import path for every caller (orchestrator, tests, integration tests).
export {
  writeGroupsSnapshot,
  writeTasksSnapshot,
} from './container-runner/snapshots.js';
export type {
  AvailableGroup,
  ContainerInput,
  ContainerOutput,
  VolumeMount,
} from './container-runner/types.js';
export {
  OUTPUT_END_MARKER,
  OUTPUT_START_MARKER,
} from './container-runner/types.js';

const onecli = new OneCLI({ url: ONECLI_URL });

export async function runContainerAgent(
  group: RegisteredGroup,
  input: ContainerInput,
  onProcess: (proc: ChildProcess, containerName: string) => void,
  onOutput?: (output: ContainerOutput) => Promise<void>,
): Promise<ContainerOutput> {
  const startTime = Date.now();

  const groupDir = resolveGroupFolderPath(group.folder);
  fs.mkdirSync(groupDir, { recursive: true });

  const mounts = buildVolumeMounts(group, input.isMain);
  const safeName = group.folder.replace(/[^a-zA-Z0-9-]/g, '-');
  const containerName = `nanoclaw-${safeName}-${Date.now()}`;
  // Main group uses the default OneCLI agent; others use their own agent.
  const agentIdentifier = input.isMain
    ? undefined
    : group.folder.toLowerCase().replace(/_/g, '-');
  const containerArgs = await buildContainerArgs(
    onecli,
    mounts,
    containerName,
    agentIdentifier,
  );

  logger.debug(
    {
      group: group.name,
      containerName,
      mounts: mounts.map(
        (m) =>
          `${m.hostPath} -> ${m.containerPath}${m.readonly ? ' (ro)' : ''}`,
      ),
      containerArgs: containerArgs.join(' '),
    },
    'Container mount configuration',
  );

  logger.info(
    {
      group: group.name,
      containerName,
      mountCount: mounts.length,
      isMain: input.isMain,
    },
    'Spawning container agent',
  );

  const logsDir = path.join(groupDir, 'logs');
  fs.mkdirSync(logsDir, { recursive: true });

  return new Promise((resolve) => {
    const container = spawn(CONTAINER_RUNTIME_BIN, containerArgs, {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    onProcess(container, containerName);

    const stdoutBuf = new TruncatingBuffer(CONTAINER_MAX_OUTPUT_SIZE);
    const stderrBuf = new TruncatingBuffer(CONTAINER_MAX_OUTPUT_SIZE);

    container.stdin.write(JSON.stringify(input));
    container.stdin.end();

    const parserState = createStreamingParserState();
    let outputChain = Promise.resolve();
    let hadStreamingOutput = false;

    container.stdout.on('data', (data) => {
      const chunk = data.toString();

      const before = stdoutBuf.wasTruncated;
      stdoutBuf.append(chunk);
      if (!before && stdoutBuf.wasTruncated) {
        logger.warn(
          { group: group.name, size: stdoutBuf.length },
          'Container stdout truncated due to size limit',
        );
      }

      if (onOutput) {
        const { outputs, parseErrors } = consumeChunk(parserState, chunk);
        for (const err of parseErrors) {
          logger.warn(
            { group: group.name, error: err.error },
            'Failed to parse streamed output chunk',
          );
        }
        if (outputs.length > 0) {
          hadStreamingOutput = true;
          timer.reset();
          for (const parsed of outputs) {
            outputChain = outputChain.then(() =>
              onOutput(parsed).catch((err) =>
                logger.error(
                  { group: group.name, error: err },
                  'Output callback failed',
                ),
              ),
            );
          }
        }
      }
    });

    container.stderr.on('data', (data) => {
      const chunk = data.toString();
      const lines = chunk.trim().split('\n');
      for (const line of lines) {
        if (line) logger.debug({ container: group.folder }, line);
      }
      // Don't reset timeout on stderr — SDK writes debug logs continuously.
      const before = stderrBuf.wasTruncated;
      stderrBuf.append(chunk);
      if (!before && stderrBuf.wasTruncated) {
        logger.warn(
          { group: group.name, size: stderrBuf.length },
          'Container stderr truncated due to size limit',
        );
      }
    });

    let timedOut = false;
    const configTimeout = group.containerConfig?.timeout || CONTAINER_TIMEOUT;
    // Grace period: hard timeout must be at least IDLE_TIMEOUT + 30s so the
    // graceful _close sentinel has time to trigger before the hard kill fires.
    const timeoutMs = Math.max(configTimeout, IDLE_TIMEOUT + 30_000);

    const timer = createIdleTimer(timeoutMs, () => {
      timedOut = true;
      logger.error(
        { group: group.name, containerName },
        'Container timeout, stopping gracefully',
      );
      try {
        stopContainer(containerName);
        // eslint-disable-next-line no-catch-all/no-catch-all
      } catch (err) {
        logger.warn(
          { group: group.name, containerName, err },
          'Graceful stop failed, force killing',
        );
        container.kill('SIGKILL');
      }
    });

    container.on('close', (code) => {
      timer.clear();
      const duration = Date.now() - startTime;

      if (timedOut) {
        writeTimeoutLog(
          logsDir,
          group.name,
          containerName,
          duration,
          code,
          hadStreamingOutput,
        );

        if (hadStreamingOutput) {
          logger.info(
            { group: group.name, containerName, duration, code },
            'Container timed out after output (idle cleanup)',
          );
          outputChain.then(() => {
            resolve({
              status: 'success',
              result: null,
              newSessionId: parserState.newSessionId,
            });
          });
          return;
        }

        logger.error(
          { group: group.name, containerName, duration, code },
          'Container timed out with no output',
        );
        resolve({
          status: 'error',
          result: null,
          error: `Container timed out after ${configTimeout}ms`,
        });
        return;
      }

      writeRunLog({
        logsDir,
        groupName: group.name,
        input,
        containerArgs,
        mounts,
        duration,
        code,
        stdout: stdoutBuf.text,
        stdoutTruncated: stdoutBuf.wasTruncated,
        stderr: stderrBuf.text,
        stderrTruncated: stderrBuf.wasTruncated,
      });

      if (code !== 0) {
        logger.error(
          {
            group: group.name,
            code,
            duration,
            stderr: stderrBuf.text,
            stdout: stdoutBuf.text,
          },
          'Container exited with error',
        );
        resolve({
          status: 'error',
          result: null,
          error: `Container exited with code ${code}: ${stderrBuf.text.slice(-200)}`,
        });
        return;
      }

      // Streaming mode: wait for output chain to settle, return completion marker
      if (onOutput) {
        outputChain.then(() => {
          logger.info(
            {
              group: group.name,
              duration,
              newSessionId: parserState.newSessionId,
            },
            'Container completed (streaming mode)',
          );
          resolve({
            status: 'success',
            result: null,
            newSessionId: parserState.newSessionId,
          });
        });
        return;
      }

      // Legacy mode: parse the last output marker pair
      try {
        const output = parseLastOutput(stdoutBuf.text);
        logger.info(
          {
            group: group.name,
            duration,
            status: output.status,
            hasResult: !!output.result,
          },
          'Container completed',
        );
        resolve(output);
        // eslint-disable-next-line no-catch-all/no-catch-all
      } catch (err) {
        logger.error(
          {
            group: group.name,
            stdout: stdoutBuf.text,
            stderr: stderrBuf.text,
            error: err,
          },
          'Failed to parse container output',
        );
        resolve({
          status: 'error',
          result: null,
          error: `Failed to parse container output: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    });

    container.on('error', (err) => {
      timer.clear();
      logger.error(
        { group: group.name, containerName, error: err },
        'Container spawn error',
      );
      resolve({
        status: 'error',
        result: null,
        error: `Container spawn error: ${err.message}`,
      });
    });
  });
}

