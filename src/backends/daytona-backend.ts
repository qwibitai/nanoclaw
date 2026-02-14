/**
 * Daytona Backend for NanoClaw
 * Runs agents on Daytona cloud sandboxes via the official TypeScript SDK.
 * Each group gets its own persistent sandbox.
 *
 * Path strategy: The Daytona FS API resolves relative paths from the sandbox
 * working directory. Provisioning creates symlinks from /workspace and /app to
 * the workdir equivalents so shell commands (entrypoint.sh) still work with
 * absolute paths.
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { Daytona, type Sandbox } from '@daytonaio/sdk';

import {
  CONTAINER_MAX_OUTPUT_SIZE,
  CONTAINER_STARTUP_TIMEOUT,
  CONTAINER_TIMEOUT,
  DATA_DIR,
  DAYTONA_API_KEY,
  DAYTONA_API_URL,
  DAYTONA_SNAPSHOT,
  GROUPS_DIR,
  IDLE_TIMEOUT,
} from '../config.js';
import { logger } from '../logger.js';
import { ContainerProcess } from '../types.js';
import { StreamParser } from './stream-parser.js';
import { provisionDaytona } from './daytona-provisioning.js';
import {
  AgentBackend,
  AgentOrGroup,
  ContainerInput,
  ContainerOutput,
  getContainerConfig,
  getFolder,
  getName,
} from './types.js';

/** Content hash cache: skip uploading unchanged files. */
const fileHashCache = new Map<string, string>();

function hashContent(content: string | Buffer): string {
  return crypto.createHash('sha256').update(content).digest('hex').slice(0, 16);
}

/**
 * Upload a file via FS API using a relative path (resolved from workdir).
 * Creates parent directories on failure and retries.
 */
async function uploadFile(sandbox: Sandbox, relativePath: string, content: string | Buffer): Promise<void> {
  const buf = typeof content === 'string' ? Buffer.from(content) : content;
  try {
    await sandbox.fs.uploadFile(buf, relativePath);
  } catch {
    // Parent directory may not exist — create it and retry
    const dir = relativePath.substring(0, relativePath.lastIndexOf('/'));
    if (dir) {
      await sandbox.fs.createFolder(dir, '755');
    }
    await sandbox.fs.uploadFile(buf, relativePath);
  }
}

/**
 * Download a file via FS API using a relative path.
 */
async function downloadFile(sandbox: Sandbox, relativePath: string): Promise<Buffer | null> {
  try {
    return await sandbox.fs.downloadFile(relativePath);
  } catch {
    return null;
  }
}

/**
 * Upload a file only if its content has changed since last upload.
 */
async function syncFile(
  sandbox: Sandbox,
  relativePath: string,
  content: string | Buffer,
  cacheKey: string,
): Promise<boolean> {
  const hash = hashContent(content);
  if (fileHashCache.get(cacheKey) === hash) {
    return false; // No change
  }

  await uploadFile(sandbox, relativePath, content);
  fileHashCache.set(cacheKey, hash);
  return true;
}

/**
 * Wraps a Daytona session as a ContainerProcess.
 * Since Daytona sessions don't expose PIDs, we track kill state manually.
 */
class DaytonaProcessWrapper implements ContainerProcess {
  private _killed = false;
  private sandbox: Sandbox;
  private sessionId: string;

  constructor(sandbox: Sandbox, sessionId: string) {
    this.sandbox = sandbox;
    this.sessionId = sessionId;
  }

  get killed(): boolean {
    return this._killed;
  }

  kill(): void {
    if (this._killed) return;
    this._killed = true;
    this.sandbox.process.deleteSession(this.sessionId).catch(() => {});
  }

  get pid(): number {
    return 0; // Daytona sessions don't have PIDs
  }
}

/** Cached sandbox metadata (workdir, homedir). */
interface SandboxMeta {
  sandbox: Sandbox;
  homeDir: string; // e.g. /home/daytona
}

export class DaytonaBackend implements AgentBackend {
  readonly name = 'daytona';
  private daytona!: Daytona;
  private sandboxes = new Map<string, SandboxMeta>();

  /**
   * Get or create a sandbox for a group.
   * Handles all states: started, stopped, archived, missing.
   */
  async getSandbox(groupFolder: string): Promise<SandboxMeta> {
    // Check cache
    const cached = this.sandboxes.get(groupFolder);
    if (cached) {
      // Refresh state to detect external stop/archive
      await cached.sandbox.refreshData();
      if (cached.sandbox.state === 'started') return cached;

      // Recover from stopped/archived
      logger.info({ group: groupFolder, state: cached.sandbox.state }, 'Daytona sandbox not running, starting...');
      await cached.sandbox.start(120);
      return cached;
    }

    const sandboxName = `nanoclaw-${groupFolder.replace(/[^a-zA-Z0-9-]/g, '-')}`;

    // Try to find existing sandbox
    let sandbox: Sandbox | null = null;
    try {
      sandbox = await this.daytona.get(sandboxName);
      if (sandbox.state !== 'started') {
        logger.info({ group: groupFolder, state: sandbox.state }, 'Recovering Daytona sandbox...');
        await sandbox.start(120);
      }
    } catch {
      // Not found — create new
      logger.info({ group: groupFolder, sandbox: sandboxName }, 'Creating new Daytona sandbox');
      sandbox = await this.daytona.create({
        name: sandboxName,
        ...(DAYTONA_SNAPSHOT ? { snapshot: DAYTONA_SNAPSHOT } : {}),
        language: 'typescript',
        autoStopInterval: 0, // Don't auto-stop (we manage lifecycle)
        labels: { project: 'nanoclaw', group: groupFolder },
      }, { timeout: 120 });
    }

    // Discover home directory
    const homeDir = await sandbox.getUserHomeDir() || '/home/daytona';
    const meta: SandboxMeta = { sandbox, homeDir };
    this.sandboxes.set(groupFolder, meta);
    return meta;
  }

  /**
   * Get the cached sandbox for a group (for IPC poller).
   * Returns null if no sandbox has been created/fetched yet.
   */
  getSandboxForGroup(groupFolder: string): Sandbox | null {
    return this.sandboxes.get(groupFolder)?.sandbox || null;
  }

  async runAgent(
    group: AgentOrGroup,
    input: ContainerInput,
    onProcess: (proc: ContainerProcess, containerName: string) => void,
    onOutput?: (output: ContainerOutput) => Promise<void>,
  ): Promise<ContainerOutput> {
    const startTime = Date.now();
    const { sandbox, homeDir } = await this.getSandbox(group.folder);
    const sandboxName = sandbox.name || `nanoclaw-${group.folder}`;

    logger.info(
      { group: group.name, sandbox: sandboxName, isMain: input.isMain },
      'Running agent on Daytona',
    );

    // Provision if needed (first run)
    await provisionDaytona(sandbox, sandboxName);

    // Sync files that may change between invocations
    await this.syncFiles(sandbox, group, input.isMain, homeDir);

    // Write input JSON (use /tmp which is globally writable)
    await sandbox.process.executeCommand(
      `echo '${Buffer.from(JSON.stringify(input)).toString('base64')}' | base64 -d > /tmp/input.json`,
    );

    // Clean up stale close sentinel
    try {
      await sandbox.process.executeCommand('rm -f /workspace/ipc/input/_close');
    } catch { /* ignore */ }

    const configTimeout = group.containerConfig?.timeout || CONTAINER_TIMEOUT;
    const timeoutMs = Math.max(configTimeout, IDLE_TIMEOUT + 30_000);

    // Create a session for this run
    const sessionId = `run-${Date.now()}`;
    await sandbox.process.createSession(sessionId);

    // Create wrapper process and notify caller
    const processWrapper = new DaytonaProcessWrapper(sandbox, sessionId);
    onProcess(processWrapper, sandboxName);

    const killOnTimeout = () => {
      logger.error({ group: group.name, sandbox: sandboxName }, 'Daytona agent timeout, killing');
      processWrapper.kill();
    };

    const parser = new StreamParser({
      groupName: group.name,
      containerName: sandboxName,
      timeoutMs,
      startupTimeoutMs: CONTAINER_STARTUP_TIMEOUT,
      maxOutputSize: CONTAINER_MAX_OUTPUT_SIZE,
      onOutput,
      onTimeout: killOnTimeout,
    });

    // Execute command async in session
    let exitCode = 1;
    try {
      const execResult = await sandbox.process.executeSessionCommand(sessionId, {
        command: 'bash /app/entrypoint.sh < /tmp/input.json',
        runAsync: true,
      });

      // Stream logs via callback — clean stdout/stderr separation
      await sandbox.process.getSessionCommandLogs(
        sessionId,
        execResult.cmdId!,
        (stdoutChunk: string) => {
          parser.feedStdout(stdoutChunk);
        },
        (stderrChunk: string) => {
          parser.feedStderr(stderrChunk);
        },
      );

      // After streaming completes, get final exit code
      const cmd = await sandbox.process.getSessionCommand(sessionId, execResult.cmdId!);
      exitCode = cmd.exitCode ?? 0;
    } catch (err) {
      if (!processWrapper.killed) {
        logger.error({ group: group.name, error: err }, 'Daytona session execution error');
      }
    }

    parser.cleanup();

    // Clean up session
    try {
      await sandbox.process.deleteSession(sessionId);
    } catch { /* ignore */ }

    const duration = Date.now() - startTime;
    const state = parser.getState();

    // Download files that may have changed
    await this.downloadChangedFiles(sandbox, group);

    if (state.timedOut) {
      if (state.hadStreamingOutput) {
        await state.outputChain;
        return { status: 'success', result: null, newSessionId: state.newSessionId };
      }
      return { status: 'error', result: null, error: `Daytona agent timed out after ${configTimeout}ms` };
    }

    if (exitCode !== 0 && !state.hadStreamingOutput) {
      logger.error(
        { group: group.name, sandbox: sandboxName, code: exitCode, duration },
        'Daytona agent exited with error',
      );
      return {
        status: 'error',
        result: null,
        error: `Daytona agent exited with code ${exitCode}: ${state.stderr.slice(-200)}`,
      };
    }

    // Streaming mode
    if (onOutput) {
      await state.outputChain;
      logger.info(
        { group: group.name, duration, newSessionId: state.newSessionId },
        'Daytona agent completed (streaming mode)',
      );
      return { status: 'success', result: null, newSessionId: state.newSessionId };
    }

    // Legacy mode
    try {
      const output = parser.parseFinalOutput();
      logger.info(
        { group: group.name, duration, status: output.status },
        'Daytona agent completed',
      );
      return output;
    } catch (err) {
      logger.error(
        { group: group.name, error: err },
        'Failed to parse Daytona agent output',
      );
      return {
        status: 'error',
        result: null,
        error: `Failed to parse output: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  /**
   * Sync host-side files to the sandbox before each invocation.
   * Only uploads files whose content has changed (via SHA-256 hash).
   * Uses relative paths for the FS API (resolved from sandbox workdir).
   */
  private async syncFiles(sandbox: Sandbox, group: AgentOrGroup, isMain: boolean, homeDir: string): Promise<void> {
    const projectRoot = process.cwd();
    const syncOps: Promise<boolean>[] = [];

    // Group CLAUDE.md
    const groupClaudeMd = path.join(GROUPS_DIR, group.folder, 'CLAUDE.md');
    if (fs.existsSync(groupClaudeMd)) {
      const content = fs.readFileSync(groupClaudeMd, 'utf-8');
      syncOps.push(syncFile(sandbox, 'workspace/group/CLAUDE.md', content, `${group.folder}:CLAUDE.md`));
    }

    // Global CLAUDE.md (non-main only)
    if (!isMain) {
      const globalClaudeMd = path.join(GROUPS_DIR, 'global', 'CLAUDE.md');
      if (fs.existsSync(globalClaudeMd)) {
        const content = fs.readFileSync(globalClaudeMd, 'utf-8');
        syncOps.push(syncFile(sandbox, 'workspace/global/CLAUDE.md', content, 'global:CLAUDE.md'));
      }
    }

    // Environment file
    const envFile = path.join(DATA_DIR, 'env', 'env');
    if (fs.existsSync(envFile)) {
      const content = fs.readFileSync(envFile, 'utf-8');
      syncOps.push(syncFile(sandbox, 'workspace/env-dir/env', content, 'env'));
    }

    // Agent-runner source files
    const agentRunnerDir = path.join(projectRoot, 'container', 'agent-runner', 'src');
    if (fs.existsSync(agentRunnerDir)) {
      for (const file of fs.readdirSync(agentRunnerDir)) {
        if (!file.endsWith('.ts')) continue;
        const content = fs.readFileSync(path.join(agentRunnerDir, file), 'utf-8');
        syncOps.push(syncFile(sandbox, `app/src/${file}`, content, `agent-runner:${file}`));
      }
    }

    // Agent-runner package.json
    const agentPkgJson = path.join(projectRoot, 'container', 'agent-runner', 'package.json');
    if (fs.existsSync(agentPkgJson)) {
      const content = fs.readFileSync(agentPkgJson, 'utf-8');
      syncOps.push(syncFile(sandbox, 'app/package.json', content, 'agent-runner:package.json'));
    }

    // Entrypoint
    const entrypoint = path.join(projectRoot, 'container', 'entrypoint.sh');
    if (fs.existsSync(entrypoint)) {
      const content = fs.readFileSync(entrypoint, 'utf-8');
      syncOps.push(syncFile(sandbox, 'app/entrypoint.sh', content, 'entrypoint'));
    }

    // Skills — use discovered home dir for .claude path
    const skillsSrc = path.join(projectRoot, 'container', 'skills');
    if (fs.existsSync(skillsSrc)) {
      // Compute relative path from workdir to home's .claude/skills
      // FS API resolves relative to workdir, so we need the right relative path
      // Safest: use absolute home path with leading slash stripped won't work if workdir != homedir
      // Instead: use executeCommand to write skills since they go under $HOME
      for (const skillDir of fs.readdirSync(skillsSrc)) {
        const srcDir = path.join(skillsSrc, skillDir);
        if (!fs.statSync(srcDir).isDirectory()) continue;
        for (const file of fs.readdirSync(srcDir)) {
          const content = fs.readFileSync(path.join(srcDir, file), 'utf-8');
          const cacheKey = `skills:${skillDir}/${file}`;
          const hash = hashContent(content);
          if (fileHashCache.get(cacheKey) !== hash) {
            const b64 = Buffer.from(content).toString('base64');
            syncOps.push(
              sandbox.process.executeCommand(
                `mkdir -p ${homeDir}/.claude/skills/${skillDir} && echo '${b64}' | base64 -d > ${homeDir}/.claude/skills/${skillDir}/${file}`,
              ).then(() => {
                fileHashCache.set(cacheKey, hash);
                return true;
              }),
            );
          }
        }
      }
    }

    const results = await Promise.all(syncOps);
    const uploaded = results.filter(Boolean).length;
    if (uploaded > 0) {
      logger.debug({ group: group.folder, uploaded, total: results.length }, 'Synced files to Daytona sandbox');
    }

    // Run bun install if package.json was uploaded (new/changed deps)
    if (fileHashCache.get('agent-runner:package.json:installed') !== fileHashCache.get('agent-runner:package.json')) {
      try {
        await sandbox.process.executeCommand(
          'export PATH="$HOME/.bun/bin:$PATH" && cd /app && bun install',
          undefined, undefined, 60,
        );
        fileHashCache.set('agent-runner:package.json:installed', fileHashCache.get('agent-runner:package.json') || '');
      } catch (err) {
        logger.warn({ group: group.folder, error: err }, 'Failed to install agent-runner deps on Daytona sandbox');
      }
    }
  }

  /**
   * Download files that may have changed during agent execution.
   */
  private async downloadChangedFiles(sandbox: Sandbox, group: AgentOrGroup): Promise<void> {
    try {
      const claudeMd = await downloadFile(sandbox, 'workspace/group/CLAUDE.md');
      if (claudeMd) {
        const localPath = path.join(GROUPS_DIR, group.folder, 'CLAUDE.md');
        const localContent = fs.existsSync(localPath) ? fs.readFileSync(localPath) : null;
        if (!localContent || !claudeMd.equals(localContent)) {
          fs.writeFileSync(localPath, claudeMd);
          fileHashCache.set(`${group.folder}:CLAUDE.md`, hashContent(claudeMd));
          logger.debug({ group: group.folder }, 'Downloaded updated CLAUDE.md from Daytona sandbox');
        }
      }
    } catch (err) {
      logger.warn({ group: group.folder, error: err }, 'Failed to download files from Daytona sandbox');
    }
  }

  sendMessage(groupFolder: string, text: string): boolean {
    const meta = this.sandboxes.get(groupFolder);
    if (!meta) return false;

    const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}.json`;
    uploadFile(
      meta.sandbox,
      `workspace/ipc/input/${filename}`,
      JSON.stringify({ type: 'message', text }),
    ).catch((err) => {
      logger.warn({ groupFolder, error: err }, 'Failed to send message to Daytona IPC');
    });
    return true;
  }

  closeStdin(groupFolder: string, inputSubdir: string = 'input'): void {
    const meta = this.sandboxes.get(groupFolder);
    if (!meta) return;

    uploadFile(meta.sandbox, `workspace/ipc/${inputSubdir}/_close`, '').catch((err) => {
      logger.warn({ groupFolder, error: err }, 'Failed to write close sentinel to Daytona sandbox');
    });
  }

  writeIpcData(groupFolder: string, filename: string, data: string): void {
    const meta = this.sandboxes.get(groupFolder);
    if (!meta) return;

    uploadFile(meta.sandbox, `workspace/ipc/${filename}`, data).catch((err) => {
      logger.warn({ groupFolder, filename, error: err }, 'Failed to write IPC data to Daytona sandbox');
    });
  }

  async readFile(groupFolder: string, relativePath: string): Promise<Buffer | null> {
    const meta = this.sandboxes.get(groupFolder);
    if (!meta) return null;

    return downloadFile(meta.sandbox, `workspace/group/${relativePath}`);
  }

  async writeFile(groupFolder: string, relativePath: string, content: Buffer | string): Promise<void> {
    const meta = this.sandboxes.get(groupFolder);
    if (!meta) throw new Error(`No Daytona sandbox for group ${groupFolder}`);

    await uploadFile(meta.sandbox, `workspace/group/${relativePath}`, content);
  }

  async initialize(): Promise<void> {
    if (!DAYTONA_API_KEY) {
      logger.warn('DAYTONA_API_KEY not set — Daytona backend will not function');
      return;
    }

    this.daytona = new Daytona({
      apiKey: DAYTONA_API_KEY,
      ...(DAYTONA_API_URL ? { apiUrl: DAYTONA_API_URL } : {}),
      _experimental: {},
    });

    logger.info('Daytona backend initialized');
  }

  async shutdown(): Promise<void> {
    // Sandboxes persist — no cleanup needed on shutdown
    logger.info('Daytona backend shutdown (sandboxes remain running)');
  }
}
