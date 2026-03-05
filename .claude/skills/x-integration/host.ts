/**
 * X (Twitter) Integration IPC Handler
 * Handles x_* IPC messages from container agents by spawning skill scripts.
 * Self-registers at import time via registerIpcHandler().
 */
import { spawn } from 'child_process';
import path from 'path';

import { logger } from '../logger.js';
import { registerIpcHandler } from './registry.js';

/** Run a skill script as subprocess, capturing stdout and stderr */
async function runScript(script: string, args: object): Promise<unknown> {
  const scriptPath = path.join(
    process.cwd(),
    '.claude',
    'skills',
    'x-integration',
    'scripts',
    `${script}.ts`,
  );

  return new Promise((resolve, reject) => {
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
      reject(new Error('Script timed out (120s)'));
    }, 120_000);

    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        const detail = stderr.trim().slice(0, 200);
        reject(new Error(`Script exited with code: ${code}${detail ? ` — ${detail}` : ''}`));
        return;
      }
      try {
        const lines = stdout.trim().split('\n');
        resolve(JSON.parse(lines[lines.length - 1]));
      } catch {
        reject(new Error(`Failed to parse output: ${stdout.slice(0, 200)}`));
      }
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      reject(new Error(`Failed to spawn: ${err.message}`));
    });
  });
}

interface Action {
  script: string;
  required: string[];
  args: (p: Record<string, unknown>) => object;
}

const actions: Record<string, Action> = {
  x_post: { script: 'post', required: ['content'], args: (p) => ({ content: p.content }) },
  x_like: { script: 'like', required: ['tweetUrl'], args: (p) => ({ tweetUrl: p.tweetUrl }) },
  x_reply: { script: 'reply', required: ['tweetUrl', 'content'], args: (p) => ({ tweetUrl: p.tweetUrl, content: p.content }) },
  x_retweet: { script: 'retweet', required: ['tweetUrl'], args: (p) => ({ tweetUrl: p.tweetUrl }) },
  x_quote: { script: 'quote', required: ['tweetUrl', 'comment'], args: (p) => ({ tweetUrl: p.tweetUrl, comment: p.comment }) },
};

function createHandler(type: string, action: Action) {
  return async (
    params: Record<string, unknown>,
    _groupFolder: string,
    isMain: boolean,
  ): Promise<unknown> => {
    if (!isMain) {
      logger.warn({ type }, 'X integration blocked: not main group');
      throw new Error('X integration requires main group');
    }

    logger.info({ type }, 'Processing X request');

    const missing = action.required.filter((f) => !params[f]);
    if (missing.length > 0) {
      throw new Error(`Missing ${missing.join(' or ')}`);
    }

    const result = await runScript(action.script, action.args(params));
    logger.info({ type }, 'X request completed');
    return result;
  };
}

// Self-register each action type at import time
for (const [type, action] of Object.entries(actions)) {
  registerIpcHandler(type, createHandler(type, action));
}
