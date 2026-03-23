/**
 * LinkedIn Automation — Host-side IPC Handler
 *
 * Receives IPC task requests from the container and dispatches to
 * the appropriate Playwright script as a subprocess.
 *
 * This is the host-side bridge. The actual automation logic lives in
 * .claude/skills/linkedin-automation/scripts/*.ts
 */

import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

const SKILL_DIR = path.join(
  process.cwd(),
  '.claude/skills/linkedin-automation',
);
const SCRIPTS_DIR = path.join(SKILL_DIR, 'scripts');

const LI_TASK_TYPES = new Set([
  'li_visit_profile',
  'li_connect',
  'li_withdraw_request',
  'li_message',
  'li_follow',
  'li_unfollow',
  'li_like_post',
  'li_react_post',
  'li_comment_post',
  'li_share_post',
  'li_endorse_skill',
  'li_scrape_search',
  'li_scrape_profile',
  'li_scrape_post_engagers',
  'li_run_campaign',
  'li_bulk_message',
  'li_get_campaign_stats',
]);

const SCRIPT_MAP: Record<string, string> = {
  li_visit_profile: 'visit-profile.ts',
  li_connect: 'send-connection.ts',
  li_withdraw_request: 'withdraw-request.ts',
  li_message: 'send-message.ts',
  li_follow: 'follow.ts',
  li_unfollow: 'unfollow.ts',
  li_like_post: 'like-post.ts',
  li_react_post: 'react-post.ts',
  li_comment_post: 'comment-post.ts',
  li_share_post: 'share-post.ts',
  li_endorse_skill: 'endorse-skill.ts',
  li_scrape_search: 'scrape-search.ts',
  li_scrape_profile: 'scrape-profile.ts',
  li_scrape_post_engagers: 'scrape-post-engagers.ts',
  li_run_campaign: 'run-campaign.ts',
  li_bulk_message: 'bulk-message.ts',
  li_get_campaign_stats: 'get-campaign-stats.ts',
};

const TASK_TIMEOUTS: Record<string, number> = {
  li_run_campaign: 600000,
  li_bulk_message: 600000,
  li_scrape_search: 300000,
  li_scrape_post_engagers: 300000,
};
const DEFAULT_TIMEOUT = 180000;

function writeResult(
  resultsDir: string,
  requestId: string,
  result: { success: boolean; message: string; data?: unknown },
): void {
  fs.mkdirSync(resultsDir, { recursive: true });
  const filePath = path.join(resultsDir, `${requestId}.json`);
  const tempPath = `${filePath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(result, null, 2));
  fs.renameSync(tempPath, filePath);
}

async function runLinkedInScript(
  taskType: string,
  requestId: string,
  payload: object,
  resultsDir: string,
): Promise<void> {
  const scriptName = SCRIPT_MAP[taskType];
  if (!scriptName) {
    writeResult(resultsDir, requestId, {
      success: false,
      message: `No script mapped for task type: ${taskType}`,
    });
    return;
  }

  const scriptPath = path.join(SCRIPTS_DIR, scriptName);
  if (!fs.existsSync(scriptPath)) {
    writeResult(resultsDir, requestId, {
      success: false,
      message: `Script not found: ${scriptPath}`,
    });
    return;
  }

  const timeout = TASK_TIMEOUTS[taskType] || DEFAULT_TIMEOUT;
  const input = JSON.stringify(payload);

  return new Promise((resolve) => {
    const proc = spawn(
      'npx',
      ['dotenv', '-e', '.env', '--', 'npx', 'tsx', scriptPath],
      {
        cwd: process.cwd(),
        env: { ...process.env },
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );

    let stdout = '';
    let stderr = '';

    proc.stdin.write(input);
    proc.stdin.end();

    proc.stdout.on('data', (d: Buffer) => {
      stdout += d.toString();
    });
    proc.stderr.on('data', (d: Buffer) => {
      stderr += d.toString();
    });

    const timer = setTimeout(() => {
      proc.kill('SIGTERM');
      writeResult(resultsDir, requestId, {
        success: false,
        message: `Script timed out after ${timeout / 1000}s`,
      });
      resolve();
    }, timeout);

    proc.on('close', (code: number | null) => {
      clearTimeout(timer);
      const trimmed = stdout.trim();
      if (trimmed) {
        try {
          writeResult(resultsDir, requestId, JSON.parse(trimmed));
          resolve();
          return;
        } catch {
          /* not JSON, fall through */
        }
      }
      if (code === 0) {
        writeResult(resultsDir, requestId, {
          success: true,
          message: 'Script completed successfully',
        });
      } else {
        writeResult(resultsDir, requestId, {
          success: false,
          message: stderr.slice(-500) || `Script exited with code ${code}`,
        });
      }
      resolve();
    });

    proc.on('error', (err: Error) => {
      clearTimeout(timer);
      writeResult(resultsDir, requestId, {
        success: false,
        message: `Failed to spawn script: ${err.message}`,
      });
      resolve();
    });
  });
}

export async function handleLinkedInIpc(
  data: { type: string; requestId?: string; [key: string]: unknown },
  sourceGroup: string,
  _isMain: boolean,
  dataDir: string,
): Promise<boolean> {
  if (!LI_TASK_TYPES.has(data.type)) return false;

  const requestId =
    (data.requestId as string | undefined) || `li-${Date.now()}`;
  const resultsDir = path.join(dataDir, 'ipc', sourceGroup, 'li_results');
  const { type, requestId: _rid, ...payload } = data;

  runLinkedInScript(type, requestId, payload, resultsDir).catch((err) => {
    writeResult(resultsDir, requestId, {
      success: false,
      message: `Unexpected error: ${err instanceof Error ? err.message : String(err)}`,
    });
  });

  return true;
}
