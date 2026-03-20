/**
 * X Integration IPC Handler
 *
 * Handles all x_* IPC messages from container agents.
 * Adapted from .claude/skills/x-integration/host.ts to work within src/ rootDir.
 */

import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { logger } from './logger.js';
import {
  extractTweetId,
  getCachedTweet,
  formatCachedTweet,
  cacheTweetsFromSearch,
  cacheTweetsFromProfile,
  cacheTweetFromScrape,
  type SearchTweet,
  type ProfileData,
  type ScrapedTweetData,
} from './x-tweet-cache.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..');

interface SkillResult {
  success: boolean;
  message: string;
  data?: unknown;
}

const SCRIPT_TIMEOUT_MS = 120_000;

// Run a skill script as subprocess with process-group cleanup on timeout
export async function runScript(script: string, args: object, timeoutMs = SCRIPT_TIMEOUT_MS): Promise<SkillResult> {
  const scriptPath = path.join(PROJECT_ROOT, '.claude', 'skills', 'x-integration', 'scripts', `${script}.ts`);
  const tsxBin = path.join(PROJECT_ROOT, 'node_modules', '.bin', 'tsx');
  const startTime = Date.now();

  return new Promise((resolve) => {
    const proc = spawn(tsxBin, [scriptPath], {
      cwd: PROJECT_ROOT,
      detached: true,
      env: {
        ...process.env,
        NANOCLAW_ROOT: PROJECT_ROOT,
        PATH: `${path.join(PROJECT_ROOT, 'node_modules', '.bin')}:/opt/homebrew/bin:/usr/local/bin:${process.env.PATH || ''}`,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    // Prevent the detached process group from keeping the parent alive
    proc.unref();

    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (data) => { stdout += data.toString(); });
    proc.stderr.on('data', (data) => { stderr += data.toString(); });
    proc.stdin.write(JSON.stringify(args));
    proc.stdin.end();

    const timer = setTimeout(() => {
      const durationMs = Date.now() - startTime;
      // Kill the entire process group (tsx + all children like Chrome)
      try { process.kill(-proc.pid!, 'SIGKILL'); } catch { proc.kill('SIGKILL'); }
      logger.error(
        { script, durationMs, timeoutMs, stderrTail: stderr.slice(-500) },
        'X script timed out',
      );
      resolve({ success: false, message: `Script timed out after ${timeoutMs / 1000}s` });
    }, timeoutMs);

    proc.on('close', (code) => {
      clearTimeout(timer);
      const durationMs = Date.now() - startTime;

      // Try to parse structured result from stdout regardless of exit code.
      // Scripts write JSON to stdout via writeResult() even on error paths,
      // so we should always attempt to parse it.
      const stdoutTrimmed = stdout.trim();
      if (stdoutTrimmed) {
        try {
          const lines = stdoutTrimmed.split('\n');
          const parsed: SkillResult = JSON.parse(lines[lines.length - 1]);
          if (code !== 0) {
            logger.warn(
              { script, code, durationMs, parsed: parsed.message?.slice(0, 200), stderrTail: stderr.slice(-300) },
              'X script exited non-zero but produced parseable output',
            );
          } else {
            logger.debug({ script, durationMs, success: parsed.success }, 'X script completed');
          }
          resolve(parsed);
          return;
        } catch {
          // stdout wasn't valid JSON, fall through
        }
      }

      if (code !== 0) {
        logger.error(
          { script, code, durationMs, stdoutTail: stdout.slice(-300), stderrTail: stderr.slice(-500) },
          'X script crashed with no parseable output',
        );
        resolve({
          success: false,
          message: `Script ${script} crashed (exit ${code}). stderr: ${stderr.slice(-300) || '(empty)'}. stdout: ${stdout.slice(-200) || '(empty)'}`,
        });
        return;
      }

      logger.warn(
        { script, durationMs, stdoutLength: stdout.length },
        'X script exited 0 but produced no parseable output',
      );
      resolve({ success: false, message: `No output from script ${script}` });
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      const durationMs = Date.now() - startTime;
      logger.error({ script, durationMs, err }, 'X script spawn error');
      resolve({ success: false, message: `Failed to spawn ${script}: ${err.message}` });
    });
  });
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
  const requestStart = Date.now();

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

    case 'x_scrape_tweet':
      if (!data.tweetUrl) {
        result = { success: false, message: 'Missing tweetUrl' };
        break;
      }
      {
        const tweetId = extractTweetId(data.tweetUrl as string);
        // Serve from cache when not requesting replies (replies are never cached)
        if (tweetId && !data.includeReplies) {
          const cached = getCachedTweet(tweetId);
          if (cached) {
            logger.info({ tweetId, requestId }, 'Tweet cache hit');
            result = { success: true, message: formatCachedTweet(cached), data: cached };
            break;
          }
        }
        result = await runScript('scrape-tweet', {
          tweetUrl: data.tweetUrl,
          includeReplies: data.includeReplies ?? false,
          maxReplies: data.maxReplies ?? 10,
        });
        // Cache freshly scraped tweet
        if (result.success && result.data) {
          cacheTweetFromScrape(tweetId, result.data as ScrapedTweetData);
        }
      }
      break;

    case 'x_scrape_profile':
      if (!data.username) {
        result = { success: false, message: 'Missing username' };
        break;
      }
      result = await runScript('scrape-profile', {
        username: data.username,
        maxTweets: data.maxTweets ?? 10,
      });
      if (result.success && result.data) {
        cacheTweetsFromProfile(result.data as ProfileData);
      }
      break;

    case 'x_search_tweets':
      if (!data.query) {
        result = { success: false, message: 'Missing query parameter. Provide a search query to find tweets.' };
        break;
      }
      result = await runScript('search-tweets', {
        query: data.query,
        maxTweets: data.maxTweets ?? 20,
        searchMode: data.searchMode ?? 'top',
      });
      if (result.success && result.data) {
        cacheTweetsFromSearch(result.data as SearchTweet[]);
      }
      break;

    default:
      return false;
  }

  writeResult(dataDir, sourceGroup, requestId, result);
  const requestDurationMs = Date.now() - requestStart;
  if (result.success) {
    logger.info({ type, requestId, requestDurationMs }, 'X request completed');
  } else {
    logger.error(
      { type, requestId, requestDurationMs, error: result.message },
      'X request failed',
    );
  }
  return true;
}
