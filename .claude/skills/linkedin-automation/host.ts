/**
 * LinkedIn Automation — Host-side IPC Handler
 *
 * Receives IPC task requests from the container and executes
 * the appropriate Playwright script as a subprocess.
 *
 * Integration: import and call handleLinkedInIpc() from src/ipc.ts
 */

import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

// IPC directories on host (shared with container via bind mount)
const IPC_DIR     = process.env.IPC_DIR     || path.join(process.cwd(), 'ipc');
const RESULTS_DIR = path.join(IPC_DIR, 'li_results');

const SKILL_DIR = path.join(process.cwd(), '.claude/skills/linkedin-automation');
const SCRIPTS_DIR = path.join(SKILL_DIR, 'scripts');

// All supported IPC task types
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

// Map IPC type → script filename
const SCRIPT_MAP: Record<string, string> = {
  li_visit_profile:        'visit-profile.ts',
  li_connect:              'send-connection.ts',
  li_withdraw_request:     'withdraw-request.ts',
  li_message:              'send-message.ts',
  li_follow:               'follow.ts',
  li_unfollow:             'unfollow.ts',
  li_like_post:            'like-post.ts',
  li_react_post:           'react-post.ts',
  li_comment_post:         'comment-post.ts',
  li_share_post:           'share-post.ts',
  li_endorse_skill:        'endorse-skill.ts',
  li_scrape_search:        'scrape-search.ts',
  li_scrape_profile:       'scrape-profile.ts',
  li_scrape_post_engagers: 'scrape-post-engagers.ts',
  li_run_campaign:         'run-campaign.ts',
  li_bulk_message:         'bulk-message.ts',
  li_get_campaign_stats:   'get-campaign-stats.ts',
};

// Timeouts per task type (ms) — long-running tasks need more time
const TASK_TIMEOUTS: Record<string, number> = {
  li_run_campaign:         600000,  // 10 min
  li_bulk_message:         600000,  // 10 min
  li_scrape_search:        300000,  // 5 min
  li_scrape_post_engagers: 300000,  // 5 min
};
const DEFAULT_TIMEOUT = 180000; // 3 min

function writeResult(requestId: string, result: { success: boolean; message: string; data?: unknown }): void {
  fs.mkdirSync(RESULTS_DIR, { recursive: true });
  const filePath = path.join(RESULTS_DIR, `${requestId}.json`);
  const tempPath = `${filePath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(result, null, 2));
  fs.renameSync(tempPath, filePath);
}

async function runLinkedInScript(
  taskType: string,
  requestId: string,
  payload: object
): Promise<void> {
  const scriptName = SCRIPT_MAP[taskType];
  if (!scriptName) {
    writeResult(requestId, { success: false, message: `No script mapped for task type: ${taskType}` });
    return;
  }

  const scriptPath = path.join(SCRIPTS_DIR, scriptName);
  if (!fs.existsSync(scriptPath)) {
    writeResult(requestId, { success: false, message: `Script not found: ${scriptPath}` });
    return;
  }

  const timeout = TASK_TIMEOUTS[taskType] || DEFAULT_TIMEOUT;
  const input = JSON.stringify(payload);
  const envVars = { ...process.env };

  return new Promise((resolve) => {
    const proc = spawn(
      'npx', ['dotenv', '-e', '.env', '--', 'npx', 'tsx', scriptPath],
      {
        cwd:   process.cwd(),
        env:   envVars,
        stdio: ['pipe', 'pipe', 'pipe'],
      }
    );

    let stdout = '';
    let stderr = '';

    proc.stdin.write(input);
    proc.stdin.end();

    proc.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
    proc.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });

    const timer = setTimeout(() => {
      proc.kill('SIGTERM');
      writeResult(requestId, { success: false, message: `Script timed out after ${timeout / 1000}s` });
      resolve();
    }, timeout);

    proc.on('close', (code: number | null) => {
      clearTimeout(timer);

      // Parse stdout as JSON result
      const trimmed = stdout.trim();
      if (trimmed) {
        try {
          const result = JSON.parse(trimmed);
          writeResult(requestId, result);
          resolve();
          return;
        } catch {
          // not JSON, fall through
        }
      }

      if (code === 0) {
        writeResult(requestId, { success: true, message: 'Script completed successfully' });
      } else {
        const errMsg = stderr.slice(-500) || `Script exited with code ${code}`;
        writeResult(requestId, { success: false, message: errMsg });
      }
      resolve();
    });

    proc.on('error', (err: Error) => {
      clearTimeout(timer);
      writeResult(requestId, { success: false, message: `Failed to spawn script: ${err.message}` });
      resolve();
    });
  });
}

// ─── get-campaign-stats (inline, no browser needed) ──────────────────────────
// This is handled inline since it only calls Notion API, no Playwright needed.
async function handleGetCampaignStats(requestId: string, payload: { campaign?: string }): Promise<void> {
  try {
    // Dynamically import notion (uses dotenv vars already loaded by host)
    const { getCampaignStats } = await import('./.claude/skills/linkedin-automation/lib/notion.js');
    const stats = await getCampaignStats(payload.campaign);
    const lines = Object.entries(stats)
      .map(([status, count]) => `${status}: ${count}`)
      .join('\n');
    const total = Object.values(stats).reduce((a, b) => a + b, 0);
    writeResult(requestId, {
      success: true,
      message: `LinkedIn Lead Stats${payload.campaign ? ` (${payload.campaign})` : ''}:\n${lines}\n\nTotal: ${total} leads`,
      data: stats,
    });
  } catch (err) {
    writeResult(requestId, { success: false, message: `Failed to get stats: ${err instanceof Error ? err.message : String(err)}` });
  }
}

// ─── Main IPC Handler ─────────────────────────────────────────────────────────

export async function handleLinkedInIpc(
  data: { type: string; requestId: string; [key: string]: unknown },
  _sourceGroup: string,
  _isMain: boolean,
  _dataDir: string
): Promise<boolean> {
  if (!LI_TASK_TYPES.has(data.type)) return false;

  const { type, requestId, ...payload } = data;

  // Special case: stats don't need a browser
  if (type === 'li_get_campaign_stats') {
    handleGetCampaignStats(requestId, payload as { campaign?: string });
    return true;
  }

  // All other tasks: run the corresponding Playwright script
  runLinkedInScript(type, requestId, payload).catch(err => {
    writeResult(requestId, {
      success: false,
      message: `Unexpected error: ${err instanceof Error ? err.message : String(err)}`,
    });
  });

  return true;
}
