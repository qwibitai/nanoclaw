/**
 * Native Runner for NanoClaw
 *
 * Spawns the agent-runner as a direct child process on the host,
 * bypassing Docker entirely. The IPC protocol (stdin/stdout JSON,
 * OUTPUT_START/END markers) is identical to container mode so the
 * agent-runner source is unchanged.
 *
 * Activate with RUNTIME_MODE=native in .env.
 *
 * Security trade-off: the agent process inherits the user's full
 * filesystem access. Read-only mount constraints from the allowlist
 * cannot be enforced without a container boundary. Use only on
 * single-user personal deployments where host access is intentional.
 *
 * See docs/NATIVE-MODE.md for setup instructions and security notes.
 */
import { ChildProcess, spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  CONTAINER_MAX_OUTPUT_SIZE,
  CONTAINER_TIMEOUT,
  DATA_DIR,
  GROUPS_DIR,
  IDLE_TIMEOUT,
  TIMEZONE,
} from './config.js';
import { readEnvFile } from './env.js';
import { resolveGroupFolderPath, resolveGroupIpcPath } from './group-folder.js';
import { logger } from './logger.js';
import { validateAdditionalMounts } from './mount-security.js';
import { RegisteredGroup } from './types.js';
import {
  ContainerInput,
  ContainerOutput,
  writeTasksSnapshot,
  writeGroupsSnapshot,
  AvailableGroup,
} from './container-runner.js';

// Re-export types consumed by index.ts and task-scheduler.ts
export {
  ContainerInput,
  ContainerOutput,
  writeTasksSnapshot,
  writeGroupsSnapshot,
};
export type { AvailableGroup };

const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

// ---------------------------------------------------------------------------
// Startup initialization — call once from main() before any agent runs
// ---------------------------------------------------------------------------

let _startupDone = false;

/**
 * Ensure native-mode prerequisites are ready before the first agent run.
 *
 * Must be called once at process startup (not per-invocation) to avoid
 * blocking the event loop with npm install or racing on skills sync.
 */
export async function ensureNativeRunnerReady(): Promise<void> {
  if (_startupDone) return;
  _startupDone = true;

  await _ensureAgentRunnerDeps();
  _syncNanoclawSkills();
}

/**
 * Install agent-runner npm dependencies if they are missing.
 * Runs synchronously but only once per process — never in the agent hot path.
 */
async function _ensureAgentRunnerDeps(): Promise<void> {
  const agentRunnerDir = path.join(process.cwd(), 'container', 'agent-runner');
  const nodeModules = path.join(agentRunnerDir, 'node_modules');
  if (fs.existsSync(nodeModules)) return;

  logger.info('Native mode: installing agent-runner dependencies...');
  const { execSync } = await import('child_process');
  try {
    execSync('npm install', { cwd: agentRunnerDir, stdio: 'pipe' });
    logger.info('Native mode: agent-runner dependencies installed');
  } catch (err) {
    // Log and continue — spawn will fail with a clear error if tsx is missing
    logger.error({ err }, 'Native mode: npm install failed for agent-runner');
  }
}

/**
 * Sync container/skills/ into ~/.claude/skills/ using symlinks.
 *
 * Each skill directory is symlinked rather than copied so that:
 *   - Updates take effect immediately after git pull (no re-copy needed)
 *   - No file-by-file copy races when multiple groups fire simultaneously
 *   - User-owned skills (real directories) are never overwritten
 *
 * Stale symlinks (pointing to removed skills) are cleaned up automatically.
 */
function _syncNanoclawSkills(): void {
  const projectRoot = process.cwd();
  const skillsSrc = path.join(projectRoot, 'container', 'skills');
  const skillsDst = path.join(os.homedir(), '.claude', 'skills');

  if (!fs.existsSync(skillsSrc)) return;

  fs.mkdirSync(skillsDst, { recursive: true });

  for (const skillDir of fs.readdirSync(skillsSrc)) {
    const srcDir = path.join(skillsSrc, skillDir);
    if (!fs.statSync(srcDir).isDirectory()) continue;

    const dstPath = path.join(skillsDst, skillDir);

    try {
      const existing = fs.lstatSync(dstPath);
      if (existing.isSymbolicLink()) {
        const currentTarget = fs.readlinkSync(dstPath);
        if (currentTarget === srcDir) continue; // already correct
        fs.unlinkSync(dstPath); // stale symlink — re-create below
      } else {
        // Real directory: user may have customized it — leave it alone
        logger.debug(
          { skill: skillDir },
          'Native skills sync: skipping user-owned directory',
        );
        continue;
      }
    } catch {
      // Path does not exist — fall through to create symlink
    }

    try {
      fs.symlinkSync(srcDir, dstPath);
      logger.debug({ skill: skillDir }, 'Native skills sync: linked');
    } catch (err) {
      logger.warn({ skill: skillDir, err }, 'Native skills sync: symlink failed');
    }
  }
}

// ---------------------------------------------------------------------------
// Per-group workspace preparation (side effects, separated from env building)
// ---------------------------------------------------------------------------

interface GroupWorkspace {
  groupDir: string;
  groupIpcDir: string;
  groupSessionsDir: string;
  extraDir: string;
  globalDir: string;
}

/**
 * Create all per-group directories and initialize settings.json.
 * Returns paths consumed by buildNativeEnv.
 *
 * Separated from buildNativeEnv so the env builder is a pure function
 * and the side effects are explicit and testable.
 */
function prepareGroupWorkspace(
  group: RegisteredGroup,
  isMain: boolean,
): GroupWorkspace {
  const groupDir = resolveGroupFolderPath(group.folder);
  const groupIpcDir = resolveGroupIpcPath(group.folder);
  const groupSessionsDir = path.join(
    DATA_DIR,
    'sessions',
    group.folder,
    '.claude',
  );

  fs.mkdirSync(groupSessionsDir, { recursive: true });
  fs.mkdirSync(path.join(groupIpcDir, 'messages'), { recursive: true });
  fs.mkdirSync(path.join(groupIpcDir, 'tasks'), { recursive: true });
  fs.mkdirSync(path.join(groupIpcDir, 'input'), { recursive: true });

  const settingsFile = path.join(groupSessionsDir, 'settings.json');
  if (!fs.existsSync(settingsFile)) {
    fs.writeFileSync(
      settingsFile,
      JSON.stringify(
        {
          env: {
            CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
            CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: '1',
            CLAUDE_CODE_DISABLE_AUTO_MEMORY: '0',
          },
        },
        null,
        2,
      ) + '\n',
    );
  }

  // Symlink additional mounts into a per-group extra dir.
  // Note: read-only constraints cannot be enforced without container isolation.
  // A warning is logged for each mount marked readonly so operators are aware.
  const extraDir = path.join(DATA_DIR, 'native-extra', group.folder);
  fs.mkdirSync(extraDir, { recursive: true });

  if (group.containerConfig?.additionalMounts) {
    const validatedMounts = validateAdditionalMounts(
      group.containerConfig.additionalMounts,
      group.name,
      isMain,
    );
    for (const mount of validatedMounts) {
      if (mount.readonly) {
        logger.warn(
          { mount: mount.containerPath },
          'Native mode: read-only mount constraint cannot be enforced without container isolation — mount is writable',
        );
      }
      const linkName =
        mount.containerPath.split('/').pop() || path.basename(mount.hostPath);
      const linkPath = path.join(extraDir, linkName);
      try {
        if (fs.existsSync(linkPath)) fs.unlinkSync(linkPath);
        fs.symlinkSync(mount.hostPath, linkPath);
      } catch (err) {
        logger.warn({ mount, err }, 'Failed to symlink additional mount');
      }
    }
  }

  const globalDir = path.join(GROUPS_DIR, 'global');

  return { groupDir, groupIpcDir, groupSessionsDir, extraDir, globalDir };
}

// ---------------------------------------------------------------------------
// Environment builder — pure function, no filesystem side effects
// ---------------------------------------------------------------------------

/**
 * Build the environment for the native agent-runner process.
 *
 * Credentials are read via readEnvFile() (the same parser used by config.ts)
 * to correctly handle quoted values and multi-form .env syntax.
 * The host environment is inherited so tools like git, gh, and SSH work.
 */
function buildNativeEnv(
  isMain: boolean,
  workspace: GroupWorkspace,
): Record<string, string> {
  const { groupDir, groupIpcDir, groupSessionsDir, extraDir, globalDir } =
    workspace;

  // Use the shared .env parser — handles quoting, comments, blank lines
  const credentials = readEnvFile([
    'CLAUDE_CODE_OAUTH_TOKEN',
    'ANTHROPIC_API_KEY',
  ]);

  return {
    // Inherit host environment (PATH, SSH_AUTH_SOCK, DISPLAY, etc.)
    ...(process.env as Record<string, string>),
    // Workspace path remapping consumed by the agent-runner
    NANOCLAW_WORKSPACE_GROUP: groupDir,
    NANOCLAW_WORKSPACE_GLOBAL: globalDir,
    NANOCLAW_WORKSPACE_EXTRA: extraDir,
    NANOCLAW_WORKSPACE_PROJECT: isMain ? process.cwd() : '',
    NANOCLAW_CLAUDE_HOME: groupSessionsDir,
    NANOCLAW_IPC_INPUT: path.join(groupIpcDir, 'input'),
    NANOCLAW_IPC_DIR: groupIpcDir,
    TZ: TIMEZONE,
    // SDK credentials — injected directly; no OneCLI proxy in native mode
    ...(credentials.CLAUDE_CODE_OAUTH_TOKEN
      ? { CLAUDE_CODE_OAUTH_TOKEN: credentials.CLAUDE_CODE_OAUTH_TOKEN }
      : {}),
    ...(credentials.ANTHROPIC_API_KEY
      ? { ANTHROPIC_API_KEY: credentials.ANTHROPIC_API_KEY }
      : {}),
    CLAUDE_CODE_AUTO_COMPACT_WINDOW: '165000',
    // Keep HOME as the real user home so SSH keys, gh auth, and git config work.
    // The Claude SDK reads ~/.claude/skills from here (symlinked from container/skills/).
    HOME: os.homedir(),
  };
}

// ---------------------------------------------------------------------------
// Agent-runner path resolution
// ---------------------------------------------------------------------------

/**
 * Return the path to the agent-runner entry point.
 *
 * In native mode, all groups share the canonical agent-runner source in
 * container/agent-runner/src/. Per-group copies are not needed because
 * there is no filesystem namespace isolation between groups on the host.
 */
function getAgentRunnerPath(): string {
  return path.join(
    process.cwd(),
    'container',
    'agent-runner',
    'src',
    'index.ts',
  );
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

export async function runNativeAgent(
  group: RegisteredGroup,
  input: ContainerInput,
  onProcess: (proc: ChildProcess, name: string) => void,
  onOutput?: (output: ContainerOutput) => Promise<void>,
): Promise<ContainerOutput> {
  const startTime = Date.now();

  const workspace = prepareGroupWorkspace(group, input.isMain);
  fs.mkdirSync(workspace.groupDir, { recursive: true });

  const safeName = group.folder.replace(/[^a-zA-Z0-9-]/g, '-');
  const processName = `nanoclaw-native-${safeName}-${Date.now()}`;
  const env = buildNativeEnv(input.isMain, workspace);
  const agentRunnerPath = getAgentRunnerPath();

  const agentRunnerDir = path.join(process.cwd(), 'container', 'agent-runner');
  const agentRunnerNodeModules = path.join(agentRunnerDir, 'node_modules');

  logger.info(
    {
      group: group.name,
      processName,
      isMain: input.isMain,
      agentRunner: agentRunnerPath,
    },
    'Spawning native agent',
  );

  const logsDir = path.join(workspace.groupDir, 'logs');
  fs.mkdirSync(logsDir, { recursive: true });

  return new Promise((resolve) => {
    // Run agent-runner TypeScript directly via tsx.
    // Use process.execPath's directory to locate npx so the correct Node
    // version is used even in launchd/systemd environments without a full PATH.
    const nodeBinDir = path.dirname(process.execPath);
    const npxPath = path.join(nodeBinDir, 'npx');

    const proc = spawn(npxPath, ['tsx', agentRunnerPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...env,
        PATH: `${nodeBinDir}:${env.PATH || ''}`,
        NODE_PATH: agentRunnerNodeModules,
      },
      cwd: agentRunnerDir,
    });

    onProcess(proc, processName);

    let stdout = '';
    let stderr = '';
    let stdoutTruncated = false;
    let stderrTruncated = false;

    proc.stdin.write(JSON.stringify(input));
    proc.stdin.end();

    // Streaming output parsing — identical protocol to container-runner.ts
    let parseBuffer = '';
    let newSessionId: string | undefined;
    let outputChain = Promise.resolve();
    let hadStreamingOutput = false;

    let timedOut = false;
    const configTimeout = group.containerConfig?.timeout || CONTAINER_TIMEOUT;
    const timeoutMs = Math.max(configTimeout, IDLE_TIMEOUT + 30_000);

    const killOnTimeout = () => {
      timedOut = true;
      logger.error(
        { group: group.name, processName },
        'Native agent timeout, killing',
      );
      proc.kill('SIGTERM');
      setTimeout(() => {
        if (!proc.killed) proc.kill('SIGKILL');
      }, 5000);
    };

    let timeout = setTimeout(killOnTimeout, timeoutMs);
    const resetTimeout = () => {
      clearTimeout(timeout);
      timeout = setTimeout(killOnTimeout, timeoutMs);
    };

    proc.stdout.on('data', (data) => {
      const chunk = data.toString();

      if (!stdoutTruncated) {
        const remaining = CONTAINER_MAX_OUTPUT_SIZE - stdout.length;
        if (chunk.length > remaining) {
          stdout += chunk.slice(0, remaining);
          stdoutTruncated = true;
        } else {
          stdout += chunk;
        }
      }

      if (onOutput) {
        parseBuffer += chunk;
        let startIdx: number;
        while ((startIdx = parseBuffer.indexOf(OUTPUT_START_MARKER)) !== -1) {
          const endIdx = parseBuffer.indexOf(OUTPUT_END_MARKER, startIdx);
          if (endIdx === -1) break;

          const jsonStr = parseBuffer
            .slice(startIdx + OUTPUT_START_MARKER.length, endIdx)
            .trim();
          parseBuffer = parseBuffer.slice(endIdx + OUTPUT_END_MARKER.length);

          try {
            const parsed: ContainerOutput = JSON.parse(jsonStr);
            if (parsed.newSessionId) {
              newSessionId = parsed.newSessionId;
            }
            hadStreamingOutput = true;
            resetTimeout();
            outputChain = outputChain.then(() => onOutput(parsed));
          } catch (err) {
            logger.warn(
              { group: group.name, error: err },
              'Failed to parse streamed output chunk',
            );
          }
        }
      }
    });

    proc.stderr.on('data', (data) => {
      const chunk = data.toString();
      const lines = chunk.trim().split('\n');
      for (const line of lines) {
        if (line) logger.debug({ process: group.folder }, line);
      }
      if (stderrTruncated) return;
      const remaining = CONTAINER_MAX_OUTPUT_SIZE - stderr.length;
      if (chunk.length > remaining) {
        stderr += chunk.slice(0, remaining);
        stderrTruncated = true;
      } else {
        stderr += chunk;
      }
    });

    proc.on('close', (code) => {
      clearTimeout(timeout);
      const duration = Date.now() - startTime;

      if (timedOut) {
        if (hadStreamingOutput) {
          outputChain.then(() => {
            resolve({ status: 'success', result: null, newSessionId });
          });
          return;
        }
        resolve({
          status: 'error',
          result: null,
          error: `Native agent timed out after ${configTimeout}ms`,
        });
        return;
      }

      // Write run log on error (mirrors container-runner behaviour)
      if (code !== 0) {
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const logFile = path.join(logsDir, `native-${timestamp}.log`);
        fs.writeFileSync(
          logFile,
          [
            `=== Native Agent Run Log ===`,
            `Timestamp: ${new Date().toISOString()}`,
            `Group: ${group.name}`,
            `Duration: ${duration}ms`,
            `Exit Code: ${code}`,
            ``,
            `=== Stderr ===`,
            stderr,
            ``,
            `=== Stdout ===`,
            stdout,
          ].join('\n'),
        );

        logger.error(
          { group: group.name, code, duration },
          'Native agent exited with error',
        );
        resolve({
          status: 'error',
          result: null,
          error: `Native agent exited with code ${code}: ${stderr.slice(-200)}`,
        });
        return;
      }

      // Streaming mode: all output delivered via onOutput callbacks
      if (onOutput) {
        outputChain.then(() => {
          logger.info(
            { group: group.name, duration, newSessionId },
            'Native agent completed',
          );
          resolve({ status: 'success', result: null, newSessionId });
        });
        return;
      }

      // Legacy mode: parse the last OUTPUT_START/END pair from stdout
      try {
        const startIdx = stdout.indexOf(OUTPUT_START_MARKER);
        const endIdx = stdout.indexOf(OUTPUT_END_MARKER);
        let jsonLine: string;
        if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
          jsonLine = stdout
            .slice(startIdx + OUTPUT_START_MARKER.length, endIdx)
            .trim();
        } else {
          const lines = stdout.trim().split('\n');
          jsonLine = lines[lines.length - 1];
        }
        const output: ContainerOutput = JSON.parse(jsonLine);
        logger.info(
          { group: group.name, duration, status: output.status },
          'Native agent completed',
        );
        resolve(output);
      } catch (err) {
        resolve({
          status: 'error',
          result: null,
          error: `Failed to parse native agent output: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    });

    proc.on('error', (err) => {
      clearTimeout(timeout);
      logger.error(
        { group: group.name, error: err },
        'Native agent spawn error',
      );
      resolve({
        status: 'error',
        result: null,
        error: `Native agent spawn error: ${err.message}`,
      });
    });
  });
}
