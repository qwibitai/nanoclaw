/**
 * X Integration IPC Handler
 *
 * Handles all x_* IPC messages from container agents.
 * This is the entry point for X integration in the host process.
 *
 * Returns a SkillResult that the caller sends back via WebSocket.
 * Full WS integration (routing x_* types in handleTaskIpc and sending
 * ipc_response messages) is a follow-up task.
 */

import { spawn } from 'child_process';
import path from 'path';
import pino from 'pino';

const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  transport: { target: 'pino-pretty', options: { colorize: true } }
});

export interface SkillResult {
  success: boolean;
  message: string;
  data?: unknown;
}

// Run a skill script as subprocess
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

/**
 * Handle X integration IPC messages.
 *
 * @returns SkillResult if message was handled, null if not an X message
 */
export async function handleXIpc(
  data: Record<string, unknown>,
  sourceGroup: string,
  isMain: boolean,
): Promise<SkillResult | null> {
  const type = data.type as string;

  // Only handle x_* types
  if (!type?.startsWith('x_')) {
    return null;
  }

  // Only main group can use X integration
  if (!isMain) {
    logger.warn({ sourceGroup, type }, 'X integration blocked: not main group');
    return { success: false, message: 'X integration requires main group' };
  }

  logger.info({ type }, 'Processing X request');

  let result: SkillResult;

  switch (type) {
    case 'x_post':
      if (!data.content) {
        result = { success: false, message: 'Missing content' };
        break;
      }
      result = await runScript('post', { content: data.content });
      break;

    case 'x_like':
      if (!data.tweetUrl) {
        result = { success: false, message: 'Missing tweetUrl' };
        break;
      }
      result = await runScript('like', { tweetUrl: data.tweetUrl });
      break;

    case 'x_reply':
      if (!data.tweetUrl || !data.content) {
        result = { success: false, message: 'Missing tweetUrl or content' };
        break;
      }
      result = await runScript('reply', { tweetUrl: data.tweetUrl, content: data.content });
      break;

    case 'x_retweet':
      if (!data.tweetUrl) {
        result = { success: false, message: 'Missing tweetUrl' };
        break;
      }
      result = await runScript('retweet', { tweetUrl: data.tweetUrl });
      break;

    case 'x_quote':
      if (!data.tweetUrl || !data.comment) {
        result = { success: false, message: 'Missing tweetUrl or comment' };
        break;
      }
      result = await runScript('quote', { tweetUrl: data.tweetUrl, comment: data.comment });
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
