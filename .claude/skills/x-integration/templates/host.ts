/**
 * X Integration IPC Handler (Host Side)
 *
 * Copied to src/plugins/x-integration/ during installation.
 *
 * Handles all x-integration_* IPC messages from container agents by spawning
 * scripts from the skill-x-social package (installed in the skill directory).
 */

import { spawn } from 'child_process';
import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';
import pino from 'pino';

// ============================================================================
// Types
// ============================================================================

interface ScriptResult {
  success: boolean;
  message: string;
  data?: unknown;
}

interface ActionHandler {
  script: string;
  requiredFields: string[];
  mapArgs: (data: Record<string, unknown>) => Record<string, unknown>;
}

// ============================================================================
// Configuration
// ============================================================================

const SKILL_NAME = 'x-integration';
const SKILL_DIR = path.join(process.cwd(), '.claude', 'skills', SKILL_NAME);
const PROJECT_ROOT = process.cwd();
const SCRIPT_TIMEOUT_MS = 120000;

// Resolve scripts from skill-x-social package installed in skill directory
const skillRequire = createRequire(path.join(SKILL_DIR, 'package.json'));
const SCRIPTS_DIR = path.join(path.dirname(skillRequire.resolve('skill-x-social/package.json')), 'scripts');

const logger = pino({
  level: 'info',
  transport: { target: 'pino-pretty', options: { colorize: true } },
});

// ============================================================================
// Container Path Resolution
// ============================================================================

/**
 * Resolve a container path to a host path.
 *
 * Container mount mapping:
 *   /workspace/group/X   → groups/{groupFolder}/X
 *   /workspace/project/X → {projectRoot}/X
 *   /workspace/ipc/X     → data/ipc/{groupFolder}/X
 *
 * Throws if the resolved path does not exist or escapes allowed directories.
 */
function resolveContainerPath(containerPath: string, groupFolder: string): string {
  const prefixMap: Array<{ prefix: string; resolve: (rest: string) => string }> = [
    { prefix: '/workspace/group/', resolve: (rest) => path.join(PROJECT_ROOT, 'groups', groupFolder, rest) },
    { prefix: '/workspace/project/', resolve: (rest) => path.join(PROJECT_ROOT, rest) },
    { prefix: '/workspace/ipc/', resolve: (rest) => path.join(PROJECT_ROOT, 'data', 'ipc', groupFolder, rest) },
  ];

  for (const { prefix, resolve } of prefixMap) {
    if (containerPath.startsWith(prefix)) {
      const rest = containerPath.slice(prefix.length);
      const hostPath = path.resolve(resolve(rest));

      // Prevent path traversal
      const allowedBase = path.resolve(resolve(''));
      if (!hostPath.startsWith(allowedBase)) {
        throw new Error(`Path traversal detected: ${containerPath}`);
      }

      if (!fs.existsSync(hostPath)) {
        throw new Error(`File not found: ${containerPath} (resolved to ${hostPath})`);
      }

      return hostPath;
    }
  }

  throw new Error(`Unsupported container path prefix: ${containerPath}. Must start with /workspace/group/, /workspace/project/, or /workspace/ipc/`);
}

// ============================================================================
// Action Registry
// ============================================================================

const ACTION_HANDLERS: Record<string, ActionHandler> = {
  post: {
    script: 'post',
    requiredFields: ['content'],
    mapArgs: (data) => ({
      content: data.content,
      ...(data.imagePaths ? {
        imagePaths: (data.imagePaths as string[]).map(p =>
          resolveContainerPath(p, data.groupFolder as string)
        ),
      } : {}),
    }),
  },
  like: {
    script: 'like',
    requiredFields: ['tweetUrl'],
    mapArgs: (data) => ({ tweetUrl: data.tweetUrl }),
  },
  reply: {
    script: 'reply',
    requiredFields: ['tweetUrl', 'content'],
    mapArgs: (data) => ({
      tweetUrl: data.tweetUrl,
      content: data.content,
      ...(data.imagePaths ? {
        imagePaths: (data.imagePaths as string[]).map(p =>
          resolveContainerPath(p, data.groupFolder as string)
        ),
      } : {}),
    }),
  },
  retweet: {
    script: 'retweet',
    requiredFields: ['tweetUrl'],
    mapArgs: (data) => ({ tweetUrl: data.tweetUrl }),
  },
  quote: {
    script: 'quote',
    requiredFields: ['tweetUrl', 'comment'],
    mapArgs: (data) => ({
      tweetUrl: data.tweetUrl,
      comment: data.comment,
      ...(data.imagePaths ? {
        imagePaths: (data.imagePaths as string[]).map(p =>
          resolveContainerPath(p, data.groupFolder as string)
        ),
      } : {}),
    }),
  },
};

// ============================================================================
// Script Execution
// ============================================================================

async function executeScript(script: string, args: Record<string, unknown>): Promise<ScriptResult> {
  const scriptPath = path.join(SCRIPTS_DIR, `${script}.ts`);

  return new Promise((resolve) => {
    const proc = spawn('npx', ['tsx', scriptPath], {
      cwd: process.cwd(),
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    proc.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    proc.stdin.write(JSON.stringify(args));
    proc.stdin.end();

    const timer = setTimeout(() => {
      proc.kill('SIGTERM');
      resolve({ success: false, message: `Script timed out (${SCRIPT_TIMEOUT_MS / 1000}s)` });
    }, SCRIPT_TIMEOUT_MS);

    proc.on('close', (code) => {
      clearTimeout(timer);

      if (code !== 0) {
        resolve({ success: false, message: `Script exited with code: ${code}` });
        return;
      }

      try {
        const lines = stdout.trim().split('\n');
        const lastLine = lines[lines.length - 1];
        resolve(JSON.parse(lastLine));
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

// ============================================================================
// Response Writer
// ============================================================================

function writeResponse(dataDir: string, sourceGroup: string, requestId: string, result: ScriptResult): void {
  const resultsDir = path.join(dataDir, 'ipc', sourceGroup, `${SKILL_NAME}_results`);
  fs.mkdirSync(resultsDir, { recursive: true });
  fs.writeFileSync(path.join(resultsDir, `${requestId}.json`), JSON.stringify(result));
}

// ============================================================================
// Validation
// ============================================================================

function validateRequiredFields(data: Record<string, unknown>, fields: string[]): string | null {
  const missing = fields.filter((field) => !data[field]);
  if (missing.length > 0) {
    return `Missing required field(s): ${missing.join(', ')}`;
  }
  return null;
}

// ============================================================================
// Main Handler
// ============================================================================

/**
 * Handle X integration IPC messages
 *
 * @param data - IPC message data
 * @param sourceGroup - Group folder that sent the request
 * @param isMain - Whether the source is the main group
 * @param dataDir - Data directory path
 * @returns true if message was handled, false if not an X integration message
 */
export async function handleXIntegrationIpc(
  data: Record<string, unknown>,
  sourceGroup: string,
  isMain: boolean,
  dataDir: string
): Promise<boolean> {
  const type = data.type as string;
  const prefix = `${SKILL_NAME}_`;

  // Only handle x-integration_* types
  if (!type?.startsWith(prefix)) {
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

  // Extract action from type (e.g., "x-integration_post" -> "post")
  const action = type.slice(prefix.length);
  const handler = ACTION_HANDLERS[action];

  if (!handler) {
    logger.warn({ type, action }, 'Unknown X integration action');
    writeResponse(dataDir, sourceGroup, requestId, {
      success: false,
      message: `Unknown action: ${action}`,
    });
    return true;
  }

  logger.info({ type, action, requestId }, 'Processing X integration request');

  // Validate required fields
  const validationError = validateRequiredFields(data, handler.requiredFields);
  if (validationError) {
    const result = { success: false, message: validationError };
    writeResponse(dataDir, sourceGroup, requestId, result);
    logger.error({ action, requestId, message: validationError }, 'X integration validation failed');
    return true;
  }

  // Execute script
  const args = handler.mapArgs(data);
  const result = await executeScript(handler.script, args);

  // Write result
  writeResponse(dataDir, sourceGroup, requestId, result);

  if (result.success) {
    logger.info({ action, requestId }, 'X integration request completed');
  } else {
    logger.error({ action, requestId, message: result.message }, 'X integration request failed');
  }

  return true;
}