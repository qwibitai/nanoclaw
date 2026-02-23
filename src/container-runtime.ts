/**
 * Container runtime abstraction for NanoClaw.
 * All runtime-specific logic lives here so swapping runtimes means changing one file.
 */
import { execSync } from 'child_process';

import { logger } from './logger.js';

/** The container runtime binary name. */
export const CONTAINER_RUNTIME_BIN = 'container';

interface RuntimeContainer {
  id: string;
  state: string;
}

/** Returns CLI args for a readonly bind mount. */
export function readonlyMountArgs(hostPath: string, containerPath: string): string[] {
  return ['--mount', `type=bind,source=${hostPath},target=${containerPath},readonly`];
}

/** Returns the shell command to stop a container by name. */
export function stopContainer(name: string): string {
  return `${CONTAINER_RUNTIME_BIN} stop ${name}`;
}

function parseContainersFromJson(output: string): RuntimeContainer[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output || '[]');
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const result: RuntimeContainer[] = [];
  for (const raw of parsed) {
    if (!raw || typeof raw !== 'object') continue;
    const obj = raw as {
      status?: unknown;
      state?: unknown;
      configuration?: { id?: unknown } | unknown;
      id?: unknown;
      name?: unknown;
    };

    const state =
      typeof obj.status === 'string'
        ? obj.status
        : typeof obj.state === 'string'
          ? obj.state
          : '';
    const id =
      obj.configuration && typeof obj.configuration === 'object' && typeof (obj.configuration as { id?: unknown }).id === 'string'
        ? (obj.configuration as { id: string }).id
        : typeof obj.id === 'string'
          ? obj.id
          : typeof obj.name === 'string'
            ? obj.name
            : '';

    if (!id || !state) continue;
    result.push({ id, state });
  }
  return result;
}

function parseContainersFromTable(output: string): RuntimeContainer[] {
  const lines = output
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  if (lines.length === 0) return [];

  const containers: RuntimeContainer[] = [];
  // Skip header row ("ID IMAGE OS ARCH STATE ADDR")
  for (const line of lines.slice(1)) {
    const cols = line.split(/\s+/);
    if (cols.length < 5) continue;
    containers.push({
      id: cols[0],
      state: cols[4],
    });
  }
  return containers;
}

function listContainers(): RuntimeContainer[] {
  // Preferred path: structured JSON output
  try {
    const output = execSync(`${CONTAINER_RUNTIME_BIN} ls --format json`, {
      stdio: ['pipe', 'pipe', 'pipe'],
      encoding: 'utf-8',
      timeout: 10000,
    });
    const parsed = parseContainersFromJson(output);
    if (parsed.length > 0 || output.trim() === '[]') {
      return parsed;
    }
  } catch {
    // Fall through to table parser
  }

  // Fallback: parse table output
  const output = execSync(`${CONTAINER_RUNTIME_BIN} ls -a`, {
    stdio: ['pipe', 'pipe', 'pipe'],
    encoding: 'utf-8',
    timeout: 10000,
  });
  return parseContainersFromTable(output);
}

function isContainerRunning(name: string): boolean {
  return listContainers().some(
    (c) => c.id === name && c.state === 'running',
  );
}

function formatErr(err: unknown): string {
  if (err instanceof Error) {
    return err.message.split('\n')[0] || err.message;
  }
  return String(err);
}

export interface StopContainerResult {
  stopped: boolean;
  attempts: string[];
}

export interface StopContainersByPrefixResult {
  matched: string[];
  stopped: string[];
  failures: Array<{ name: string; attempts: string[] }>;
}

/**
 * Stop a container and verify it is no longer running.
 * Escalates from graceful stop to SIGKILL/kill when needed.
 */
export function stopContainerWithVerification(name: string): StopContainerResult {
  const attempts: string[] = [];
  const commands = [
    stopContainer(name),
    `${CONTAINER_RUNTIME_BIN} stop -s SIGKILL -t 1 ${name}`,
    `${CONTAINER_RUNTIME_BIN} kill ${name}`,
  ];

  for (const cmd of commands) {
    try {
      execSync(cmd, { stdio: 'pipe', timeout: 10000 });
      attempts.push(`ok: ${cmd}`);
    } catch (err) {
      attempts.push(`err: ${cmd}: ${formatErr(err)}`);
    }

    try {
      if (!isContainerRunning(name)) {
        attempts.push(`verified stopped: ${name}`);
        return { stopped: true, attempts };
      }
      attempts.push(`still running after: ${cmd}`);
    } catch (err) {
      attempts.push(`err: verify ${name}: ${formatErr(err)}`);
    }
  }

  return { stopped: false, attempts };
}

/**
 * Stop all running containers whose id starts with `prefix`.
 * Returns detailed stop attempts for any failures.
 */
export function stopRunningContainersByPrefix(
  prefix: string,
): StopContainersByPrefixResult {
  const matched = listContainers()
    .filter((c) => c.state === 'running' && c.id.startsWith(prefix))
    .map((c) => c.id);

  const stopped: string[] = [];
  const failures: Array<{ name: string; attempts: string[] }> = [];

  for (const name of matched) {
    const result = stopContainerWithVerification(name);
    if (result.stopped) {
      stopped.push(name);
    } else {
      failures.push({ name, attempts: result.attempts });
    }
  }

  return { matched, stopped, failures };
}

/** Ensure the container runtime is running, starting it if needed. */
export function ensureContainerRuntimeRunning(): void {
  try {
    execSync(`${CONTAINER_RUNTIME_BIN} system status`, { stdio: 'pipe' });
    logger.debug('Container runtime already running');
  } catch {
    logger.info('Starting container runtime...');
    try {
      execSync(`${CONTAINER_RUNTIME_BIN} system start`, { stdio: 'pipe', timeout: 30000 });
      logger.info('Container runtime started');
    } catch (err) {
      logger.error({ err }, 'Failed to start container runtime');
      console.error(
        '\n╔════════════════════════════════════════════════════════════════╗',
      );
      console.error(
        '║  FATAL: Container runtime failed to start                      ║',
      );
      console.error(
        '║                                                                ║',
      );
      console.error(
        '║  Agents cannot run without a container runtime. To fix:        ║',
      );
      console.error(
        '║  1. Ensure Apple Container is installed                        ║',
      );
      console.error(
        '║  2. Run: container system start                                ║',
      );
      console.error(
        '║  3. Restart NanoClaw                                           ║',
      );
      console.error(
        '╚════════════════════════════════════════════════════════════════╝\n',
      );
      throw new Error('Container runtime is required but failed to start');
    }
  }
}

/** Kill orphaned NanoClaw containers from previous runs. */
export function cleanupOrphans(): void {
  try {
    const { matched: orphans, stopped, failures: failed } =
      stopRunningContainersByPrefix('nanoclaw-');

    if (stopped.length > 0) {
      logger.info({ count: stopped.length, names: stopped }, 'Stopped orphaned containers');
    }
    if (failed.length > 0) {
      logger.warn(
        { count: failed.length, failures: failed },
        'Failed to stop some orphaned containers',
      );
    }
  } catch (err) {
    logger.warn({ err }, 'Failed to clean up orphaned containers');
  }
}
