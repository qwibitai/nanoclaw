/**
 * Browser IPC Handler
 *
 * Handles `browser_command` IPC tasks from container agents.
 * Runs `agent-browser --headed <args>` on the host and returns
 * stdout/stderr/exitCode to the container via result files.
 */
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

import { logger } from './logger.js';

const COMMAND_TIMEOUT = 120_000;

interface BrowserResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

function writeResult(
  dataDir: string,
  sourceGroup: string,
  requestId: string,
  result: BrowserResult,
): void {
  const resultsDir = path.join(dataDir, 'ipc', sourceGroup, 'browser_results');
  fs.mkdirSync(resultsDir, { recursive: true });
  const tmpPath = path.join(resultsDir, `${requestId}.json.tmp`);
  const resultPath = path.join(resultsDir, `${requestId}.json`);
  fs.writeFileSync(tmpPath, JSON.stringify(result));
  fs.renameSync(tmpPath, resultPath);
}

/**
 * Handle browser_command IPC tasks.
 *
 * @returns true if the message was handled, false if not a browser command
 */
export async function handleBrowserIpc(
  data: Record<string, unknown>,
  sourceGroup: string,
  _isMain: boolean,
  dataDir: string,
): Promise<boolean> {
  if (data.type !== 'browser_command') return false;

  const requestId = data.requestId as string;
  const args = data.args as string[];

  if (!requestId || !Array.isArray(args) || args.length === 0) {
    logger.warn({ data }, 'browser_command: missing requestId or args');
    return true;
  }

  logger.info(
    { requestId, args: args.join(' ') },
    'Running headed browser command on host',
  );

  const result = await runAgentBrowser(args);

  writeResult(dataDir, sourceGroup, requestId, result);

  if (result.exitCode !== 0) {
    logger.warn(
      { requestId, exitCode: result.exitCode, stderr: result.stderr.slice(-200) },
      'Headed browser command failed',
    );
  } else {
    logger.debug({ requestId }, 'Headed browser command completed');
  }

  return true;
}

function runAgentBrowser(args: string[]): Promise<BrowserResult> {
  return new Promise((resolve) => {
    const proc = spawn('agent-browser', ['--headed', ...args], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    proc.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    const timer = setTimeout(() => {
      proc.kill('SIGTERM');
      resolve({ stdout, stderr: stderr + '\nCommand timed out', exitCode: 1 });
    }, COMMAND_TIMEOUT);

    proc.on('close', (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, exitCode: code ?? 1 });
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      resolve({ stdout: '', stderr: err.message, exitCode: 1 });
    });
  });
}
