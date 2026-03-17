/**
 * Router Container Manager
 *
 * Manages a persistent router container that uses Claude to route messages
 * to the appropriate case. The router runs as a regular container with a
 * special prompt — it receives routing requests as stdin and returns
 * JSON routing decisions.
 *
 * For Phase 1, each routing request spawns a lightweight one-shot container.
 * The container uses Haiku-class model for fast, cheap routing decisions.
 * Future phases may keep a persistent container alive between requests.
 */
import { execSync, spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

import {
  CONTAINER_IMAGE,
  CONTAINER_MAX_OUTPUT_SIZE,
  CREDENTIAL_PROXY_PORT,
  DATA_DIR,
  TIMEZONE,
} from './config.js';
import {
  CONTAINER_HOST_GATEWAY,
  CONTAINER_RUNTIME_BIN,
  hostGatewayArgs,
} from './container-runtime.js';
import { detectAuthMode } from './credential-proxy.js';
import { logger } from './logger.js';
import { buildRouterPrompt } from './router-prompt.js';
import { RouterRequest, RouterResponse } from './router-types.js';

const ROUTER_TIMEOUT_MS = 60_000; // 60 seconds — first container run includes image pull + SDK init
const ROUTER_GROUP_FOLDER = '__router__';

/**
 * Route a message using the container-based router.
 * Spawns a one-shot container that runs the Claude agent SDK with a routing prompt.
 * Returns a RouterResponse with the routing decision.
 */
export async function routeMessage(
  request: RouterRequest,
): Promise<RouterResponse> {
  const prompt = buildRouterPrompt(request);

  logger.debug(
    {
      requestId: request.requestId,
      caseCount: request.cases.length,
      sender: request.senderName,
    },
    'Routing message via container',
  );

  try {
    // Run the container — the agent calls the route_decision MCP tool,
    // which writes the structured result to an IPC file
    await runRouterContainer(prompt, request.requestId);
    const response = readRouterResult(request.requestId);

    logger.info(
      {
        requestId: request.requestId,
        decision: response.decision,
        caseId: response.caseId,
        confidence: response.confidence,
      },
      'Router decision',
    );

    return response;
  } catch (err) {
    logger.error(
      { requestId: request.requestId, err },
      'Router container failed',
    );
    throw err;
  }
}

/**
 * Read the router's structured decision from the IPC results directory.
 * The route_decision MCP tool writes the result as a JSON file.
 */
export function readRouterResult(requestId: string): RouterResponse {
  const resultsDir = path.join(DATA_DIR, 'ipc', ROUTER_GROUP_FOLDER, 'results');
  const resultFile = path.join(resultsDir, `${requestId}.json`);

  if (!fs.existsSync(resultFile)) {
    // Brief retry for filesystem sync latency (WSL2 mounts can be slow)
    for (let i = 0; i < 5; i++) {
      const start = Date.now();
      while (Date.now() - start < 100) {} // busy-wait 100ms
      if (fs.existsSync(resultFile)) break;
    }
  }

  if (!fs.existsSync(resultFile)) {
    throw new Error(`Router produced no result file for ${requestId}`);
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(resultFile, 'utf-8'));
    // Clean up the result file
    fs.unlinkSync(resultFile);

    return {
      requestId: parsed.requestId || requestId,
      decision: parsed.decision || 'suggest_new',
      caseId: parsed.caseId,
      caseName: parsed.caseName,
      confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0,
      reason: parsed.reason || '',
      directAnswer: parsed.directAnswer,
      model: parsed.model,
    };
  } catch (err) {
    // Clean up even on error
    try {
      fs.unlinkSync(resultFile);
    } catch {}
    if (err instanceof Error && err.message.includes('no result file'))
      throw err;
    throw new Error(
      `Failed to parse router result: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Run a one-shot router container and return the result text.
 * The container runs the agent-runner with a routing prompt.
 */
async function runRouterContainer(
  prompt: string,
  requestId: string,
): Promise<void> {
  const projectRoot = process.cwd();

  // Prepare minimal IPC directory for the router
  const routerIpcDir = path.join(DATA_DIR, 'ipc', ROUTER_GROUP_FOLDER);
  fs.mkdirSync(path.join(routerIpcDir, 'input'), { recursive: true });

  // _close sentinel path — written AFTER container spawn + stdin (see below).
  // Writing it here races with agent-runner startup cleanup that deletes stale sentinels.
  const closeSentinelPath = path.join(routerIpcDir, 'input', '_close');

  // Prepare router group directory (minimal — just needs to exist)
  const routerGroupDir = path.join(DATA_DIR, 'router-group');
  fs.mkdirSync(routerGroupDir, { recursive: true });

  const routerClaudeMd = path.join(routerGroupDir, 'CLAUDE.md');
  if (!fs.existsSync(routerClaudeMd)) {
    fs.writeFileSync(
      routerClaudeMd,
      '# Router\n\nYou are a message router. Respond with JSON only. No commentary, no markdown, no explanation.\n',
    );
  }

  // Prepare router sessions directory
  const routerSessionsDir = path.join(
    DATA_DIR,
    'sessions',
    ROUTER_GROUP_FOLDER,
    '.claude',
  );
  fs.mkdirSync(routerSessionsDir, { recursive: true });

  // Settings to disable memory/teams features for router
  const settingsFile = path.join(routerSessionsDir, 'settings.json');
  if (!fs.existsSync(settingsFile)) {
    fs.writeFileSync(settingsFile, JSON.stringify({ env: {} }, null, 2) + '\n');
  }

  // Copy agent-runner source for the router
  const agentRunnerSrc = path.join(
    projectRoot,
    'container',
    'agent-runner',
    'src',
  );
  const routerAgentRunnerDir = path.join(
    DATA_DIR,
    'sessions',
    ROUTER_GROUP_FOLDER,
    'agent-runner-src',
  );
  if (fs.existsSync(agentRunnerSrc)) {
    fs.cpSync(agentRunnerSrc, routerAgentRunnerDir, { recursive: true });
  }

  // Build container args — minimal mounts, no group folders
  const containerName = `nanoclaw-router-${Date.now()}`;
  const args: string[] = ['run', '-i', '--rm', '--name', containerName];

  args.push('-e', `TZ=${TIMEZONE}`);
  args.push(
    '-e',
    `ANTHROPIC_BASE_URL=http://${CONTAINER_HOST_GATEWAY}:${CREDENTIAL_PROXY_PORT}`,
  );

  const authMode = detectAuthMode();
  if (authMode === 'api-key') {
    args.push('-e', 'ANTHROPIC_API_KEY=placeholder');
  } else {
    args.push('-e', 'CLAUDE_CODE_OAUTH_TOKEN=placeholder');
  }

  // Agent-runner env vars it expects
  args.push('-e', `NANOCLAW_CHAT_JID=__router__`);
  args.push('-e', `NANOCLAW_GROUP_FOLDER=${ROUTER_GROUP_FOLDER}`);
  args.push('-e', `NANOCLAW_IS_MAIN=false`);

  args.push(...hostGatewayArgs());

  // Run as host user for file access
  const hostUid = process.getuid?.();
  const hostGid = process.getgid?.();
  if (hostUid != null && hostUid !== 0 && hostUid !== 1000) {
    args.push('--user', `${hostUid}:${hostGid}`);
    args.push('-e', 'HOME=/home/node');
  }

  // Minimal mounts:
  // 1. Router group dir as /workspace/group (agent-runner expects this)
  args.push('-v', `${routerGroupDir}:/workspace/group`);

  // 2. Router IPC dir
  args.push('-v', `${routerIpcDir}:/workspace/ipc`);

  // 3. Agent-runner source
  args.push('-v', `${routerAgentRunnerDir}:/app/src`);

  // 4. Router sessions (.claude)
  args.push('-v', `${routerSessionsDir}:/home/node/.claude`);

  args.push(CONTAINER_IMAGE);

  // Build the container input JSON (same protocol as regular containers)
  const containerInput = {
    prompt,
    groupFolder: ROUTER_GROUP_FOLDER,
    chatJid: '__router__',
    isMain: false,
    isScheduledTask: false,
  };

  return new Promise((resolve, reject) => {
    const container = spawn(CONTAINER_RUNTIME_BIN, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;

    const settle = (outcome: 'resolve' | 'reject', value?: Error) => {
      if (settled) return;
      settled = true;
      if (outcome === 'resolve') resolve();
      else reject(value);
    };

    // Write input and close stdin
    container.stdin.write(JSON.stringify(containerInput));
    container.stdin.end();

    // Write _close sentinel AFTER stdin so agent-runner's startup cleanup
    // (which deletes stale sentinels) runs before this file appears.
    // The IPC poller inside the query will find it and exit after one turn.
    fs.writeFileSync(closeSentinelPath, '');

    container.stdout.on('data', (data) => {
      const chunk = data.toString();
      if (stdout.length < CONTAINER_MAX_OUTPUT_SIZE) {
        stdout += chunk;
      }
    });

    container.stderr.on('data', (data) => {
      const chunk = data.toString();
      if (stderr.length < CONTAINER_MAX_OUTPUT_SIZE) {
        stderr += chunk;
      }
      // Log stderr for debugging
      const lines = chunk.trim().split('\n');
      for (const line of lines) {
        if (line) logger.debug({ container: 'router' }, line);
      }
    });

    const timeout = setTimeout(() => {
      timedOut = true;
      logger.error({ requestId, containerName }, 'Router container timeout');
      container.kill('SIGTERM');
      setTimeout(() => {
        if (!container.killed) container.kill('SIGKILL');
      }, 5000);
      // Docker-level stop as fallback — container.kill() only signals the
      // `docker run` process, which may not propagate to the container.
      setTimeout(() => {
        try {
          execSync(`${CONTAINER_RUNTIME_BIN} stop ${containerName}`, {
            stdio: 'pipe',
            timeout: 5000,
          });
          logger.info(
            { containerName },
            'Force-stopped router container via docker stop',
          );
        } catch {
          // Already stopped or doesn't exist
        }
      }, 8000);
      // Force-reject after grace period if 'close' event never fires.
      // Without this, a zombie container blocks the message queue forever.
      setTimeout(() => {
        settle('reject', new Error('Router container timed out'));
      }, 10_000);
    }, ROUTER_TIMEOUT_MS);

    container.on('close', (code) => {
      clearTimeout(timeout);

      if (timedOut) {
        settle('reject', new Error('Router container timed out'));
        return;
      }

      if (code !== 0) {
        settle(
          'reject',
          new Error(
            `Router container exited with code ${code}: ${stderr.slice(-500)}`,
          ),
        );
        return;
      }

      // Container exited successfully — the route_decision MCP tool
      // wrote the result to an IPC file. Resolve so the caller can read it.
      settle('resolve');
    });

    container.on('error', (err) => {
      clearTimeout(timeout);
      settle(
        'reject',
        new Error(`Router container spawn error: ${err.message}`),
      );
    });
  });
}

/**
 * Stop any running router containers (cleanup on shutdown).
 */
export async function stopRouterContainer(): Promise<void> {
  // The one-shot router containers self-cleanup (--rm flag),
  // but we stop any that might be in-flight during shutdown.
  try {
    const { execSync } = await import('child_process');
    const output = execSync(
      `${CONTAINER_RUNTIME_BIN} ps --filter name=nanoclaw-router- --format '{{.Names}}'`,
      { stdio: ['pipe', 'pipe', 'pipe'], encoding: 'utf-8' },
    );
    const containers = output.trim().split('\n').filter(Boolean);
    for (const name of containers) {
      try {
        execSync(`${CONTAINER_RUNTIME_BIN} stop ${name}`, {
          stdio: 'pipe',
          timeout: 5000,
        });
        logger.info({ containerName: name }, 'Stopped router container');
      } catch {
        // Already stopped
      }
    }
  } catch (err) {
    logger.warn({ err }, 'Failed to stop router containers');
  }
}
