/**
 * Sprites Backend for NanoClaw
 * Runs agents on persistent Fly.io Sprites (cloud VMs).
 * Each group gets its own long-lived Sprite.
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

import {
  CONTAINER_MAX_OUTPUT_SIZE,
  CONTAINER_STARTUP_TIMEOUT,
  CONTAINER_TIMEOUT,
  DATA_DIR,
  GROUPS_DIR,
  IDLE_TIMEOUT,
  SPRITES_RAM_MB,
  SPRITES_REGION,
  SPRITES_TOKEN,
} from '../config.js';
import { logger } from '../logger.js';
import { ContainerProcess, RegisteredGroup } from '../types.js';
import { StreamParser } from './stream-parser.js';
import { provisionSprite } from './sprites-provisioning.js';
import {
  AgentBackend,
  ContainerInput,
  ContainerOutput,
} from './types.js';

const API_BASE = 'https://api.sprites.dev/v1';

/** Lightweight wrapper around Sprites REST + Exec API */
class SpriteClient {
  private token: string;
  private spriteName: string;

  constructor(token: string, spriteName: string) {
    this.token = token;
    this.spriteName = spriteName;
  }

  private headers(): Record<string, string> {
    return {
      'Authorization': `Bearer ${this.token}`,
      'Content-Type': 'application/json',
    };
  }

  /** Create the Sprite if it doesn't exist. Returns true if created, false if already exists. */
  async ensureExists(): Promise<boolean> {
    // Check if sprite exists
    const getResp = await fetch(`${API_BASE}/sprites/${this.spriteName}`, {
      headers: this.headers(),
    });

    if (getResp.ok) {
      return false; // Already exists
    }

    if (getResp.status !== 404) {
      throw new Error(`Failed to check sprite: ${getResp.status} ${await getResp.text()}`);
    }

    // Create sprite
    const createResp = await fetch(`${API_BASE}/sprites`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({
        name: this.spriteName,
        ...(SPRITES_REGION ? { region: SPRITES_REGION } : {}),
        ...(SPRITES_RAM_MB ? { ram_mb: SPRITES_RAM_MB } : {}),
      }),
    });

    if (!createResp.ok) {
      throw new Error(`Failed to create sprite: ${createResp.status} ${await createResp.text()}`);
    }

    return true;
  }

  /** Execute a command and return stdout/stderr. */
  async exec(cmd: string, opts?: { timeout?: number }): Promise<{ stdout: string; stderr: string }> {
    const resp = await fetch(`${API_BASE}/sprites/${this.spriteName}/exec`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({
        cmd: ['bash', '-c', cmd],
      }),
      signal: opts?.timeout ? AbortSignal.timeout(opts.timeout) : undefined,
    });

    if (!resp.ok) {
      const body = await resp.text();
      throw new Error(`Exec failed (${resp.status}): ${body}`);
    }

    const result = await resp.json() as { stdout: string; stderr: string; exit_code: number };
    if (result.exit_code !== 0) {
      const err = new Error(`Command failed with exit code ${result.exit_code}: ${result.stderr}`);
      (err as any).exitCode = result.exit_code;
      (err as any).stdout = result.stdout;
      (err as any).stderr = result.stderr;
      throw err;
    }
    return { stdout: result.stdout, stderr: result.stderr };
  }

  /** Read a file from the Sprite filesystem. */
  async readFile(remotePath: string): Promise<Buffer | null> {
    const resp = await fetch(
      `${API_BASE}/sprites/${this.spriteName}/fs/read?path=${encodeURIComponent(remotePath)}`,
      { headers: { 'Authorization': `Bearer ${this.token}` } },
    );

    if (resp.status === 404) return null;
    if (!resp.ok) {
      throw new Error(`Failed to read file ${remotePath}: ${resp.status}`);
    }

    return Buffer.from(await resp.arrayBuffer());
  }

  /** Write a file to the Sprite filesystem. */
  async writeFile(remotePath: string, content: Buffer | string, opts?: { mkdir?: boolean }): Promise<void> {
    const params = new URLSearchParams({ path: remotePath });
    if (opts?.mkdir) params.set('mkdir', 'true');

    const resp = await fetch(
      `${API_BASE}/sprites/${this.spriteName}/fs/write?${params}`,
      {
        method: 'PUT',
        headers: { 'Authorization': `Bearer ${this.token}` },
        body: typeof content === 'string' ? new TextEncoder().encode(content) : content,
      },
    );

    if (!resp.ok) {
      throw new Error(`Failed to write file ${remotePath}: ${resp.status} ${await resp.text()}`);
    }
  }

  /** Get the Sprite's public URL. */
  async getUrl(): Promise<string | undefined> {
    const resp = await fetch(`${API_BASE}/sprites/${this.spriteName}`, {
      headers: this.headers(),
    });
    if (!resp.ok) return undefined;
    const data = await resp.json() as { url?: string };
    return data.url;
  }

  get name(): string {
    return this.spriteName;
  }
}

/** Content hash cache: skip uploading unchanged files. */
const fileHashCache = new Map<string, string>();

function hashContent(content: string | Buffer): string {
  return crypto.createHash('sha256').update(content).digest('hex').slice(0, 16);
}

/**
 * Upload a file only if its content has changed since last upload.
 */
async function syncFile(
  sprite: SpriteClient,
  remotePath: string,
  content: string | Buffer,
  cacheKey: string,
): Promise<boolean> {
  const hash = hashContent(content);
  if (fileHashCache.get(cacheKey) === hash) {
    return false; // No change
  }

  await sprite.writeFile(remotePath, content, { mkdir: true });
  fileHashCache.set(cacheKey, hash);
  return true;
}

export class SpritesBackend implements AgentBackend {
  readonly name = 'sprites';
  private sprites = new Map<string, SpriteClient>();

  private getSpriteClient(groupFolder: string): SpriteClient {
    let client = this.sprites.get(groupFolder);
    if (!client) {
      const spriteName = `nanoclaw-${groupFolder.replace(/[^a-zA-Z0-9-]/g, '-')}`;
      client = new SpriteClient(SPRITES_TOKEN, spriteName);
      this.sprites.set(groupFolder, client);
    }
    return client;
  }

  async runAgent(
    group: RegisteredGroup,
    input: ContainerInput,
    onProcess: (proc: ContainerProcess, containerName: string) => void,
    onOutput?: (output: ContainerOutput) => Promise<void>,
  ): Promise<ContainerOutput> {
    const startTime = Date.now();
    const sprite = this.getSpriteClient(group.folder);

    logger.info(
      { group: group.name, sprite: sprite.name, isMain: input.isMain },
      'Running agent on Sprites',
    );

    // Ensure Sprite exists and is provisioned
    const isNew = await sprite.ensureExists();
    if (isNew) {
      await provisionSprite(sprite, sprite.name);
    }

    // Sync files that may change between invocations
    await this.syncFiles(sprite, group, input.isMain);

    // Write input JSON
    await sprite.writeFile('/tmp/input.json', JSON.stringify(input), { mkdir: true });

    // Run the entrypoint
    const configTimeout = group.containerConfig?.timeout || CONTAINER_TIMEOUT;
    const timeoutMs = Math.max(configTimeout, IDLE_TIMEOUT + 30_000);

    // Create a mock process object for the queue
    let killed = false;
    const mockProcess: ContainerProcess = {
      get killed() { return killed; },
      kill(_signal?: number | string) { killed = true; },
      pid: 0,
    };

    onProcess(mockProcess, sprite.name);

    const parser = new StreamParser({
      groupName: group.name,
      containerName: sprite.name,
      timeoutMs,
      startupTimeoutMs: CONTAINER_STARTUP_TIMEOUT,
      maxOutputSize: CONTAINER_MAX_OUTPUT_SIZE,
      onOutput,
      onTimeout: () => {
        killed = true;
      },
    });

    try {
      // Execute via POST exec with streaming
      // The Sprites exec POST API returns stdout/stderr after completion.
      // For streaming, we use the entrypoint which writes OUTPUT markers to stdout.
      const result = await sprite.exec(
        'bash /app/entrypoint.sh < /tmp/input.json 2>/tmp/stderr.log',
        { timeout: timeoutMs + 30_000 },
      );

      // Feed parser the output
      parser.feedStdout(result.stdout);

      // Read stderr from the log file
      try {
        const stderrResult = await sprite.exec('cat /tmp/stderr.log 2>/dev/null || true');
        parser.feedStderr(stderrResult.stdout);
      } catch {
        // ignore stderr read failures
      }

      parser.cleanup();
      const state = parser.getState();
      const duration = Date.now() - startTime;

      if (onOutput) {
        await state.outputChain;
        logger.info(
          { group: group.name, duration, newSessionId: state.newSessionId },
          'Sprites agent completed (streaming mode)',
        );
        return { status: 'success', result: null, newSessionId: state.newSessionId };
      }

      // Legacy mode
      try {
        const output = parser.parseFinalOutput();
        logger.info(
          { group: group.name, duration, status: output.status },
          'Sprites agent completed',
        );
        return output;
      } catch (err) {
        logger.error(
          { group: group.name, error: err },
          'Failed to parse Sprites agent output',
        );
        return {
          status: 'error',
          result: null,
          error: `Failed to parse output: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    } catch (err) {
      parser.cleanup();
      const duration = Date.now() - startTime;

      // Check if output was already streamed
      const state = parser.getState();
      if (state.hadStreamingOutput) {
        await state.outputChain;
        logger.info(
          { group: group.name, duration },
          'Sprites agent exited after streaming output',
        );
        return { status: 'success', result: null, newSessionId: state.newSessionId };
      }

      logger.error(
        { group: group.name, sprite: sprite.name, error: err, duration },
        'Sprites agent error',
      );
      return {
        status: 'error',
        result: null,
        error: `Sprites exec error: ${err instanceof Error ? err.message : String(err)}`,
      };
    } finally {
      // Download files that may have changed (CLAUDE.md, conversations)
      await this.downloadChangedFiles(sprite, group);
    }
  }

  /**
   * Sync host-side files to the Sprite before each invocation.
   * Only uploads files whose content has changed (via SHA-256 hash).
   */
  private async syncFiles(sprite: SpriteClient, group: RegisteredGroup, isMain: boolean): Promise<void> {
    const projectRoot = process.cwd();
    const syncOps: Promise<boolean>[] = [];

    // Group CLAUDE.md
    const groupClaudeMd = path.join(GROUPS_DIR, group.folder, 'CLAUDE.md');
    if (fs.existsSync(groupClaudeMd)) {
      const content = fs.readFileSync(groupClaudeMd, 'utf-8');
      syncOps.push(syncFile(sprite, '/workspace/group/CLAUDE.md', content, `${group.folder}:CLAUDE.md`));
    }

    // Global CLAUDE.md (non-main only)
    if (!isMain) {
      const globalClaudeMd = path.join(GROUPS_DIR, 'global', 'CLAUDE.md');
      if (fs.existsSync(globalClaudeMd)) {
        const content = fs.readFileSync(globalClaudeMd, 'utf-8');
        syncOps.push(syncFile(sprite, '/workspace/global/CLAUDE.md', content, 'global:CLAUDE.md'));
      }
    }

    // Environment file
    const envFile = path.join(DATA_DIR, 'env', 'env');
    if (fs.existsSync(envFile)) {
      const content = fs.readFileSync(envFile, 'utf-8');
      syncOps.push(syncFile(sprite, '/workspace/env-dir/env', content, 'env'));
    }

    // Agent-runner source files
    const agentRunnerDir = path.join(projectRoot, 'container', 'agent-runner', 'src');
    if (fs.existsSync(agentRunnerDir)) {
      for (const file of fs.readdirSync(agentRunnerDir)) {
        if (!file.endsWith('.ts')) continue;
        const content = fs.readFileSync(path.join(agentRunnerDir, file), 'utf-8');
        syncOps.push(syncFile(sprite, `/app/src/${file}`, content, `agent-runner:${file}`));
      }
    }

    // Agent-runner package.json
    const agentPkgJson = path.join(projectRoot, 'container', 'agent-runner', 'package.json');
    if (fs.existsSync(agentPkgJson)) {
      const content = fs.readFileSync(agentPkgJson, 'utf-8');
      syncOps.push(syncFile(sprite, '/app/package.json', content, 'agent-runner:package.json'));
    }

    // Entrypoint
    const entrypoint = path.join(projectRoot, 'container', 'entrypoint.sh');
    if (fs.existsSync(entrypoint)) {
      const content = fs.readFileSync(entrypoint, 'utf-8');
      syncOps.push(syncFile(sprite, '/app/entrypoint.sh', content, 'entrypoint'));
    }

    // Skills
    const skillsSrc = path.join(projectRoot, 'container', 'skills');
    if (fs.existsSync(skillsSrc)) {
      for (const skillDir of fs.readdirSync(skillsSrc)) {
        const srcDir = path.join(skillsSrc, skillDir);
        if (!fs.statSync(srcDir).isDirectory()) continue;
        for (const file of fs.readdirSync(srcDir)) {
          const content = fs.readFileSync(path.join(srcDir, file), 'utf-8');
          syncOps.push(syncFile(
            sprite,
            `/home/user/.claude/skills/${skillDir}/${file}`,
            content,
            `skills:${skillDir}/${file}`,
          ));
        }
      }
    }

    const results = await Promise.all(syncOps);
    const uploaded = results.filter(Boolean).length;
    if (uploaded > 0) {
      logger.debug({ group: group.folder, uploaded, total: results.length }, 'Synced files to Sprite');
    }

    // Run bun install if package.json was uploaded (new/changed deps)
    if (fileHashCache.get('agent-runner:package.json:installed') !== fileHashCache.get('agent-runner:package.json')) {
      try {
        await sprite.exec('export PATH="$HOME/.bun/bin:$PATH" && cd /app && bun install', { timeout: 60_000 });
        fileHashCache.set('agent-runner:package.json:installed', fileHashCache.get('agent-runner:package.json') || '');
      } catch (err) {
        logger.warn({ group: group.folder, error: err }, 'Failed to install agent-runner deps on Sprite');
      }
    }
  }

  /**
   * Download files that may have changed during agent execution.
   * Agent may update CLAUDE.md (memory) and conversation files.
   */
  private async downloadChangedFiles(sprite: SpriteClient, group: RegisteredGroup): Promise<void> {
    try {
      // Download updated CLAUDE.md
      const claudeMd = await sprite.readFile('/workspace/group/CLAUDE.md');
      if (claudeMd) {
        const localPath = path.join(GROUPS_DIR, group.folder, 'CLAUDE.md');
        const localContent = fs.existsSync(localPath) ? fs.readFileSync(localPath) : null;
        if (!localContent || !claudeMd.equals(localContent)) {
          fs.writeFileSync(localPath, claudeMd);
          // Update hash cache so next sync doesn't re-upload our own download
          fileHashCache.set(`${group.folder}:CLAUDE.md`, hashContent(claudeMd));
          logger.debug({ group: group.folder }, 'Downloaded updated CLAUDE.md from Sprite');
        }
      }
    } catch (err) {
      logger.warn({ group: group.folder, error: err }, 'Failed to download files from Sprite');
    }
  }

  sendMessage(groupFolder: string, text: string): boolean {
    const sprite = this.getSpriteClient(groupFolder);
    // Write IPC input file asynchronously — fire and forget
    sprite.writeFile(
      `/workspace/ipc/input/${Date.now()}-${Math.random().toString(36).slice(2, 6)}.json`,
      JSON.stringify({ type: 'message', text }),
      { mkdir: true },
    ).catch((err) => {
      logger.warn({ groupFolder, error: err }, 'Failed to send message to Sprite IPC');
    });
    return true;
  }

  closeStdin(groupFolder: string): void {
    const sprite = this.getSpriteClient(groupFolder);
    sprite.writeFile('/workspace/ipc/input/_close', '').catch((err) => {
      logger.warn({ groupFolder, error: err }, 'Failed to write close sentinel to Sprite');
    });
  }

  writeIpcData(groupFolder: string, filename: string, data: string): void {
    const sprite = this.getSpriteClient(groupFolder);
    sprite.writeFile(`/workspace/ipc/${filename}`, data, { mkdir: true }).catch((err) => {
      logger.warn({ groupFolder, filename, error: err }, 'Failed to write IPC data to Sprite');
    });
  }

  async readFile(groupFolder: string, relativePath: string): Promise<Buffer | null> {
    const sprite = this.getSpriteClient(groupFolder);
    return sprite.readFile(`/workspace/group/${relativePath}`);
  }

  async writeFile(groupFolder: string, relativePath: string, content: Buffer | string): Promise<void> {
    const sprite = this.getSpriteClient(groupFolder);
    await sprite.writeFile(`/workspace/group/${relativePath}`, content, { mkdir: true });
  }

  /** Get the Sprite's dev URL for a group. */
  async getDevUrl(groupFolder: string): Promise<string | undefined> {
    const sprite = this.getSpriteClient(groupFolder);
    return sprite.getUrl();
  }

  async initialize(): Promise<void> {
    if (!SPRITES_TOKEN) {
      logger.warn('SPRITES_TOKEN not set — Sprites backend will not function');
      return;
    }
    logger.info('Sprites backend initialized');
  }

  async shutdown(): Promise<void> {
    // Sprites persist — no cleanup needed on shutdown
    logger.info('Sprites backend shutdown (sprites remain running)');
  }
}
