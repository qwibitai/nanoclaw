/**
 * X Integration - JSON-RPC Handler Registration (Host Side)
 *
 * Registers handlers for all x_* JSON-RPC methods.
 * Each handler spawns a Playwright script subprocess.
 */

import { spawn } from 'child_process';
import path from 'path';
import { JSONRPCErrorException } from 'json-rpc-2.0';
import { registerHandler, type HandlerContext } from '../../../src/ipc-handlers/registry.js';
import { logger } from '../../../src/logger.js';

const ERR_UNAUTHORIZED = -32000;

interface SkillResult {
  success: boolean;
  message: string;
  data?: unknown;
}

async function runScript(script: string, args: object): Promise<SkillResult> {
  const scriptPath = path.join(process.cwd(), '.claude', 'skills', 'x-integration', 'scripts', `${script}.ts`);
  return new Promise((resolve) => {
    const proc = spawn('npx', ['tsx', scriptPath], {
      cwd: process.cwd(),
      env: { ...process.env, NANOCLAW_ROOT: process.cwd() },
      stdio: ['pipe', 'pipe', 'pipe']
    });

    let stdout = '';
    proc.stdout.on('data', (data) => { stdout += data.toString(); });
    proc.stdin.write(JSON.stringify(args));
    proc.stdin.end();

    const timer = setTimeout(() => {
      proc.kill('SIGTERM');
      resolve({ success: false, message: 'Script timed out (120s)' });
    }, 120000);

    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        resolve({ success: false, message: `Script exited with code: ${code}` });
        return;
      }
      try {
        const lines = stdout.trim().split('\n');
        resolve(JSON.parse(lines[lines.length - 1]));
      } catch {
        resolve({ success: false, message: `Failed to parse output: ${stdout.slice(0, 200)}` });
      }
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      resolve({ success: false, message: `Failed to spawn: ${err.message}` });
    });
  });
}

// --- x_post ---
registerHandler('x_post', async (params: { content: string }, context: HandlerContext) => {
  if (!context.isMain) {
    throw new JSONRPCErrorException('Only the main group can use X integration', ERR_UNAUTHORIZED);
  }
  if (!params.content) {
    throw new JSONRPCErrorException('Missing content', -32602);
  }
  logger.info({ type: 'x_post', sourceGroup: context.sourceGroup }, 'Processing X post request');
  return await runScript('post', { content: params.content });
});

// --- x_like ---
registerHandler('x_like', async (params: { tweetUrl: string }, context: HandlerContext) => {
  if (!context.isMain) {
    throw new JSONRPCErrorException('Only the main group can use X integration', ERR_UNAUTHORIZED);
  }
  if (!params.tweetUrl) {
    throw new JSONRPCErrorException('Missing tweetUrl', -32602);
  }
  logger.info({ type: 'x_like', sourceGroup: context.sourceGroup }, 'Processing X like request');
  return await runScript('like', { tweetUrl: params.tweetUrl });
});

// --- x_reply ---
registerHandler('x_reply', async (params: { tweetUrl: string; content: string }, context: HandlerContext) => {
  if (!context.isMain) {
    throw new JSONRPCErrorException('Only the main group can use X integration', ERR_UNAUTHORIZED);
  }
  if (!params.tweetUrl || !params.content) {
    throw new JSONRPCErrorException('Missing tweetUrl or content', -32602);
  }
  logger.info({ type: 'x_reply', sourceGroup: context.sourceGroup }, 'Processing X reply request');
  return await runScript('reply', { tweetUrl: params.tweetUrl, content: params.content });
});

// --- x_retweet ---
registerHandler('x_retweet', async (params: { tweetUrl: string }, context: HandlerContext) => {
  if (!context.isMain) {
    throw new JSONRPCErrorException('Only the main group can use X integration', ERR_UNAUTHORIZED);
  }
  if (!params.tweetUrl) {
    throw new JSONRPCErrorException('Missing tweetUrl', -32602);
  }
  logger.info({ type: 'x_retweet', sourceGroup: context.sourceGroup }, 'Processing X retweet request');
  return await runScript('retweet', { tweetUrl: params.tweetUrl });
});

// --- x_quote ---
registerHandler('x_quote', async (params: { tweetUrl: string; comment: string }, context: HandlerContext) => {
  if (!context.isMain) {
    throw new JSONRPCErrorException('Only the main group can use X integration', ERR_UNAUTHORIZED);
  }
  if (!params.tweetUrl || !params.comment) {
    throw new JSONRPCErrorException('Missing tweetUrl or comment', -32602);
  }
  logger.info({ type: 'x_quote', sourceGroup: context.sourceGroup }, 'Processing X quote request');
  return await runScript('quote', { tweetUrl: params.tweetUrl, comment: params.comment });
});
