/**
 * Container Runner for NanoClaw
 * Spawns agent execution in containers and handles IPC
 */
import { ChildProcess, spawn } from 'child_process';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

import {
  CONTAINER_IMAGE,
  CONTAINER_MAX_OUTPUT_SIZE,
  CONTAINER_TIMEOUT,
  CREDENTIAL_PROXY_PORT,
  DATA_DIR,
  GROUPS_DIR,
  HOST_GID,
  HOST_PROJECT_ROOT,
  HOST_UID,
  IDLE_TIMEOUT,
  STORE_DIR,
  TILE_OWNER,
  TIMEZONE,
} from './config.js';
import { resolveGroupFolderPath, resolveGroupIpcPath } from './group-folder.js';
import { logger } from './logger.js';
import {
  CONTAINER_HOST_GATEWAY,
  CONTAINER_RUNTIME_BIN,
  hostGatewayArgs,
  readonlyMountArgs,
  stopContainer,
} from './container-runtime.js';
import { detectAuthMode } from './credential-proxy.js';
import { validateAdditionalMounts } from './mount-security.js';
import { RegisteredGroup } from './types.js';
import { readEnvFile } from './env.js';

/**
 * Select which tiles to install based on group trust tier.
 * Main: core + trusted + admin. Trusted: core + trusted. Untrusted: core + untrusted.
 * Admin loads last so it can override trusted skills.
 */
export function selectTiles(isMain: boolean, isTrusted: boolean): string[] {
  if (isMain) return ['nanoclaw-core', 'nanoclaw-trusted', 'nanoclaw-admin'];
  if (isTrusted) return ['nanoclaw-core', 'nanoclaw-trusted'];
  return ['nanoclaw-core', 'nanoclaw-untrusted'];
}

// Sentinel markers for robust output parsing (must match agent-runner)
const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

/**
 * Create a filtered copy of messages.db containing only one group's messages.
 * Returns the path to the filtered DB, or null if the source DB doesn't exist.
 */
function createFilteredDb(chatJid: string, groupFolder: string): string | null {
  const srcDb = path.join(STORE_DIR, 'messages.db');
  if (!fs.existsSync(srcDb)) return null;

  const filteredDir = path.join(DATA_DIR, 'filtered-db', groupFolder);
  fs.mkdirSync(filteredDir, { recursive: true });
  const filteredPath = path.join(filteredDir, 'messages.db');

  // Remove stale copy from previous run
  if (fs.existsSync(filteredPath)) {
    fs.unlinkSync(filteredPath);
  }

  // Use ATTACH to copy schema-agnostically — picks up new columns automatically
  const dst = new Database(filteredPath);
  try {
    dst.exec(`ATTACH DATABASE '${srcDb.replace(/'/g, "''")}' AS src`);
    dst.exec(
      `CREATE TABLE chats AS SELECT * FROM src.chats WHERE jid = '${chatJid.replace(/'/g, "''")}'`,
    );
    dst.exec(
      `CREATE TABLE messages AS SELECT * FROM src.messages WHERE chat_jid = '${chatJid.replace(/'/g, "''")}'`,
    );
    dst.exec('CREATE INDEX IF NOT EXISTS idx_timestamp ON messages(timestamp)');
    dst.exec('DETACH src');
  } finally {
    dst.close();
  }

  // Chown so container user can read
  const uid = HOST_UID ?? 1000;
  const gid = HOST_GID ?? 1000;
  if (uid !== 0) {
    try {
      fs.chownSync(filteredDir, uid, gid);
      fs.chownSync(filteredPath, uid, gid);
    } catch (err: unknown) {
      logger.warn({ err, filteredPath }, 'Failed to chown filtered DB');
    }
  }

  logger.debug(
    { chatJid, groupFolder, path: filteredPath },
    'Created filtered DB for untrusted container',
  );

  return filteredPath;
}

export interface ContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isTrusted?: boolean;
  isScheduledTask?: boolean;
  assistantName?: string;
  script?: string;
  replyToMessageId?: string;
}

export interface ContainerOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  error?: string;
  streamText?: string;
}

interface VolumeMount {
  hostPath: string;
  containerPath: string;
  readonly: boolean;
}

/**
 * Translate a local container path to a host path for docker -v arguments.
 * In Docker-out-of-Docker, the orchestrator's filesystem (/app/...) differs
 * from the host's (HOST_PROJECT_ROOT/...). Mount paths must use host paths.
 */
function chownRecursive(dir: string, uid: number, gid: number): void {
  fs.chownSync(dir, uid, gid);
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    fs.chownSync(fullPath, uid, gid);
    if (entry.isDirectory()) {
      chownRecursive(fullPath, uid, gid);
    }
  }
}

function toHostPath(localPath: string): string {
  const projectRoot = process.cwd();
  if (HOST_PROJECT_ROOT === projectRoot) return localPath; // running directly on host
  const rel = path.relative(projectRoot, localPath);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return localPath; // outside project
  return path.join(HOST_PROJECT_ROOT, rel);
}

function buildVolumeMounts(
  group: RegisteredGroup,
  isMain: boolean,
  chatJid: string,
): VolumeMount[] {
  const mounts: VolumeMount[] = [];
  const groupDir = resolveGroupFolderPath(group.folder);

  // Ensure AGENTS.md exists (chains .tessl/RULES.md into Claude Code context).
  // Must be created BEFORE the mount goes read-only for untrusted groups.
  const agentsMdPath = path.join(groupDir, 'AGENTS.md');
  if (!fs.existsSync(agentsMdPath)) {
    fs.writeFileSync(
      agentsMdPath,
      '\n\n# Agent Rules <!-- managed by orchestrator -->\n\n@.tessl/RULES.md follow the [instructions](.tessl/RULES.md)\n',
    );
  }

  if (isMain) {
    // Main gets the project root read-only.
    mounts.push({
      hostPath: toHostPath(process.cwd()),
      containerPath: '/workspace/project',
      readonly: true,
    });
  }

  // Group folder mount. Untrusted groups get read-only (disk exhaustion protection).
  mounts.push({
    hostPath: toHostPath(groupDir),
    containerPath: '/workspace/group',
    readonly: !isMain && !group.containerConfig?.trusted,
  });

  // Global memory directory (SOUL.md, shared CLAUDE.md).
  // Trusted + main get the full directory. Untrusted get only SOUL-untrusted.md
  // mounted as SOUL.md so core-behavior's "read SOUL.md" still works.
  const globalDir = path.join(GROUPS_DIR, 'global');
  if (isMain || group.containerConfig?.trusted) {
    if (fs.existsSync(globalDir)) {
      mounts.push({
        hostPath: toHostPath(globalDir),
        containerPath: '/workspace/global',
        readonly: !isMain,
      });
    }
  } else {
    // Untrusted: mount only the sanitized SOUL as a single file
    const untrustedSoul = path.join(globalDir, 'SOUL-untrusted.md');
    if (fs.existsSync(untrustedSoul)) {
      mounts.push({
        hostPath: toHostPath(untrustedSoul),
        containerPath: '/workspace/global/SOUL.md',
        readonly: true,
      });
    }
  }

  // .env shadowing is handled inside the container entrypoint via mount --bind
  // (Apple Container only supports directory mounts, not file mounts like /dev/null)

  // Shared trusted directory — writable space for trusted containers.
  if (isMain || group.containerConfig?.trusted) {
    const trustedDir = path.join(process.cwd(), 'trusted');
    fs.mkdirSync(trustedDir, { recursive: true });
    // Chown so container user can write memory files
    const trustedUid = HOST_UID ?? 1000;
    const trustedGid = HOST_GID ?? 1000;
    if (trustedUid !== 0) {
      try {
        fs.chownSync(trustedDir, trustedUid, trustedGid);
      } catch (err: unknown) {
        logger.warn({ err, trustedDir }, 'Failed to chown trusted dir');
      }
    }
    mounts.push({
      hostPath: toHostPath(trustedDir),
      containerPath: '/workspace/trusted',
      readonly: false,
    });
  }

  // Store directory (messages.db).
  // Trusted/main: full DB (all groups). Untrusted: filtered copy (own chat only).
  if (isMain || group.containerConfig?.trusted) {
    const storeDir = path.join(process.cwd(), 'store');
    if (fs.existsSync(storeDir)) {
      mounts.push({
        hostPath: toHostPath(storeDir),
        containerPath: '/workspace/store',
        readonly: true,
      });
    }
  } else {
    // Untrusted: create filtered DB with only this group's messages
    const filteredDb = createFilteredDb(chatJid, group.folder);
    if (filteredDb) {
      mounts.push({
        hostPath: toHostPath(path.dirname(filteredDb)),
        containerPath: '/workspace/store',
        readonly: true,
      });
    }
  }

  // Per-group Claude sessions directory (isolated from other groups)
  const groupSessionsDir = path.join(
    DATA_DIR,
    'sessions',
    group.folder,
    '.claude',
  );
  fs.mkdirSync(groupSessionsDir, { recursive: true });
  // Write settings.json only if content has changed — unnecessary rewrites
  // invalidate the SDK's prompt cache (file mtime changes trigger cache misses).
  const settingsFile = path.join(groupSessionsDir, 'settings.json');
  const newSettings =
    JSON.stringify(
      {
        env: {
          CLAUDE_CODE_MODEL: 'claude-opus-4-6',
          CLAUDE_CODE_MAX_CONTEXT_WINDOW: '1000000',
          CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
          CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: '1',
          CLAUDE_CODE_EFFORT_LEVEL: 'max',
          // Disable auto-memory for untrusted groups to prevent persistent injection
          CLAUDE_CODE_DISABLE_AUTO_MEMORY:
            isMain || group.containerConfig?.trusted ? '0' : '1',
        },
      },
      null,
      2,
    ) + '\n';
  if (
    !fs.existsSync(settingsFile) ||
    fs.readFileSync(settingsFile, 'utf-8') !== newSettings
  ) {
    fs.writeFileSync(settingsFile, newSettings);
  }

  // Tile delivery — all host-side, no tessl CLI in containers.
  // Build .tessl structure and skills/ from registry-installed tiles (tessl-workspace).
  // Main/trusted get all tiles. Others get nanoclaw-core only.
  const skillsDst = path.join(groupSessionsDir, 'skills');
  if (fs.existsSync(skillsDst)) {
    fs.rmSync(skillsDst, { recursive: true, force: true });
  }
  fs.mkdirSync(skillsDst, { recursive: true });

  const dstTessl = path.join(groupSessionsDir, '.tessl');
  if (fs.existsSync(dstTessl)) {
    fs.rmSync(dstTessl, { recursive: true, force: true });
  }

  const tilesToInstall = selectTiles(isMain, !!group.containerConfig?.trusted);

  const registryTiles = path.join(
    process.cwd(),
    'tessl-workspace',
    '.tessl',
    'tiles',
    TILE_OWNER,
  );
  const rulesContent: string[] = [];
  for (const tileName of tilesToInstall) {
    const tileSrc = path.join(registryTiles, tileName);
    if (!fs.existsSync(tileSrc)) {
      logger.warn(
        { tileName, path: tileSrc },
        'Tile not found — run tessl install in orchestrator',
      );
      continue;
    }

    const dstTileDir = path.join(dstTessl, 'tiles', TILE_OWNER, tileName);

    // Copy rules
    const rulesDir = path.join(tileSrc, 'rules');
    if (fs.existsSync(rulesDir)) {
      for (const ruleFile of fs.readdirSync(rulesDir)) {
        if (!ruleFile.endsWith('.md')) continue;
        const ruleSrcFile = path.join(rulesDir, ruleFile);
        const ruleDst = path.join(dstTileDir, 'rules', ruleFile);
        fs.mkdirSync(path.dirname(ruleDst), { recursive: true });
        fs.cpSync(ruleSrcFile, ruleDst);
        rulesContent.push(fs.readFileSync(ruleSrcFile, 'utf8'));
      }
    }

    // Copy skills and their scripts
    const tileSkillsDir = path.join(tileSrc, 'skills');
    if (fs.existsSync(tileSkillsDir)) {
      for (const skillDir of fs.readdirSync(tileSkillsDir)) {
        const skillSrcDir = path.join(tileSkillsDir, skillDir);
        if (!fs.statSync(skillSrcDir).isDirectory()) continue;
        fs.cpSync(skillSrcDir, path.join(dstTileDir, 'skills', skillDir), {
          recursive: true,
        });
        fs.cpSync(skillSrcDir, path.join(skillsDst, `tessl__${skillDir}`), {
          recursive: true,
        });
        // Copy bundled scripts to group's scripts/ dir (used by named host operations)
        const skillScriptsDir = path.join(skillSrcDir, 'scripts');
        if (fs.existsSync(skillScriptsDir)) {
          const groupScriptsDir = path.join(groupDir, 'scripts');
          fs.mkdirSync(groupScriptsDir, { recursive: true });
          for (const scriptFile of fs.readdirSync(skillScriptsDir)) {
            fs.cpSync(
              path.join(skillScriptsDir, scriptFile),
              path.join(groupScriptsDir, scriptFile),
            );
          }
        }
      }
    }
  }

  // Write aggregated RULES.md
  if (rulesContent.length > 0) {
    fs.mkdirSync(dstTessl, { recursive: true });
    fs.writeFileSync(
      path.join(dstTessl, 'RULES.md'),
      rulesContent.join('\n\n---\n\n'),
    );
  }

  // Copy .tessl/ to group folder so AGENTS.md → .tessl/RULES.md resolves.
  // Host-side copy is required because untrusted groups mount /workspace/group
  // read-only — the container cannot write .tessl/ there itself.
  // Skip if RULES.md content is unchanged (avoids unnecessary I/O on every spawn).
  const groupTesslDir = path.join(groupDir, '.tessl');
  if (fs.existsSync(dstTessl)) {
    const srcRules = path.join(dstTessl, 'RULES.md');
    const dstRules = path.join(groupTesslDir, 'RULES.md');
    const needsCopy =
      fs.existsSync(srcRules) &&
      (!fs.existsSync(dstRules) ||
        fs.readFileSync(srcRules, 'utf-8') !==
          fs.readFileSync(dstRules, 'utf-8'));
    if (needsCopy) {
      if (fs.existsSync(groupTesslDir)) {
        fs.rmSync(groupTesslDir, { recursive: true, force: true });
      }
      fs.cpSync(dstTessl, groupTesslDir, { recursive: true });
    }
  }

  // Built-in container skills (agent-browser, status, etc.)
  const builtinSkillsDir = path.join(process.cwd(), 'container', 'skills');
  if (fs.existsSync(builtinSkillsDir)) {
    for (const skillDir of fs.readdirSync(builtinSkillsDir)) {
      const srcDir = path.join(builtinSkillsDir, skillDir);
      if (!fs.statSync(srcDir).isDirectory()) continue;
      fs.cpSync(srcDir, path.join(skillsDst, skillDir), { recursive: true });
    }
  }

  // AyeAye-created skills (staging) — override tile skills if names collide
  const groupSkillsDir = path.join(groupDir, 'skills');
  if (fs.existsSync(groupSkillsDir)) {
    const stagingSkills = fs.readdirSync(groupSkillsDir).filter((d) => {
      const p = path.join(groupSkillsDir, d);
      return fs.statSync(p).isDirectory();
    });
    if (stagingSkills.length > 0) {
      logger.warn(
        { folder: group.folder, skills: stagingSkills },
        'Staging skills override tile skills — run verify-tiles to clear',
      );
      for (const skillDir of stagingSkills) {
        fs.cpSync(
          path.join(groupSkillsDir, skillDir),
          path.join(skillsDst, skillDir),
          { recursive: true },
        );
      }
    }
  }
  // Chown the .claude session dir so the container user (node) can write to it.
  // The SDK creates subdirs like session-env/ at runtime — without this, EACCES.
  const sessionUid = HOST_UID ?? 1000;
  const sessionGid = HOST_GID ?? 1000;
  if (sessionUid !== 0) {
    try {
      chownRecursive(groupSessionsDir, sessionUid, sessionGid);
    } catch (err: unknown) {
      logger.warn(
        { err, groupSessionsDir },
        'Failed to chown .claude session dir',
      );
    }
  }
  mounts.push({
    hostPath: toHostPath(groupSessionsDir),
    containerPath: '/home/node/.claude',
    readonly: false,
  });

  // Claude Code config file — lives at /home/node/.claude.json (outside .claude/).
  // Read-only rootfs can't create it, so we bind-mount it from the sessions dir.
  const claudeJsonPath = path.join(
    DATA_DIR,
    'sessions',
    group.folder,
    '.claude.json',
  );
  if (!fs.existsSync(claudeJsonPath)) {
    fs.writeFileSync(claudeJsonPath, '{}');
  }
  // Chown so container user can write (Claude Code updates this file at runtime)
  const jsonUid = HOST_UID ?? 1000;
  const jsonGid = HOST_GID ?? 1000;
  if (jsonUid !== 0) {
    try {
      fs.chownSync(claudeJsonPath, jsonUid, jsonGid);
    } catch (err: unknown) {
      logger.warn({ err, claudeJsonPath }, 'Failed to chown .claude.json');
    }
  }
  mounts.push({
    hostPath: toHostPath(claudeJsonPath),
    containerPath: '/home/node/.claude.json',
    readonly: false,
  });

  // Per-group IPC namespace
  const groupIpcDir = resolveGroupIpcPath(group.folder);
  const isTrustedIpc = isMain || !!group.containerConfig?.trusted;
  fs.mkdirSync(path.join(groupIpcDir, 'messages'), { recursive: true });
  fs.mkdirSync(path.join(groupIpcDir, 'input'), { recursive: true });
  if (isTrustedIpc) {
    fs.mkdirSync(path.join(groupIpcDir, 'tasks'), { recursive: true });
  }
  // Chown IPC dirs so container user can read/write/unlink files
  const ipcUid = HOST_UID ?? 1000;
  const ipcGid = HOST_GID ?? 1000;
  if (ipcUid !== 0) {
    try {
      const subsToChown = isTrustedIpc
        ? ['', 'messages', 'tasks', 'input']
        : ['messages', 'input'];
      for (const sub of subsToChown) {
        fs.chownSync(path.join(groupIpcDir, sub), ipcUid, ipcGid);
      }
    } catch (err) {
      logger.warn({ folder: group.folder, err }, 'Failed to chown IPC dirs');
    }
  }

  if (isTrustedIpc) {
    // Trusted/main: single mount for entire IPC directory
    mounts.push({
      hostPath: toHostPath(groupIpcDir),
      containerPath: '/workspace/ipc',
      readonly: false,
    });
  } else {
    // Untrusted: split mounts — messages/ writable, input/ read-only, no tasks/
    // No root IPC files (available_groups.json, current_tasks.json)
    mounts.push({
      hostPath: toHostPath(path.join(groupIpcDir, 'messages')),
      containerPath: '/workspace/ipc/messages',
      readonly: false,
    });
    mounts.push({
      hostPath: toHostPath(path.join(groupIpcDir, 'input')),
      containerPath: '/workspace/ipc/input',
      readonly: true,
    });
  }

  // Additional mounts validated against external allowlist
  if (group.containerConfig?.additionalMounts) {
    const validatedMounts = validateAdditionalMounts(
      group.containerConfig.additionalMounts,
      group.name,
      isMain,
    );
    mounts.push(...validatedMounts);
  }

  return mounts;
}

function buildContainerArgs(
  mounts: VolumeMount[],
  containerName: string,
  group: RegisteredGroup,
  isMain: boolean,
  replyToMessageId?: string,
  chatJid?: string,
): string[] {
  const args: string[] = ['run', '-i', '--rm', '--name', containerName];

  // Resource limits and filesystem restrictions for untrusted containers
  if (!isMain && !group.containerConfig?.trusted) {
    args.push(
      '--memory',
      '512m', // 512MB RAM hard limit
      '--memory-swap',
      '512m', // no swap
      '--cpus',
      '1', // 1 CPU core
      '--pids-limit',
      '256', // prevent fork bombs
      '--read-only', // immutable root filesystem
      '--tmpfs',
      '/tmp:size=64m', // writable /tmp via tmpfs (needed for input.json)
    );
    // Group folder is read-only for untrusted (set above).
    // Agent can read CLAUDE.md/skills but can't write 7GB of numbers.
  } else {
    // Trusted/main: cap memory to prevent host OOM when multiple containers
    // run in parallel. The NAS has 7.5GB RAM total; without a cap, multiple
    // Claude SDK processes can exhaust host memory and trigger kernel OOM
    // killer (SIGKILL exit 137). 1.5GB is plenty for Claude Code + skills.
    args.push(
      '--memory',
      '1536m', // 1.5GB RAM hard limit
      '--memory-swap',
      '2048m', // allow 512MB swap as buffer
    );
  }

  // Pass host timezone so container's local time matches the user's
  args.push('-e', `TZ=${TIMEZONE}`);

  // Credential tiers:
  //   Main/Trusted: Composio only (handles Gmail, Calendar, Tasks, GitHub via OAuth)
  //   Other:        nothing (Anthropic via proxy only)
  //
  // All other credentials (GITHUB_TOKEN, GOOGLE_*, OPENAI_*)
  // stay on the host. Scripts that need them run host-side via IPC.
  const isTrusted = group.containerConfig?.trusted === true;

  const CONTAINER_VARS = ['COMPOSIO_API_KEY'];

  const varsToForward = isMain || isTrusted ? CONTAINER_VARS : [];

  const envFromFile = readEnvFile(CONTAINER_VARS);
  for (const varName of varsToForward) {
    const value = process.env[varName] || envFromFile[varName];
    if (value) {
      args.push('-e', `${varName}=${value}`);
    }
  }

  // Pass chat JID so container scripts know which group they're in
  if (chatJid) {
    args.push('-e', `NANOCLAW_CHAT_JID=${chatJid}`);
  }

  // Pass reply-to message ID so the first IPC send_message appears as a Telegram reply
  if (replyToMessageId) {
    args.push('-e', `NANOCLAW_REPLY_TO_MESSAGE_ID=${replyToMessageId}`);
  }

  // Route API traffic through the credential proxy (containers never see real secrets)
  args.push(
    '-e',
    `ANTHROPIC_BASE_URL=http://${CONTAINER_HOST_GATEWAY}:${CREDENTIAL_PROXY_PORT}`,
  );

  // Mirror the host's auth method with a placeholder value.
  // API key mode: SDK sends x-api-key, proxy replaces with real key.
  // OAuth mode:   SDK exchanges placeholder token for temp API key,
  //               proxy injects real OAuth token on that exchange request.
  const authMode = detectAuthMode();
  if (authMode === 'api-key') {
    args.push('-e', 'ANTHROPIC_API_KEY=placeholder');
  } else {
    args.push('-e', 'CLAUDE_CODE_OAUTH_TOKEN=placeholder');
  }

  // Runtime-specific args for host gateway resolution
  args.push(...hostGatewayArgs());

  // Run as host user so bind-mounted files are accessible.
  // In DooD, process.getuid() returns the orchestrator container's uid (1000),
  // not the actual host user. HOST_UID/HOST_GID override this.
  const effectiveUid = HOST_UID ?? process.getuid?.();
  const effectiveGid = HOST_GID ?? process.getgid?.();
  if (effectiveUid != null && effectiveUid !== 0 && effectiveUid !== 1000) {
    args.push('--user', `${effectiveUid}:${effectiveGid}`);
    args.push('-e', 'HOME=/home/node');
  }

  for (const mount of mounts) {
    if (mount.readonly) {
      args.push(...readonlyMountArgs(mount.hostPath, mount.containerPath));
    } else {
      args.push('-v', `${mount.hostPath}:${mount.containerPath}`);
    }
  }

  args.push(CONTAINER_IMAGE);

  return args;
}

export async function runContainerAgent(
  group: RegisteredGroup,
  input: ContainerInput,
  onProcess: (proc: ChildProcess, containerName: string) => void,
  onOutput?: (output: ContainerOutput) => Promise<void>,
): Promise<ContainerOutput> {
  const startTime = Date.now();

  const groupDir = resolveGroupFolderPath(group.folder);
  fs.mkdirSync(groupDir, { recursive: true });

  // Clean up stale _reply_to file from previous container runs.
  // Scheduled tasks have no replyToMessageId — a leftover file would
  // cause the MCP server to quote a random old message.
  const replyToFile = path.join(
    resolveGroupIpcPath(group.folder),
    'input',
    '_reply_to',
  );
  try {
    fs.unlinkSync(replyToFile);
  } catch {
    /* file doesn't exist — fine */
  }

  const mounts = buildVolumeMounts(group, input.isMain, input.chatJid);
  const safeName = group.folder.replace(/[^a-zA-Z0-9-]/g, '-');
  const containerName = `nanoclaw-${safeName}-${Date.now()}`;
  const containerArgs = buildContainerArgs(
    mounts,
    containerName,
    group,
    input.isMain,
    input.replyToMessageId,
    input.chatJid,
  );

  logger.debug(
    {
      group: group.name,
      containerName,
      mounts: mounts.map(
        (m) =>
          `${m.hostPath} -> ${m.containerPath}${m.readonly ? ' (ro)' : ''}`,
      ),
      containerArgs: containerArgs.join(' '),
    },
    'Container mount configuration',
  );

  logger.info(
    {
      group: group.name,
      containerName,
      mountCount: mounts.length,
      isMain: input.isMain,
    },
    'Spawning container agent',
  );

  const logsDir = path.join(groupDir, 'logs');
  fs.mkdirSync(logsDir, { recursive: true });

  return new Promise((resolve) => {
    const container = spawn(CONTAINER_RUNTIME_BIN, containerArgs, {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    onProcess(container, containerName);

    let stdout = '';
    let stderr = '';
    let stdoutTruncated = false;
    let stderrTruncated = false;

    container.stdin.write(JSON.stringify(input));
    container.stdin.end();

    // Streaming output: parse OUTPUT_START/END marker pairs as they arrive
    let parseBuffer = '';
    let newSessionId: string | undefined;
    let outputChain = Promise.resolve();

    container.stdout.on('data', (data) => {
      const chunk = data.toString();

      // Always accumulate for logging
      if (!stdoutTruncated) {
        const remaining = CONTAINER_MAX_OUTPUT_SIZE - stdout.length;
        if (chunk.length > remaining) {
          stdout += chunk.slice(0, remaining);
          stdoutTruncated = true;
          logger.warn(
            { group: group.name, size: stdout.length },
            'Container stdout truncated due to size limit',
          );
        } else {
          stdout += chunk;
        }
      }

      // Stream-parse for output markers
      if (onOutput) {
        parseBuffer += chunk;
        let startIdx: number;
        while ((startIdx = parseBuffer.indexOf(OUTPUT_START_MARKER)) !== -1) {
          const endIdx = parseBuffer.indexOf(OUTPUT_END_MARKER, startIdx);
          if (endIdx === -1) break; // Incomplete pair, wait for more data

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
            // Activity detected — reset the hard timeout
            resetTimeout();
            // Call onOutput for all markers (including null results)
            // so idle timers start even for "silent" query completions.
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

    container.stderr.on('data', (data) => {
      const chunk = data.toString();
      const lines = chunk.trim().split('\n');
      for (const line of lines) {
        if (line) logger.debug({ container: group.folder }, line);
      }
      // Don't reset timeout on stderr — SDK writes debug logs continuously.
      // Timeout only resets on actual output (OUTPUT_MARKER in stdout).
      if (stderrTruncated) return;
      const remaining = CONTAINER_MAX_OUTPUT_SIZE - stderr.length;
      if (chunk.length > remaining) {
        stderr += chunk.slice(0, remaining);
        stderrTruncated = true;
        logger.warn(
          { group: group.name, size: stderr.length },
          'Container stderr truncated due to size limit',
        );
      } else {
        stderr += chunk;
      }
    });

    let timedOut = false;
    let hadStreamingOutput = false;
    // Untrusted containers get shorter timeout (5 min vs 30 min default)
    const UNTRUSTED_TIMEOUT = 300_000;
    const defaultTimeout =
      input.isMain || group.containerConfig?.trusted
        ? CONTAINER_TIMEOUT
        : UNTRUSTED_TIMEOUT;
    const configTimeout = group.containerConfig?.timeout || defaultTimeout;
    // Grace period: hard timeout must be at least IDLE_TIMEOUT + 30s so the
    // graceful _close sentinel has time to trigger before the hard kill fires.
    const timeoutMs = Math.max(configTimeout, IDLE_TIMEOUT + 30_000);

    const killOnTimeout = () => {
      timedOut = true;
      logger.error(
        { group: group.name, containerName },
        'Container timeout, stopping gracefully',
      );
      try {
        stopContainer(containerName);
      } catch (err) {
        logger.warn(
          { group: group.name, containerName, err },
          'Graceful stop failed, force killing',
        );
        container.kill('SIGKILL');
      }
    };

    let timeout = setTimeout(killOnTimeout, timeoutMs);

    // Reset the timeout whenever there's activity (streaming output)
    const resetTimeout = () => {
      clearTimeout(timeout);
      timeout = setTimeout(killOnTimeout, timeoutMs);
    };

    container.on('close', (code) => {
      clearTimeout(timeout);
      const duration = Date.now() - startTime;

      if (timedOut) {
        const ts = new Date().toISOString().replace(/[:.]/g, '-');
        const timeoutLog = path.join(logsDir, `container-${ts}.log`);
        fs.writeFileSync(
          timeoutLog,
          [
            `=== Container Run Log (TIMEOUT) ===`,
            `Timestamp: ${new Date().toISOString()}`,
            `Group: ${group.name}`,
            `Container: ${containerName}`,
            `Duration: ${duration}ms`,
            `Exit Code: ${code}`,
            `Had Streaming Output: ${hadStreamingOutput}`,
          ].join('\n'),
        );

        // Timeout after output = idle cleanup, not failure.
        // The agent already sent its response; this is just the
        // container being reaped after the idle period expired.
        if (hadStreamingOutput) {
          logger.info(
            { group: group.name, containerName, duration, code },
            'Container timed out after output (idle cleanup)',
          );
          outputChain.then(() => {
            resolve({
              status: 'success',
              result: null,
              newSessionId,
            });
          });
          return;
        }

        logger.error(
          { group: group.name, containerName, duration, code },
          'Container timed out with no output',
        );

        resolve({
          status: 'error',
          result: null,
          error: `Container timed out after ${configTimeout}ms`,
        });
        return;
      }

      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const logFile = path.join(logsDir, `container-${timestamp}.log`);
      const isVerbose =
        process.env.LOG_LEVEL === 'debug' || process.env.LOG_LEVEL === 'trace';

      const logLines = [
        `=== Container Run Log ===`,
        `Timestamp: ${new Date().toISOString()}`,
        `Group: ${group.name}`,
        `IsMain: ${input.isMain}`,
        `Duration: ${duration}ms`,
        `Exit Code: ${code}`,
        `Stdout Truncated: ${stdoutTruncated}`,
        `Stderr Truncated: ${stderrTruncated}`,
        ``,
      ];

      const isError = code !== 0;

      if (isVerbose || isError) {
        // On error, log input metadata only — not the full prompt.
        // Full input is only included at verbose level to avoid
        // persisting user conversation content on every non-zero exit.
        if (isVerbose) {
          logLines.push(`=== Input ===`, JSON.stringify(input, null, 2), ``);
        } else {
          logLines.push(
            `=== Input Summary ===`,
            `Prompt length: ${input.prompt.length} chars`,
            `Session ID: ${input.sessionId || 'new'}`,
            ``,
          );
        }
        logLines.push(
          `=== Container Args ===`,
          containerArgs.join(' '),
          ``,
          `=== Mounts ===`,
          mounts
            .map(
              (m) =>
                `${m.hostPath} -> ${m.containerPath}${m.readonly ? ' (ro)' : ''}`,
            )
            .join('\n'),
          ``,
          `=== Stderr${stderrTruncated ? ' (TRUNCATED)' : ''} ===`,
          stderr,
          ``,
          `=== Stdout${stdoutTruncated ? ' (TRUNCATED)' : ''} ===`,
          stdout,
        );
      } else {
        logLines.push(
          `=== Input Summary ===`,
          `Prompt length: ${input.prompt.length} chars`,
          `Session ID: ${input.sessionId || 'new'}`,
          ``,
          `=== Mounts ===`,
          mounts
            .map((m) => `${m.containerPath}${m.readonly ? ' (ro)' : ''}`)
            .join('\n'),
          ``,
        );
      }

      fs.writeFileSync(logFile, logLines.join('\n'));
      logger.debug({ logFile, verbose: isVerbose }, 'Container log written');

      if (code !== 0) {
        logger.error(
          {
            group: group.name,
            code,
            duration,
            stderr,
            stdout,
            logFile,
          },
          'Container exited with error',
        );

        resolve({
          status: 'error',
          result: null,
          error: `Container exited with code ${code}: ${stderr.slice(-200)}`,
        });
        return;
      }

      // Streaming mode: wait for output chain to settle, return completion marker
      if (onOutput) {
        outputChain.then(() => {
          logger.info(
            { group: group.name, duration, newSessionId },
            'Container completed (streaming mode)',
          );
          resolve({
            status: 'success',
            result: null,
            newSessionId,
          });
        });
        return;
      }

      // Legacy mode: parse the last output marker pair from accumulated stdout
      try {
        // Extract JSON between sentinel markers for robust parsing
        const startIdx = stdout.indexOf(OUTPUT_START_MARKER);
        const endIdx = stdout.indexOf(OUTPUT_END_MARKER);

        let jsonLine: string;
        if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
          jsonLine = stdout
            .slice(startIdx + OUTPUT_START_MARKER.length, endIdx)
            .trim();
        } else {
          // Fallback: last non-empty line (backwards compatibility)
          const lines = stdout.trim().split('\n');
          jsonLine = lines[lines.length - 1];
        }

        const output: ContainerOutput = JSON.parse(jsonLine);

        logger.info(
          {
            group: group.name,
            duration,
            status: output.status,
            hasResult: !!output.result,
          },
          'Container completed',
        );

        resolve(output);
      } catch (err) {
        logger.error(
          {
            group: group.name,
            stdout,
            stderr,
            error: err,
          },
          'Failed to parse container output',
        );

        resolve({
          status: 'error',
          result: null,
          error: `Failed to parse container output: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    });

    container.on('error', (err) => {
      clearTimeout(timeout);
      logger.error(
        { group: group.name, containerName, error: err },
        'Container spawn error',
      );
      resolve({
        status: 'error',
        result: null,
        error: `Container spawn error: ${err.message}`,
      });
    });
  });
}

export function writeTasksSnapshot(
  groupFolder: string,
  isMain: boolean,
  tasks: Array<{
    id: string;
    groupFolder: string;
    prompt: string;
    script?: string | null;
    schedule_type: string;
    schedule_value: string;
    status: string;
    next_run: string | null;
  }>,
  isTrusted?: boolean,
): void {
  // Untrusted containers don't get IPC root files — tasks/ not mounted
  if (!isMain && !isTrusted) return;

  // Write filtered tasks to the group's IPC directory
  const groupIpcDir = resolveGroupIpcPath(groupFolder);
  fs.mkdirSync(groupIpcDir, { recursive: true });

  // Main sees all tasks, others only see their own
  const filteredTasks = isMain
    ? tasks
    : tasks.filter((t) => t.groupFolder === groupFolder);

  const tasksFile = path.join(groupIpcDir, 'current_tasks.json');
  fs.writeFileSync(tasksFile, JSON.stringify(filteredTasks, null, 2));
}

export interface AvailableGroup {
  jid: string;
  name: string;
  lastActivity: string;
  isRegistered: boolean;
  containerConfig?: import('./types.js').RegisteredGroup['containerConfig'];
  requiresTrigger?: boolean;
}

/**
 * Write available groups snapshot for the container to read.
 * Only main group can see all available groups (for activation).
 * Non-main groups only see their own registration status.
 */
export function writeGroupsSnapshot(
  groupFolder: string,
  isMain: boolean,
  groups: AvailableGroup[],
  _registeredJids: Set<string>,
  isTrusted?: boolean,
): void {
  // Untrusted containers don't get IPC root files — available_groups not mounted
  if (!isMain && !isTrusted) return;

  const groupIpcDir = resolveGroupIpcPath(groupFolder);
  fs.mkdirSync(groupIpcDir, { recursive: true });

  // Main sees all groups; others see nothing (they can't activate groups)
  const visibleGroups = isMain ? groups : [];

  const groupsFile = path.join(groupIpcDir, 'available_groups.json');

  // Preserve JID-keyed entries that agents may have written
  let existing: Record<string, unknown> = {};
  if (fs.existsSync(groupsFile)) {
    try {
      existing = JSON.parse(fs.readFileSync(groupsFile, 'utf-8'));
    } catch {
      existing = {};
    }
  }

  fs.writeFileSync(
    groupsFile,
    JSON.stringify(
      {
        ...existing,
        groups: visibleGroups,
        lastSync: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
}
