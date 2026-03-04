/**
 * X (Twitter) Integration IPC Handler
 * Handles x_* IPC messages from container agents by spawning skill scripts.
 * Self-registers at import time via registerIpcHandler().
 */
import { spawn } from 'child_process';
import path from 'path';

import { logger } from '../logger.js';
import { registerIpcHandler } from './registry.js';

interface IpcResult {
  success: boolean;
  message: string;
  data?: unknown;
}

/** Run a skill script as subprocess, capturing stdout and stderr */
async function runScript(script: string, args: object): Promise<IpcResult> {
  const scriptPath = path.join(
    process.cwd(),
    '.claude',
    'skills',
    'x-integration',
    'scripts',
    `${script}.ts`,
  );

  return new Promise((resolve) => {
    const proc = spawn('npx', ['tsx', scriptPath], {
      cwd: process.cwd(),
      env: { ...process.env, NANOCLAW_ROOT: process.cwd() },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (data) => {
      stdout += data.toString();
    });
    proc.stderr.on('data', (data) => {
      stderr += data.toString();
    });
    proc.stdin.write(JSON.stringify(args));
    proc.stdin.end();

    const timer = setTimeout(() => {
      proc.kill('SIGTERM');
      resolve({ success: false, message: 'Script timed out (120s)' });
    }, 120_000);

    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        const detail = stderr.trim().slice(0, 200);
        resolve({
          success: false,
          message: `Script exited with code: ${code}${detail ? ` — ${detail}` : ''}`,
        });
        return;
      }
      try {
        const lines = stdout.trim().split('\n');
        resolve(JSON.parse(lines[lines.length - 1]));
      } catch {
        resolve({
          success: false,
          message: `Failed to parse output: ${stdout.slice(0, 200)}`,
        });
      }
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      resolve({ success: false, message: `Failed to spawn: ${err.message}` });
    });
  });
}

async function handleXIpc(
  msg: Record<string, unknown>,
  _groupFolder: string,
  isMain: boolean,
): Promise<IpcResult | null> {
  const type = msg.type as string;

  if (!type?.startsWith('x_')) return null;

  if (!isMain) {
    logger.warn({ type }, 'X integration blocked: not main group');
    return { success: false, message: 'X integration requires main group' };
  }

  logger.info({ type }, 'Processing X request');

  let result: IpcResult;

  switch (type) {
    case 'x_post':
      if (!msg.content) {
        result = { success: false, message: 'Missing content' };
        break;
      }
      result = await runScript('post', { content: msg.content });
      break;

    case 'x_like':
      if (!msg.tweetUrl) {
        result = { success: false, message: 'Missing tweetUrl' };
        break;
      }
      result = await runScript('like', { tweetUrl: msg.tweetUrl });
      break;

    case 'x_reply':
      if (!msg.tweetUrl || !msg.content) {
        result = { success: false, message: 'Missing tweetUrl or content' };
        break;
      }
      result = await runScript('reply', {
        tweetUrl: msg.tweetUrl,
        content: msg.content,
      });
      break;

    case 'x_retweet':
      if (!msg.tweetUrl) {
        result = { success: false, message: 'Missing tweetUrl' };
        break;
      }
      result = await runScript('retweet', { tweetUrl: msg.tweetUrl });
      break;

    case 'x_quote':
      if (!msg.tweetUrl || !msg.comment) {
        result = { success: false, message: 'Missing tweetUrl or comment' };
        break;
      }
      result = await runScript('quote', {
        tweetUrl: msg.tweetUrl,
        comment: msg.comment,
      });
      break;

    default:
      return null;
  }

  if (result.success) {
    logger.info({ type }, 'X request completed');
  } else {
    logger.error({ type, message: result.message }, 'X request failed');
  }
  return result;
}

// Self-register at import time
registerIpcHandler('x_', handleXIpc);
