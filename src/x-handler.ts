/**
 * X Integration IPC Handler
 *
 * Handles all x_* IPC messages from container agents.
 * Spawns browser automation scripts on the host.
 */

import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

import { logger } from './logger.js';
import { readEnvFile } from './env.js';

interface SkillResult {
  success: boolean;
  message: string;
  data?: unknown;
}

// Run a skill script as subprocess
async function runScript(scriptPath: string, args: object): Promise<SkillResult> {

  return new Promise((resolve) => {
    const npxPath = process.env.NPX_PATH || '/opt/homebrew/bin/npx';
    // Ensure PATH includes Homebrew bin for node/npx (launchd has limited PATH)
    const scriptEnv = {
      ...process.env,
      NANOCLAW_ROOT: process.cwd(),
      PATH: `/opt/homebrew/bin:${process.env.PATH || '/usr/local/bin:/usr/bin:/bin'}`,
    };
    const proc = spawn(npxPath, ['tsx', scriptPath], {
      cwd: process.cwd(),
      env: scriptEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
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

// Resolve a skill script path
function skillScriptPath(skill: string, script: string): string {
  return path.join(process.cwd(), '.claude', 'skills', skill, 'scripts', `${script}.ts`);
}

// Run an X API script (uses bearer token, not browser automation)
async function runXApiScript(script: string, args: object): Promise<SkillResult> {
  const envConfig = readEnvFile(['X_BEARER_TOKEN']);
  const bearerToken = process.env.X_BEARER_TOKEN || envConfig.X_BEARER_TOKEN;
  if (!bearerToken) {
    return { success: false, message: 'X_BEARER_TOKEN not configured. Add it to your .env file.' };
  }

  const scriptPath = skillScriptPath('add-x-reader', script);
  if (!fs.existsSync(scriptPath)) {
    return { success: false, message: `X reader script not found: ${script}. Run /add-x-reader to install.` };
  }

  return runScript(scriptPath, { ...args, bearerToken });
}

// Write result to IPC results directory
function writeResult(dataDir: string, sourceGroup: string, requestId: string, result: SkillResult): void {
  const resultsDir = path.join(dataDir, 'ipc', sourceGroup, 'x_results');
  fs.mkdirSync(resultsDir, { recursive: true });
  fs.writeFileSync(path.join(resultsDir, `${requestId}.json`), JSON.stringify(result));
}

/**
 * Handle X integration IPC messages
 *
 * @returns true if message was handled, false if not an X message
 */
export async function handleXIpc(
  data: Record<string, unknown>,
  sourceGroup: string,
  isMain: boolean,
  dataDir: string,
): Promise<boolean> {
  const type = data.type as string;

  // Only handle x_* types
  if (!type?.startsWith('x_')) {
    return false;
  }

  // Only main group can use X integration
  if (!isMain) {
    logger.warn({ sourceGroup, type }, 'X integration blocked: not main group');
    return true;
  }

  const requestId = data.requestId as string;
  if (!requestId) {
    logger.warn({ type }, 'X integration blocked: missing requestId');
    return true;
  }

  logger.info({ type, requestId }, 'Processing X request');

  let result: SkillResult;

  switch (type) {
    case 'x_post':
      if (!data.content) {
        result = { success: false, message: 'Missing content' };
        break;
      }
      result = await runScript(skillScriptPath('x-integration', 'post'), { content: data.content });
      break;

    case 'x_like':
      if (!data.tweetUrl) {
        result = { success: false, message: 'Missing tweetUrl' };
        break;
      }
      result = await runScript(skillScriptPath('x-integration', 'like'), { tweetUrl: data.tweetUrl });
      break;

    case 'x_reply':
      if (!data.tweetUrl || !data.content) {
        result = { success: false, message: 'Missing tweetUrl or content' };
        break;
      }
      result = await runScript(skillScriptPath('x-integration', 'reply'), { tweetUrl: data.tweetUrl, content: data.content });
      break;

    case 'x_retweet':
      if (!data.tweetUrl) {
        result = { success: false, message: 'Missing tweetUrl' };
        break;
      }
      result = await runScript(skillScriptPath('x-integration', 'retweet'), { tweetUrl: data.tweetUrl });
      break;

    case 'x_quote':
      if (!data.tweetUrl || !data.comment) {
        result = { success: false, message: 'Missing tweetUrl or comment' };
        break;
      }
      result = await runScript(skillScriptPath('x-integration', 'quote'), { tweetUrl: data.tweetUrl, comment: data.comment });
      break;

    case 'x_search':
      if (!data.query) {
        result = { success: false, message: 'Missing query' };
        break;
      }
      result = await runXApiScript('search-tweets', {
        query: data.query,
        maxResults: data.maxResults || 10,
      });
      break;

    case 'x_user_timeline':
      if (!data.username) {
        result = { success: false, message: 'Missing username' };
        break;
      }
      result = await runXApiScript('user-timeline', {
        username: data.username,
        maxResults: data.maxResults || 10,
      });
      break;

    default:
      return false;
  }

  writeResult(dataDir, sourceGroup, requestId, result);
  if (result.success) {
    logger.info({ type, requestId }, 'X request completed');
  } else {
    logger.error({ type, requestId, message: result.message }, 'X request failed');
  }
  return true;
}
