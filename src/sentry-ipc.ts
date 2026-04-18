/**
 * Host-side Sentry IPC handler.
 *
 * Watches for request files from containers in {group}/sentry/requests/,
 * executes the sentry_wrapper.py script, and writes responses to
 * {group}/sentry/responses/.
 *
 * Auth token resolved by the wrapper from env or macOS Keychain.
 */

import { execFile } from 'child_process';
import fs from 'fs';
import path from 'path';

import { logger } from './logger.js';

const SCRIPTS_DIR = path.join(process.cwd(), 'scripts');
const SENTRY_WRAPPER = path.join(SCRIPTS_DIR, 'sentry_wrapper.py');

interface SentryRequest {
  id: string;
  tool: string;
  args: Record<string, unknown>;
}

/**
 * Run the sentry wrapper script and return parsed JSON output.
 */
function runSentryCmd(args: string[]): Promise<unknown> {
  return new Promise((resolve, reject) => {
    execFile(
      'python3',
      [SENTRY_WRAPPER, ...args],
      { maxBuffer: 10 * 1024 * 1024, timeout: 30000 },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(`sentry wrapper error: ${stderr || error.message}`));
          return;
        }
        const trimmed = stdout.trim();
        if (!trimmed) {
          resolve(null);
          return;
        }
        try {
          const parsed = JSON.parse(trimmed);
          // The wrapper outputs {"error": "..."} on failure
          if (
            parsed &&
            typeof parsed === 'object' &&
            'error' in parsed &&
            Object.keys(parsed).length === 1
          ) {
            reject(new Error(parsed.error));
            return;
          }
          resolve(parsed);
        } catch {
          resolve(trimmed);
        }
      },
    );
  });
}

// --- Tool dispatcher ---

async function handleRequest(req: SentryRequest): Promise<unknown> {
  const { tool, args } = req;

  switch (tool) {
    case 'list_projects':
      return runSentryCmd(['projects']);

    case 'list_issues': {
      if (!args.project) throw new Error('project is required');
      const cmdArgs = ['issues', '--project', String(args.project)];
      if (args.query) cmdArgs.push('--query', String(args.query));
      if (args.sort) cmdArgs.push('--sort', String(args.sort));
      if (args.limit) cmdArgs.push('--limit', String(args.limit));
      return runSentryCmd(cmdArgs);
    }

    case 'get_issue': {
      if (!args.issue_id) throw new Error('issue_id is required');
      if (!args.project) throw new Error('project is required');
      return runSentryCmd([
        'issue',
        '--id',
        String(args.issue_id),
        '--project',
        String(args.project),
      ]);
    }

    case 'get_events': {
      if (!args.issue_id) throw new Error('issue_id is required');
      if (!args.project) throw new Error('project is required');
      const cmdArgs = [
        'events',
        '--id',
        String(args.issue_id),
        '--project',
        String(args.project),
      ];
      if (args.limit) cmdArgs.push('--limit', String(args.limit));
      return runSentryCmd(cmdArgs);
    }

    case 'resolve_issue': {
      if (!args.issue_id) throw new Error('issue_id is required');
      if (!args.project) throw new Error('project is required');
      return runSentryCmd([
        'resolve',
        '--id',
        String(args.issue_id),
        '--project',
        String(args.project),
      ]);
    }

    case 'ignore_issue': {
      if (!args.issue_id) throw new Error('issue_id is required');
      if (!args.project) throw new Error('project is required');
      return runSentryCmd([
        'ignore',
        '--id',
        String(args.issue_id),
        '--project',
        String(args.project),
      ]);
    }

    case 'assign_issue': {
      if (!args.issue_id) throw new Error('issue_id is required');
      if (!args.project) throw new Error('project is required');
      if (!args.assignee) throw new Error('assignee is required');
      return runSentryCmd([
        'assign',
        '--id',
        String(args.issue_id),
        '--project',
        String(args.project),
        '--assignee',
        String(args.assignee),
      ]);
    }

    default:
      throw new Error(`Unknown sentry tool: ${tool}`);
  }
}

/**
 * Process all pending Sentry IPC requests in a given group's IPC directory.
 */
export function processSentryIpc(groupIpcDir: string): void {
  const requestsDir = path.join(groupIpcDir, 'sentry', 'requests');
  const responsesDir = path.join(groupIpcDir, 'sentry', 'responses');

  if (!fs.existsSync(requestsDir)) return;

  let files: string[];
  try {
    files = fs.readdirSync(requestsDir).filter((f) => f.endsWith('.json'));
  } catch {
    return;
  }

  for (const file of files) {
    const requestPath = path.join(requestsDir, file);

    let req: SentryRequest;
    try {
      req = JSON.parse(fs.readFileSync(requestPath, 'utf-8'));
    } catch (err) {
      logger.error({ file, err }, 'Failed to parse sentry IPC request');
      fs.unlinkSync(requestPath);
      continue;
    }

    // Delete the request file immediately to avoid reprocessing
    fs.unlinkSync(requestPath);

    // Process async — write response when done
    handleRequest(req)
      .then((result) => {
        writeResponse(responsesDir, req.id, { result });
      })
      .catch((err) => {
        logger.error(
          { requestId: req.id, tool: req.tool, err },
          'Sentry IPC error',
        );
        writeResponse(responsesDir, req.id, {
          error: err instanceof Error ? err.message : String(err),
        });
      });
  }
}

function writeResponse(
  responsesDir: string,
  requestId: string,
  data: { result?: unknown; error?: string },
): void {
  fs.mkdirSync(responsesDir, { recursive: true });
  const responsePath = path.join(responsesDir, `${requestId}.json`);
  const tempPath = `${responsePath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(data));
  fs.renameSync(tempPath, responsePath);
}
