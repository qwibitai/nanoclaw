/**
 * Container Runner for NanoClaw
 * Spawns agent execution in containers and handles IPC
 */
import { ChildProcess, exec, spawn } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  ATTACHMENTS_DIR,
  CONTAINER_IMAGE,
  CONTAINER_MAX_OUTPUT_SIZE,
  CONTAINER_TIMEOUT,
  DATA_DIR,
  GROUP_THREAD_KEY,
  GROUPS_DIR,
  IDLE_TIMEOUT,
  PLUGIN_DIR,
  RESIDENTIAL_PROXY_URL,
  TIMEZONE,
  WORKTREES_DIR,
  escapeRegex,
} from './config.js';
import { readEnvFile } from './env.js';
import {
  assertValidThreadId,
  resolveGroupFolderPath,
  resolveGroupIpcInputPath,
  resolveGroupIpcPath,
  resolveWorktreePath,
} from './group-folder.js';
import { logger } from './logger.js';
import {
  CONTAINER_HOST_GATEWAY,
  CONTAINER_RUNTIME_BIN,
  hostGatewayArgs,
  readonlyMountArgs,
  stopContainer,
} from './container-runtime.js';
import { validateAdditionalMounts } from './mount-security.js';
import { RegisteredGroup } from './types.js';
import YAML from 'yaml';

// Sentinel markers for robust output parsing (must match agent-runner)
const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';
const PROGRESS_START_MARKER = '---NANOCLAW_PROGRESS_START---';
const PROGRESS_END_MARKER = '---NANOCLAW_PROGRESS_END---';

// Path to Claude Code's host credentials (contains MCP OAuth tokens)
const HOST_CREDENTIALS_PATH = path.join(
  os.homedir(),
  '.claude',
  '.credentials.json',
);

const GRANOLA_TOKEN_ENDPOINT = 'https://mcp-auth.granola.ai/oauth2/token';
const GRANOLA_REFRESH_TIMEOUT_MS = 10_000;
// Proactive refresh interval — keeps the refresh token chain alive even when
// no container spawns occur. 4 hours is well within the ~6h access token TTL.
const GRANOLA_PROACTIVE_REFRESH_MS = 4 * 60 * 60 * 1000;

// In-memory cache to avoid redundant disk reads / duplicate refresh calls
let granolaTokenCache: { token: string; expiresAt: number } | null = null;
let granolaRefreshTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Read Granola MCP OAuth access token from the host's Claude credentials file,
 * refresh if expired. Returns the access token string or null.
 */
async function getGranolaAccessToken(): Promise<string | null> {
  if (granolaTokenCache && Date.now() < granolaTokenCache.expiresAt) {
    return granolaTokenCache.token;
  }

  let creds: Record<string, unknown>;
  try {
    creds = JSON.parse(fs.readFileSync(HOST_CREDENTIALS_PATH, 'utf-8'));
  } catch {
    return null;
  }

  const mcpOAuth = creds.mcpOAuth as
    | Record<string, Record<string, unknown>>
    | undefined;
  if (!mcpOAuth) return null;

  const granolaKey = Object.keys(mcpOAuth).find((k) =>
    k.startsWith('granola|'),
  );
  if (!granolaKey) return null;

  const entry = mcpOAuth[granolaKey];
  const expiresAt = entry.expiresAt as number;
  const accessToken = entry.accessToken as string | undefined;
  const refreshToken = entry.refreshToken as string | undefined;
  const clientId = entry.clientId as string | undefined;

  // Token still valid (with 5-minute buffer)
  if (expiresAt && Date.now() < expiresAt - 5 * 60 * 1000 && accessToken) {
    granolaTokenCache = {
      token: accessToken,
      expiresAt: expiresAt - 5 * 60 * 1000,
    };
    return accessToken;
  }

  // Token expired — try to refresh
  if (!refreshToken || !clientId) {
    logger.error(
      'Granola OAuth token expired and no refresh token available. Re-authenticate: claude mcp add granola --transport http https://mcp.granola.ai/mcp',
    );
    return null;
  }

  try {
    logger.info('Refreshing Granola OAuth token...');
    const resp = await fetch(GRANOLA_TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: clientId,
        refresh_token: refreshToken,
      }),
      signal: AbortSignal.timeout(GRANOLA_REFRESH_TIMEOUT_MS),
    });

    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      logger.error(
        `Granola token refresh failed: ${resp.status} ${resp.statusText} — ${body}. Re-authenticate: claude mcp add granola --transport http https://mcp.granola.ai/mcp`,
      );
      // Don't pass the expired token — it causes silent MCP tool failures
      return null;
    }

    const tokens = (await resp.json()) as Record<string, unknown>;
    const expiresIn = ((tokens.expires_in as number) || 3600) * 1000;
    const newAccessToken = tokens.access_token as string;
    const newExpiresAt = Date.now() + expiresIn;

    // Persist refreshed tokens back to host credentials — re-read to minimize race window
    try {
      const freshCreds = JSON.parse(
        fs.readFileSync(HOST_CREDENTIALS_PATH, 'utf-8'),
      ) as Record<string, unknown>;
      const freshOAuth = (freshCreds.mcpOAuth || {}) as Record<
        string,
        Record<string, unknown>
      >;
      freshOAuth[granolaKey] = {
        ...entry,
        accessToken: newAccessToken,
        expiresAt: newExpiresAt,
        ...(tokens.refresh_token ? { refreshToken: tokens.refresh_token } : {}),
      };
      freshCreds.mcpOAuth = freshOAuth;
      fs.writeFileSync(
        HOST_CREDENTIALS_PATH,
        JSON.stringify(freshCreds, null, 4) + '\n',
      );
    } catch (writeErr) {
      logger.warn(`Failed to persist refreshed Granola token: ${writeErr}`);
    }

    granolaTokenCache = {
      token: newAccessToken,
      expiresAt: newExpiresAt - 5 * 60 * 1000,
    };
    logger.info('Granola OAuth token refreshed successfully');
    return newAccessToken;
  } catch (err) {
    logger.error(
      `Granola token refresh error: ${err}. Re-authenticate: claude mcp add granola --transport http https://mcp.granola.ai/mcp`,
    );
    return null;
  }
}

/**
 * Start a proactive refresh timer that keeps the Granola OAuth token chain alive.
 * Runs immediately on start (to refresh on boot if stale), then every 4 hours.
 * This prevents the refresh token from expiring during overnight / idle periods.
 */
export function startGranolaTokenRefresh(): void {
  if (granolaRefreshTimer) return; // already running
  const doRefresh = async () => {
    const token = await getGranolaAccessToken();
    if (token) {
      logger.debug('Granola proactive token refresh: OK');
    }
    // Errors are already logged inside getGranolaAccessToken
  };
  // Refresh immediately, then on interval
  doRefresh();
  granolaRefreshTimer = setInterval(doRefresh, GRANOLA_PROACTIVE_REFRESH_MS);
  granolaRefreshTimer.unref(); // don't keep the process alive just for this
  logger.info(
    `Granola proactive token refresh started (every ${GRANOLA_PROACTIVE_REFRESH_MS / 1000 / 60 / 60}h)`,
  );
}

export function stopGranolaTokenRefresh(): void {
  if (granolaRefreshTimer) {
    clearInterval(granolaRefreshTimer);
    granolaRefreshTimer = null;
  }
}

export interface ContainerAttachment {
  filename: string;
  mimeType: string;
  containerPath: string; // e.g. /workspace/attachments/{msgId}/photo.png
  messageId: string; // links attachment to specific message for correct ordering
}

export interface ContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  threadId?: string;
  assistantName?: string;
  model?: string;
  effort?: string;
  secrets?: Record<string, string>;
  tools?: string[];
  attachments?: ContainerAttachment[];
}

export interface ContainerOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  error?: string;
  errorType?: 'prompt_too_long' | 'general';
  /** True when the agent is idle and waiting for new input.
   *  Only set on the between-query session-update marker.
   *  Intermediate results within a multi-turn query do NOT carry this flag. */
  idle?: boolean;
}

export interface ProgressEvent {
  eventType: 'text' | 'tool_use' | 'thinking' | 'system';
  data: Record<string, string | undefined>;
  seq: number;
  ts: number;
}

interface VolumeMount {
  hostPath: string;
  containerPath: string;
  readonly: boolean;
}

/**
 * Check if a tool is enabled in the group's tool config.
 * Supports scoped tool names (e.g., 'gmail:sunday' matches 'gmail').
 * Returns true if tools is undefined (all tools enabled).
 */
function isToolEnabled(tools: string[] | undefined, name: string): boolean {
  if (!tools) return true;
  return tools.some((t) => t === name || t.startsWith(name + ':'));
}

/**
 * Extract scoped access entries from tools array (e.g. 'gmail:illysium' → ['illysium']).
 * Returns scopes and whether the tool is scope-restricted (no bare entry like 'gmail').
 */
function extractToolScopes(
  tools: string[] | undefined,
  toolName: string,
): { scopes: string[]; isScoped: boolean } {
  const scopes =
    tools
      ?.filter((t) => t.startsWith(`${toolName}:`))
      .map((t) => t.split(':')[1]) ?? [];
  return {
    scopes,
    isScoped: scopes.length > 0 && !tools?.includes(toolName),
  };
}

// Per-group mutex for serializing worktree creation (git locks .git/worktrees/)
const worktreeMutex = new Map<string, Promise<void>>();

export function withGroupMutex<T>(
  groupFolder: string,
  fn: () => Promise<T>,
): Promise<T> {
  const prev = worktreeMutex.get(groupFolder) || Promise.resolve();
  const next = prev.then(fn, fn);
  worktreeMutex.set(
    groupFolder,
    next.then(
      () => {},
      () => {},
    ),
  );
  return next;
}

function execAsync(cmd: string, options?: { cwd?: string }): Promise<string> {
  return new Promise((resolve, reject) => {
    exec(cmd, { timeout: 30_000, ...options }, (err, stdout, stderr) => {
      if (err) reject(new Error(`${cmd}: ${stderr || err.message}`));
      else resolve(stdout.trim());
    });
  });
}

/** Find subdirectories that are git worktrees (contain a `.git` file, not directory). */
function findGitWorktrees(
  dir: string,
): Array<{ name: string; wtPath: string }> {
  const results: Array<{ name: string; wtPath: string }> = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const wtPath = path.join(dir, entry.name);
    try {
      if (fs.statSync(path.join(wtPath, '.git')).isFile()) {
        results.push({ name: entry.name, wtPath });
      }
    } catch {
      /* .git doesn't exist — not a worktree */
    }
  }
  return results;
}

/**
 * Rescue uncommitted or unpushed work from a worktree before it's removed.
 * Creates a rescue branch and pushes it to origin so no work is lost.
 * Best-effort — failures are logged but never prevent cleanup.
 */
async function rescueWorktreeChanges(
  wtPath: string,
  groupFolder: string,
  threadId?: string,
): Promise<void> {
  const repoName = path.basename(wtPath);
  try {
    // Check for uncommitted changes
    const status = await execAsync('git status --porcelain', { cwd: wtPath });

    if (status) {
      // Stage and commit everything
      await execAsync('git add -A', { cwd: wtPath });
      await execAsync(
        'git commit -m "rescue: auto-save uncommitted work before worktree cleanup"',
        { cwd: wtPath },
      );
    }

    // Skip repos without a remote (nothing to push to)
    const remoteOutput = await execAsync('git remote', { cwd: wtPath });
    if (!remoteOutput) return;

    // Check if current HEAD has commits not on any remote branch
    const unpushed = await execAsync('git log --oneline HEAD --not --remotes', {
      cwd: wtPath,
    });
    if (!unpushed) return;

    // Push HEAD to a rescue branch without changing local branch pointer
    const timestamp = new Date()
      .toISOString()
      .replace(/[:.]/g, '-')
      .slice(0, 19);
    const threadSuffix = threadId
      ? `/${threadId.slice(0, 12).replace(/[^a-zA-Z0-9_-]/g, '_')}`
      : '';
    const safeFolderName = groupFolder.replace(/[^a-zA-Z0-9_-]/g, '_');
    const branchName = `rescue/${safeFolderName}${threadSuffix}/${timestamp}`;

    await execAsync(`git push origin HEAD:refs/heads/${branchName}`, {
      cwd: wtPath,
    });

    logger.info(
      { group: groupFolder, threadId, repo: repoName, branch: branchName },
      'Rescued unpushed worktree changes to remote branch',
    );
  } catch (err) {
    logger.warn(
      { group: groupFolder, threadId, repo: repoName, err },
      'Failed to rescue worktree changes (work may be lost)',
    );
  }
}

/** Remove a git worktree with fallback to rm + prune. Best-effort, never throws. */
async function removeWorktree(repoDir: string, wtPath: string): Promise<void> {
  try {
    await execAsync(`git worktree remove --force "${wtPath}"`, {
      cwd: repoDir,
    });
  } catch {
    try {
      fs.rmSync(wtPath, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
    try {
      await execAsync('git worktree prune', { cwd: repoDir });
    } catch {
      /* ignore */
    }
  }
}

// Cache repos that have had gc.auto disabled (avoids redundant git config writes)
const gcDisabledRepos = new Set<string>();

/**
 * Prepare a per-thread worktree workspace for concurrent container access.
 * Creates git worktrees for repos, copies CLAUDE.md/conversations, symlinks others.
 * Returns the worktree base path to mount as /workspace/group.
 *
 * MUST be called inside withGroupMutex() to prevent concurrent git worktree add
 * on the same repos (git locks .git/worktrees/).
 */
export async function prepareThreadWorkspace(
  groupFolder: string,
  threadId: string,
): Promise<string> {
  assertValidThreadId(threadId);
  const groupDir = resolveGroupFolderPath(groupFolder);
  const worktreeBase = resolveWorktreePath(groupFolder, threadId);

  fs.mkdirSync(worktreeBase, { recursive: true });

  const createdWorktrees: Array<{ repoDir: string; wtPath: string }> = [];

  try {
    const entries = fs.readdirSync(groupDir, { withFileTypes: true });
    const gitRepos: Array<{ srcPath: string; wtPath: string }> = [];

    for (const entry of entries) {
      const srcPath = path.join(groupDir, entry.name);

      if (entry.isDirectory()) {
        const gitDir = path.join(srcPath, '.git');
        if (fs.existsSync(gitDir)) {
          gitRepos.push({
            srcPath,
            wtPath: path.join(worktreeBase, entry.name),
          });
        } else if (entry.name === 'conversations' || entry.name === 'threads') {
          // Copy directories that get written to concurrently
          const dstPath = path.join(worktreeBase, entry.name);
          fs.cpSync(srcPath, dstPath, { recursive: true });
        } else {
          // Symlink other directories (logs, etc.)
          const dstPath = path.join(worktreeBase, entry.name);
          if (!fs.existsSync(dstPath)) {
            fs.symlinkSync(srcPath, dstPath);
          }
        }
      } else if (entry.isFile()) {
        if (entry.name === 'CLAUDE.md') {
          fs.copyFileSync(srcPath, path.join(worktreeBase, entry.name));
        } else {
          const dstPath = path.join(worktreeBase, entry.name);
          if (!fs.existsSync(dstPath)) {
            fs.symlinkSync(srcPath, dstPath);
          }
        }
      }
    }

    // Create git worktrees in parallel (independent repos, safe within mutex)
    await Promise.all(
      gitRepos.map(async ({ srcPath, wtPath }) => {
        if (!gcDisabledRepos.has(srcPath)) {
          await execAsync('git config gc.auto 0', { cwd: srcPath });
          gcDisabledRepos.add(srcPath);
        }
        // Fetch latest from remote so worktree isn't based on stale local HEAD
        try {
          await execAsync('git fetch origin', { cwd: srcPath });
        } catch {
          // Offline or no remote — fall through to local HEAD
        }
        // Use remote default branch if available, otherwise local HEAD
        let ref = 'HEAD';
        try {
          ref = await execAsync('git symbolic-ref refs/remotes/origin/HEAD', {
            cwd: srcPath,
          }); // e.g. refs/remotes/origin/main
        } catch {
          // origin/HEAD not set — use local HEAD
        }
        try {
          await execAsync(`git worktree add --detach "${wtPath}" "${ref}"`, {
            cwd: srcPath,
          });
        } catch (addErr) {
          // Stale worktree registration — prune and retry once
          const msg = addErr instanceof Error ? addErr.message : String(addErr);
          if (msg.includes('already registered')) {
            logger.warn(
              { repo: path.basename(srcPath), wtPath },
              'Stale worktree detected, pruning and retrying',
            );
            await execAsync('git worktree prune', { cwd: srcPath });
            // Clean up leftover directory if it exists
            try {
              fs.rmSync(wtPath, { recursive: true, force: true });
            } catch {
              /* ignore */
            }
            await execAsync(`git worktree add --detach "${wtPath}" "${ref}"`, {
              cwd: srcPath,
            });
          } else {
            throw addErr;
          }
        }
        createdWorktrees.push({ repoDir: srcPath, wtPath });
      }),
    );
  } catch (err) {
    // Rollback: clean up any created worktrees
    await Promise.all(
      createdWorktrees.map(({ repoDir, wtPath }) =>
        removeWorktree(repoDir, wtPath),
      ),
    );
    try {
      fs.rmSync(worktreeBase, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
    throw err;
  }

  return worktreeBase;
}

/**
 * Clean up a per-thread worktree workspace.
 * Removes git worktrees, merges CLAUDE.md changes back, removes directory.
 */
export async function cleanupThreadWorkspace(
  groupFolder: string,
  threadId: string,
): Promise<void> {
  const groupDir = resolveGroupFolderPath(groupFolder);
  const worktreeBase = resolveWorktreePath(groupFolder, threadId);

  if (!fs.existsSync(worktreeBase)) return;

  // Merge CLAUDE.md changes back (last-write-wins for the entire file)
  const wtClaudeMd = path.join(worktreeBase, 'CLAUDE.md');
  const mainClaudeMd = path.join(groupDir, 'CLAUDE.md');
  if (fs.existsSync(wtClaudeMd)) {
    try {
      const wtContent = fs.readFileSync(wtClaudeMd, 'utf-8');
      const mainContent = fs.existsSync(mainClaudeMd)
        ? fs.readFileSync(mainClaudeMd, 'utf-8')
        : '';
      // Only overwrite if worktree version has new content
      if (wtContent !== mainContent && wtContent.length >= mainContent.length) {
        fs.writeFileSync(mainClaudeMd, wtContent);
      }
    } catch {
      // best-effort merge
    }
  }

  // Rescue unpushed work, then remove git worktrees
  try {
    const gitWorktrees = findGitWorktrees(worktreeBase);

    // Rescue phase: independent repos, safe to parallelize
    await Promise.all(
      gitWorktrees.map(({ wtPath }) =>
        rescueWorktreeChanges(wtPath, groupFolder, threadId),
      ),
    );

    // Removal phase
    await Promise.all(
      gitWorktrees.map(({ name, wtPath }) =>
        removeWorktree(path.join(groupDir, name), wtPath),
      ),
    );
  } catch {
    // ignore readdir errors
  }

  // Remove worktree directory
  try {
    fs.rmSync(worktreeBase, { recursive: true, force: true });
  } catch {
    // best-effort
  }
}

/** Namespace for additional-mount worktrees (cannot collide with group folder names) */
const MOUNT_WORKTREES_DIR = '__mounts__';

/**
 * Create a detached git worktree for an additionalMount.
 * Isolates the container's git operations from the host working tree.
 *
 * MUST be called inside withGroupMutex() keyed on repoDir to prevent
 * concurrent git worktree add on the same repo.
 */
async function prepareAdditionalMountWorktree(
  repoDir: string,
  sessionId: string,
  containerBasename: string,
): Promise<string> {
  const clonePath = path.join(
    WORKTREES_DIR,
    MOUNT_WORKTREES_DIR,
    sessionId,
    containerBasename,
  );

  // Fetch latest from the source repo's remote before cloning
  try {
    await execAsync('git fetch origin', { cwd: repoDir });
  } catch {
    // Offline or no remote — clone from whatever the local repo has
  }

  // Use git clone (not git worktree add) because worktrees create a .git
  // file pointing back to the parent repo's .git directory. Only the worktree
  // is mounted in the container, so that reference is broken. A local clone
  // is self-contained and works in any mount context.
  await execAsync(
    `git clone --local --no-checkout "${repoDir}" "${clonePath}"`,
  );

  // Repoint origin to the real remote (GitHub) so the container can push.
  // The clone's origin defaults to the local repo path, which isn't useful
  // inside the container.
  try {
    const remoteUrl = await execAsync('git remote get-url origin', {
      cwd: repoDir,
    });
    if (remoteUrl) {
      await execAsync(`git remote set-url origin "${remoteUrl}"`, {
        cwd: clonePath,
      });
    }
  } catch {
    // No remote configured on source repo
  }

  // Checkout the default branch (origin/main)
  let ref = 'origin/HEAD';
  try {
    await execAsync('git symbolic-ref refs/remotes/origin/HEAD', {
      cwd: clonePath,
    });
  } catch {
    // origin/HEAD not set — try origin/main, then just HEAD
    try {
      await execAsync('git rev-parse --verify origin/main', {
        cwd: clonePath,
      });
      ref = 'origin/main';
    } catch {
      ref = 'HEAD';
    }
  }

  await execAsync(`git checkout "${ref}"`, { cwd: clonePath });

  return clonePath;
}

/** Clean up additional-mount clones created for a container session. */
async function cleanupAdditionalMountWorktrees(
  sessionId: string,
  _mountWorktrees: Array<{ repoDir: string; wtPath: string }>,
): Promise<void> {
  // Clones are self-contained — just remove the session directory.
  // No git worktree prune needed (unlike real worktrees).
  const sessionDir = path.join(WORKTREES_DIR, MOUNT_WORKTREES_DIR, sessionId);
  try {
    fs.rmSync(sessionDir, { recursive: true, force: true });
  } catch {
    // best-effort
  }
}

/**
 * Startup cleanup: prune orphan worktrees from all groups.
 */
export async function cleanupOrphanWorktrees(): Promise<void> {
  if (!fs.existsSync(WORKTREES_DIR)) return;

  let cleaned = 0;
  try {
    const groupFolders = fs.readdirSync(WORKTREES_DIR);
    for (const gf of groupFolders) {
      const gfPath = path.join(WORKTREES_DIR, gf);
      if (!fs.statSync(gfPath).isDirectory()) continue;

      // Additional-mount worktrees are handled separately
      if (gf === MOUNT_WORKTREES_DIR) continue;

      // Prune git's internal worktree metadata for each repo in the group
      const groupDir = path.join(GROUPS_DIR, gf);
      if (fs.existsSync(groupDir)) {
        const entries = fs.readdirSync(groupDir, { withFileTypes: true });
        const pruneOps = entries
          .filter(
            (e) =>
              e.isDirectory() &&
              fs.existsSync(path.join(groupDir, e.name, '.git')),
          )
          .map((e) =>
            execAsync('git worktree prune', {
              cwd: path.join(groupDir, e.name),
            }).catch(() => {}),
          );
        await Promise.all(pruneOps);
      }

      // Rescue unpushed work from orphan worktrees, then remove them
      const threadDirs = fs.readdirSync(gfPath);
      for (const td of threadDirs) {
        const tdPath = path.join(gfPath, td);
        if (!fs.statSync(tdPath).isDirectory()) continue;

        // Rescue unpushed work from git worktrees inside this thread dir
        try {
          const worktrees = findGitWorktrees(tdPath);
          await Promise.all(
            worktrees.map(({ wtPath }) =>
              rescueWorktreeChanges(wtPath, gf, td),
            ),
          );
        } catch {
          /* best-effort rescue */
        }

        try {
          fs.rmSync(tdPath, { recursive: true, force: true });
          cleaned++;
        } catch {
          /* ignore */
        }
      }

      // Remove empty group worktree dir
      try {
        fs.rmdirSync(gfPath);
      } catch {
        /* not empty or already removed */
      }
    }

    // Clean up orphan additional-mount clones (self-contained, just rm)
    const mountsDir = path.join(WORKTREES_DIR, MOUNT_WORKTREES_DIR);
    if (fs.existsSync(mountsDir)) {
      for (const sessionDir of fs.readdirSync(mountsDir)) {
        const sessionPath = path.join(mountsDir, sessionDir);
        if (!fs.statSync(sessionPath).isDirectory()) continue;
        try {
          fs.rmSync(sessionPath, { recursive: true, force: true });
          cleaned++;
        } catch {
          /* ignore */
        }
      }

      try {
        fs.rmdirSync(mountsDir);
      } catch {
        /* not empty */
      }
    }
  } catch (err) {
    logger.warn({ err }, 'Error during orphan worktree cleanup');
  }

  if (cleaned > 0) {
    logger.info({ cleaned }, 'Cleaned up orphan worktrees');
  }
}

function buildVolumeMounts(
  group: RegisteredGroup,
  isMain: boolean,
  threadId?: string,
  worktreePath?: string,
  preValidatedAdditionalMounts?: Array<{
    hostPath: string;
    containerPath: string;
    readonly: boolean;
  }>,
): VolumeMount[] {
  const mounts: VolumeMount[] = [];
  const projectRoot = process.cwd();
  const homeDir = os.homedir();
  const groupDir = resolveGroupFolderPath(group.folder);

  // Mount group folder: use worktree path if provided (per-thread isolation),
  // otherwise mount the main group folder directly.
  const effectiveGroupDir = worktreePath || groupDir;

  if (isMain) {
    mounts.push({
      hostPath: projectRoot,
      containerPath: '/workspace/project',
      readonly: true,
    });

    // Shadow .env so the agent cannot read secrets from the mounted project root.
    // Credentials are passed via stdin pipe, never exposed to containers.
    const envFile = path.join(projectRoot, '.env');
    if (fs.existsSync(envFile)) {
      mounts.push({
        hostPath: '/dev/null',
        containerPath: '/workspace/project/.env',
        readonly: true,
      });
    }

    mounts.push({
      hostPath: effectiveGroupDir,
      containerPath: '/workspace/group',
      readonly: false,
    });
  } else {
    mounts.push({
      hostPath: effectiveGroupDir,
      containerPath: '/workspace/group',
      readonly: false,
    });

    // Mount global context directory unless explicitly disabled (shared/multi-tenant groups).
    // When globalContext is false, the container has zero visibility into other projects.
    if (group.containerConfig?.globalContext !== false) {
      const globalDir = path.join(GROUPS_DIR, 'global');
      if (fs.existsSync(globalDir)) {
        mounts.push({
          hostPath: globalDir,
          containerPath: '/workspace/global',
          readonly: true,
        });
      }
    }
  }

  // Thread workspace: mount thread-specific directory for thread sessions.
  // Always use the main group dir for threads (not the worktree) since
  // thread data is per-thread scoped, not per-repo.
  if (threadId) {
    const threadDir = path.join(groupDir, 'threads', threadId);
    fs.mkdirSync(threadDir, { recursive: true });
    mounts.push({
      hostPath: threadDir,
      containerPath: '/workspace/thread',
      readonly: false,
    });
  }

  // Per-group Claude sessions directory (isolated from other groups)
  // Each group gets their own .claude/ to prevent cross-group session access.
  // Thread sessions get their own subdirectory under the group.
  const groupSessionsDir = threadId
    ? path.join(
        DATA_DIR,
        'sessions',
        group.folder,
        'threads',
        threadId,
        '.claude',
      )
    : path.join(DATA_DIR, 'sessions', group.folder, '.claude');
  fs.mkdirSync(groupSessionsDir, { recursive: true });
  fs.mkdirSync(path.join(groupSessionsDir, 'debug'), { recursive: true });
  const settingsFile = path.join(groupSessionsDir, 'settings.json');
  const requiredEnv: Record<string, string> = {
    // Enable agent swarms (subagent orchestration)
    CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
    // Load CLAUDE.md from additional mounted directories
    CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: '1',
    // Enable Claude's memory feature (persists user preferences between sessions)
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: '0',
    // Always use high effort (maximum reasoning depth)
    CLAUDE_CODE_EFFORT_LEVEL: 'high',
  };
  const requiredSettings: Record<string, unknown> = {
    // Disable "generated by Claude Code" attribution on commits and PRs
    includeCoAuthoredBy: false,
    attribution: { commit: '', pr: '' },
  };
  if (!fs.existsSync(settingsFile)) {
    fs.writeFileSync(
      settingsFile,
      JSON.stringify({ env: requiredEnv, ...requiredSettings }, null, 2) + '\n',
    );
  } else {
    // Ensure required env vars and settings are present in existing settings
    try {
      const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf-8'));
      let changed = false;
      if (!settings.env) settings.env = {};
      for (const [key, value] of Object.entries(requiredEnv)) {
        if (settings.env[key] !== value) {
          settings.env[key] = value;
          changed = true;
        }
      }
      for (const [key, value] of Object.entries(requiredSettings)) {
        if (JSON.stringify(settings[key]) !== JSON.stringify(value)) {
          settings[key] = value;
          changed = true;
        }
      }
      if (changed) {
        fs.writeFileSync(
          settingsFile,
          JSON.stringify(settings, null, 2) + '\n',
        );
      }
    } catch {
      // If settings file is corrupted, recreate it
      fs.writeFileSync(
        settingsFile,
        JSON.stringify({ env: requiredEnv, ...requiredSettings }, null, 2) + '\n',
      );
    }
  }

  // Write .mcp.json — only include tools allowed by group config
  const tools = group.containerConfig?.tools;
  const mcpJsonPath = path.join(groupSessionsDir, '.mcp.json');
  const mcpServers: Record<string, unknown> = {};
  if (isToolEnabled(tools, 'exa')) {
    mcpServers.exa = {
      type: 'http',
      url: 'https://mcp.exa.ai/mcp?tools=web_search_exa,web_search_advanced_exa,get_code_context_exa,crawling_exa,company_research_exa,people_search_exa,deep_researcher_start,deep_researcher_check,deep_search_exa',
    };
  }
  fs.writeFileSync(mcpJsonPath, JSON.stringify({ mcpServers }, null, 2) + '\n');

  // Sync skills from container/skills/ into each group's .claude/skills/
  const skillsSrc = path.join(process.cwd(), 'container', 'skills');
  const skillsDst = path.join(groupSessionsDir, 'skills');
  if (fs.existsSync(skillsSrc)) {
    for (const skillDir of fs.readdirSync(skillsSrc)) {
      const srcDir = path.join(skillsSrc, skillDir);
      if (!fs.statSync(srcDir).isDirectory()) continue;
      const dstDir = path.join(skillsDst, skillDir);
      fs.cpSync(srcDir, dstDir, { recursive: true });
    }
  }

  // Sync skills, agents, and hooks from external plugin (e.g. davekim917/bootstrap)
  if (fs.existsSync(PLUGIN_DIR)) {
    // Skills: plugin has skills/{category}/{skill-name}/SKILL.md — flatten into .claude/skills/
    const pluginSkillsDir = path.join(PLUGIN_DIR, 'skills');
    if (fs.existsSync(pluginSkillsDir)) {
      for (const category of fs.readdirSync(pluginSkillsDir)) {
        const categoryDir = path.join(pluginSkillsDir, category);
        if (!fs.statSync(categoryDir).isDirectory()) continue;
        for (const skill of fs.readdirSync(categoryDir)) {
          const skillSrc = path.join(categoryDir, skill);
          if (!fs.statSync(skillSrc).isDirectory()) continue;
          // Skip non-skill directories (e.g. 'shared')
          if (!fs.existsSync(path.join(skillSrc, 'SKILL.md'))) continue;
          fs.cpSync(skillSrc, path.join(skillsDst, skill), {
            recursive: true,
          });
        }
      }
    }

    // Agents: plugin has agents/*.md — sync into .claude/agents/
    const pluginAgentsDir = path.join(PLUGIN_DIR, 'agents');
    if (fs.existsSync(pluginAgentsDir)) {
      const agentsDst = path.join(groupSessionsDir, 'agents');
      fs.mkdirSync(agentsDst, { recursive: true });
      for (const agentFile of fs.readdirSync(pluginAgentsDir)) {
        if (!agentFile.endsWith('.md')) continue;
        fs.copyFileSync(
          path.join(pluginAgentsDir, agentFile),
          path.join(agentsDst, agentFile),
        );
      }
    }

    // Hooks: merge plugin hooks.json into settings.json so Claude Code
    // loads them via settingSources: ['user']. Also set CLAUDE_PLUGIN_ROOT
    // so ${CLAUDE_PLUGIN_ROOT} references in hook commands resolve correctly.
    const pluginHooksJson = path.join(PLUGIN_DIR, 'hooks', 'hooks.json');
    if (fs.existsSync(pluginHooksJson)) {
      try {
        const pluginHooks = JSON.parse(
          fs.readFileSync(pluginHooksJson, 'utf-8'),
        );
        const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf-8'));
        settings.hooks = pluginHooks;
        fs.writeFileSync(
          settingsFile,
          JSON.stringify(settings, null, 2) + '\n',
        );
      } catch (err) {
        logger.warn(
          { error: err, path: pluginHooksJson },
          'Failed to merge plugin hooks into settings',
        );
      }
    }

    // Mount plugin directory read-only so hook scripts can execute inside container
    mounts.push({
      hostPath: PLUGIN_DIR,
      containerPath: '/workspace/plugin',
      readonly: true,
    });
  }
  mounts.push({
    hostPath: groupSessionsDir,
    containerPath: '/home/node/.claude',
    readonly: false,
  });

  // Gmail credentials — gated by tools config ('gmail', 'gmail:<account>', or 'gmail-readonly:<account>')
  if (isToolEnabled(tools, 'gmail') || isToolEnabled(tools, 'gmail-readonly')) {
    const gmailScopes = extractToolScopes(tools, 'gmail');
    const readonlyScopes = extractToolScopes(tools, 'gmail-readonly');
    const gmailAccounts = [
      ...new Set([...gmailScopes.scopes, ...readonlyScopes.scopes]),
    ];
    const gmailScoped = gmailAccounts.length > 0 && !tools?.includes('gmail');

    if (gmailScoped) {
      // Mount first scoped account as primary (/home/node/.gmail-mcp)
      // and any additional accounts at their named paths
      const primaryAccount = gmailAccounts[0];
      const primaryDir = path.join(homeDir, `.gmail-mcp-${primaryAccount}`);
      if (fs.existsSync(primaryDir)) {
        mounts.push({
          hostPath: primaryDir,
          containerPath: '/home/node/.gmail-mcp',
          readonly: false,
        });
      }
      for (let i = 1; i < gmailAccounts.length; i++) {
        const accountDir = path.join(homeDir, `.gmail-mcp-${gmailAccounts[i]}`);
        if (fs.existsSync(accountDir)) {
          mounts.push({
            hostPath: accountDir,
            containerPath: `/home/node/.gmail-mcp-${gmailAccounts[i]}`,
            readonly: false,
          });
        }
      }
    } else {
      // All accounts: mount primary and all additional accounts
      const gmailDir = path.join(homeDir, '.gmail-mcp');
      if (fs.existsSync(gmailDir)) {
        mounts.push({
          hostPath: gmailDir,
          containerPath: '/home/node/.gmail-mcp',
          readonly: false,
        });
      }
      try {
        for (const entry of fs.readdirSync(homeDir)) {
          if (!entry.startsWith('.gmail-mcp-')) continue;
          const dir = path.join(homeDir, entry);
          if (!fs.statSync(dir).isDirectory()) continue;
          mounts.push({
            hostPath: dir,
            containerPath: `/home/node/${entry}`,
            readonly: false,
          });
        }
      } catch {
        // ignore readdir errors
      }
    }
  }

  // Google Calendar MCP credentials — gated by tools config.
  // Supports scoped access: 'calendar' = all accounts,
  // 'calendar:illysium' = only that account's token.
  // Calendar uses the same GCP OAuth app as Gmail, so mount the primary
  // Gmail OAuth keys even when gmail tool is not enabled for this group.
  if (isToolEnabled(tools, 'calendar')) {
    const calendarDir = path.join(homeDir, '.config', 'google-calendar-mcp');
    fs.mkdirSync(calendarDir, { recursive: true });

    const { scopes: calendarAccounts, isScoped: calendarScoped } =
      extractToolScopes(tools, 'calendar');

    if (calendarScoped) {
      // Stage a filtered tokens.json with only allowed accounts
      const tokensPath = path.join(calendarDir, 'tokens.json');
      if (fs.existsSync(tokensPath)) {
        try {
          const allTokens = JSON.parse(fs.readFileSync(tokensPath, 'utf-8'));
          const filtered: Record<string, unknown> = {};
          for (const acct of calendarAccounts) {
            if (allTokens[acct]) {
              filtered[acct] = allTokens[acct];
            }
          }
          const stagingDir = path.join(
            DATA_DIR,
            'sessions',
            group.folder,
            threadId ? `threads/${threadId}` : 'main',
            'google-calendar-mcp',
          );
          fs.mkdirSync(stagingDir, { recursive: true });
          fs.writeFileSync(
            path.join(stagingDir, 'tokens.json'),
            JSON.stringify(filtered, null, 2),
          );
          // Copy non-token files (e.g. settings) as-is
          for (const entry of fs.readdirSync(calendarDir)) {
            if (entry === 'tokens.json') continue;
            const src = path.join(calendarDir, entry);
            if (fs.statSync(src).isFile()) {
              fs.copyFileSync(src, path.join(stagingDir, entry));
            }
          }
          mounts.push({
            hostPath: stagingDir,
            containerPath: '/home/node/.config/google-calendar-mcp',
            readonly: false,
          });
        } catch (err) {
          // Fail closed — do NOT fall back to full dir, that defeats scoping
          logger.warn(
            { err, group: group.folder },
            'Failed to filter calendar tokens — skipping calendar mount',
          );
        }
      } else {
        logger.warn(
          { group: group.folder },
          'Calendar tokens.json not found — calendar MCP will have no pre-existing tokens',
        );
      }
    } else {
      mounts.push({
        hostPath: calendarDir,
        containerPath: '/home/node/.config/google-calendar-mcp',
        readonly: false,
      });
    }

    // Ensure OAuth keys are available for calendar even without gmail tool.
    // Mount only the keys file — not the full dir (which has Gmail tokens).
    if (!isToolEnabled(tools, 'gmail')) {
      const oauthKeys = path.join(homeDir, '.gmail-mcp', 'gcp-oauth.keys.json');
      if (fs.existsSync(oauthKeys)) {
        mounts.push({
          hostPath: oauthKeys,
          containerPath: '/home/node/.gmail-mcp/gcp-oauth.keys.json',
          readonly: true,
        });
      }
    }
  }

  // Google Workspace (Drive/Sheets/Slides/Docs) credentials — gated by tools config.
  // Supports scoped access: 'google-workspace' = all accounts,
  // 'google-workspace:illysium' = only that account's credential file.
  if (isToolEnabled(tools, 'google-workspace')) {
    const gwDir = path.join(homeDir, '.google_workspace_mcp', 'credentials');

    if (!fs.existsSync(gwDir)) {
      logger.warn(
        { group: group.folder },
        'Google Workspace credentials dir not found — MCP server will have no pre-existing tokens',
      );
    } else {
      const { scopes: gwAccounts, isScoped: gwScoped } = extractToolScopes(
        tools,
        'google-workspace',
      );

      if (gwScoped) {
        // Stage filtered credentials directory with only allowed account files
        const stagingDir = path.join(
          DATA_DIR,
          'sessions',
          group.folder,
          threadId ? `threads/${threadId}` : 'main',
          'google-workspace-mcp',
        );
        // Clean stale files from previous runs (same pattern as Snowflake staging)
        if (fs.existsSync(stagingDir)) {
          fs.rmSync(stagingDir, { recursive: true });
        }
        fs.mkdirSync(stagingDir, { recursive: true });

        // Copy only matching credential files (scope name matches email substring)
        try {
          for (const entry of fs.readdirSync(gwDir)) {
            if (gwAccounts.some((acct) => entry.includes(acct))) {
              fs.copyFileSync(
                path.join(gwDir, entry),
                path.join(stagingDir, entry),
              );
            }
          }

          mounts.push({
            hostPath: stagingDir,
            containerPath: '/home/node/.google_workspace_mcp/credentials',
            readonly: false,
          });
        } catch (err) {
          // Fail closed — do NOT fall back to full dir, that defeats scoping
          logger.warn(
            { err, group: group.folder },
            'Failed to filter Google Workspace credentials — skipping mount',
          );
        }
      } else {
        // Mount entire credentials directory
        mounts.push({
          hostPath: gwDir,
          containerPath: '/home/node/.google_workspace_mcp/credentials',
          readonly: false,
        });
      }
    }

    // Ensure OAuth keys are available (reuse Gmail's GCP OAuth app)
    if (!isToolEnabled(tools, 'gmail') && !isToolEnabled(tools, 'calendar')) {
      const oauthKeys = path.join(homeDir, '.gmail-mcp', 'gcp-oauth.keys.json');
      if (fs.existsSync(oauthKeys)) {
        mounts.push({
          hostPath: oauthKeys,
          containerPath: '/home/node/.gmail-mcp/gcp-oauth.keys.json',
          readonly: true,
        });
      }
    }
  }

  // Snowflake credentials — gated by tools config.
  // Supports scoped access: 'snowflake' = all connections,
  // 'snowflake:sunday' or 'snowflake:apollo' = only those connections.
  if (isToolEnabled(tools, 'snowflake')) {
    const snowflakeDir = path.join(homeDir, '.snowflake');
    if (fs.existsSync(snowflakeDir)) {
      const origToml = path.join(snowflakeDir, 'connections.toml');
      if (fs.existsSync(origToml)) {
        // Determine which connections this group may access
        const { scopes: allowedConns, isScoped: filterConnections } =
          extractToolScopes(tools, 'snowflake');

        // Stage everything into a single directory: connections.toml (with
        // rewritten paths), config.toml (with rewritten log path), and key
        // files.  A single mount avoids the readonly-parent/sub-mount conflict.
        const stagingDir = path.join(
          DATA_DIR,
          'sessions',
          group.folder,
          'snowflake',
        );
        fs.mkdirSync(stagingDir, { recursive: true });

        // Rewrite connections.toml key paths for container home,
        // and optionally filter to only allowed connection sections
        const homePattern = new RegExp(
          escapeRegex(homeDir) + '/\\.snowflake/',
          'g',
        );
        let tomlContent = fs
          .readFileSync(origToml, 'utf-8')
          .replace(homePattern, '/home/node/.snowflake/');

        if (filterConnections) {
          // Split TOML into sections and keep only allowed ones
          const sections = tomlContent.split(/^(?=\[)/m);
          tomlContent = sections
            .filter((section) => {
              const match = section.match(/^\[([^\]]+)\]/);
              if (!match) return !section.trim(); // keep blank preamble
              return allowedConns.includes(match[1]);
            })
            .join('');
        }

        fs.writeFileSync(
          path.join(stagingDir, 'connections.toml'),
          tomlContent,
        );

        // Rewrite config.toml log path for container home
        const origConfig = path.join(snowflakeDir, 'config.toml');
        if (fs.existsSync(origConfig)) {
          const configContent = fs
            .readFileSync(origConfig, 'utf-8')
            .replace(homePattern, '/home/node/.snowflake/');
          fs.writeFileSync(path.join(stagingDir, 'config.toml'), configContent);
        }

        // Copy only key files referenced in the (possibly filtered) connections.toml,
        // making them readable by container user (uid 1000)
        const keysDir = path.join(snowflakeDir, 'keys');
        if (fs.existsSync(keysDir)) {
          // Extract referenced key paths from the filtered toml
          const referencedKeys = new Set<string>();
          for (const match of tomlContent.matchAll(
            /private_key_path\s*=\s*"[^"]*\/keys\/([^"]+)"/g,
          )) {
            referencedKeys.add(match[1]);
          }

          const destKeysDir = path.join(stagingDir, 'keys');
          // Clean previous staging to avoid stale keys from prior runs
          if (fs.existsSync(destKeysDir)) {
            fs.rmSync(destKeysDir, { recursive: true });
          }
          fs.mkdirSync(destKeysDir, { recursive: true });
          for (const entry of fs.readdirSync(keysDir, {
            withFileTypes: true,
            recursive: true,
          })) {
            if (entry.isFile()) {
              const srcPath = path.join(
                entry.parentPath || entry.path,
                entry.name,
              );
              const relPath = path.relative(keysDir, srcPath);
              // Skip key files not referenced by any allowed connection
              if (referencedKeys.size > 0 && !referencedKeys.has(relPath)) {
                continue;
              }
              const destPath = path.join(destKeysDir, relPath);
              fs.mkdirSync(path.dirname(destPath), { recursive: true });
              fs.copyFileSync(srcPath, destPath);
              fs.chmodSync(destPath, 0o644);
            }
          }
        }

        mounts.push({
          hostPath: stagingDir,
          containerPath: '/home/node/.snowflake',
          readonly: true,
        });
      }
    }
  }

  // dbt profiles — gated by tools config.
  // 'dbt' = all profiles, 'dbt:sunday-snowflake-db' = only that profile.
  if (isToolEnabled(tools, 'dbt')) {
    const dbtDir = path.join(homeDir, '.dbt');
    const origProfiles = path.join(dbtDir, 'profiles.yml');
    if (fs.existsSync(origProfiles)) {
      const { scopes, isScoped } = extractToolScopes(tools, 'dbt');
      const stagingDir = path.join(DATA_DIR, 'sessions', group.folder, 'dbt');
      fs.mkdirSync(stagingDir, { recursive: true });

      let profiles = YAML.parse(fs.readFileSync(origProfiles, 'utf-8'));
      if (isScoped) {
        const filtered: Record<string, unknown> = {};
        for (const name of scopes) {
          if (profiles[name] !== undefined) filtered[name] = profiles[name];
        }
        profiles = filtered;
      }

      fs.writeFileSync(
        path.join(stagingDir, 'profiles.yml'),
        YAML.stringify(profiles),
      );
      mounts.push({
        hostPath: stagingDir,
        containerPath: '/home/node/.dbt',
        readonly: true,
      });
    }
  }

  // Attachments: always mount group-specific attachments directory read-only.
  // Must be unconditional — piped follow-up messages may deliver attachments
  // after the container starts, and bind mounts show live filesystem changes.
  const groupAttachmentsDir = path.join(ATTACHMENTS_DIR, group.folder);
  fs.mkdirSync(groupAttachmentsDir, { recursive: true });
  mounts.push({
    hostPath: groupAttachmentsDir,
    containerPath: '/workspace/attachments',
    readonly: true,
  });

  // Per-group IPC namespace: each group gets its own IPC directory
  // This prevents cross-group privilege escalation via IPC
  const groupIpcDir = resolveGroupIpcPath(group.folder);
  fs.mkdirSync(path.join(groupIpcDir, 'messages'), { recursive: true });
  fs.mkdirSync(path.join(groupIpcDir, 'tasks'), { recursive: true });
  fs.mkdirSync(path.join(groupIpcDir, 'input'), { recursive: true });
  mounts.push({
    hostPath: groupIpcDir,
    containerPath: '/workspace/ipc',
    readonly: false,
  });

  // Copy agent-runner source into a per-group (or per-thread) writable
  // location so agents can customize it without affecting other groups.
  const agentRunnerSrc = path.join(
    projectRoot,
    'container',
    'agent-runner',
    'src',
  );
  const agentRunnerBase = threadId
    ? path.join(
        DATA_DIR,
        'sessions',
        group.folder,
        'threads',
        threadId,
        'agent-runner-src',
      )
    : path.join(DATA_DIR, 'sessions', group.folder, 'agent-runner-src');
  if (fs.existsSync(agentRunnerSrc)) {
    fs.cpSync(agentRunnerSrc, agentRunnerBase, { recursive: true });
  }
  mounts.push({
    hostPath: agentRunnerBase,
    containerPath: '/app/src',
    readonly: false,
  });

  // Additional mounts — use pre-validated if provided, otherwise validate inline
  const additionalMounts =
    preValidatedAdditionalMounts ??
    (group.containerConfig?.additionalMounts
      ? validateAdditionalMounts(
          group.containerConfig.additionalMounts,
          group.name,
          isMain,
        )
      : []);
  mounts.push(...additionalMounts);

  return mounts;
}

/**
 * Read allowed secrets from .env for passing to the container via stdin.
 * Secrets are never written to disk or mounted as files.
 *
 * When tools includes 'github:<scope>' (e.g. 'github:illysium'), reads
 * GITHUB_TOKEN_<SCOPE> from .env instead of the global GITHUB_TOKEN.
 * This ensures shared/multi-tenant groups get a fine-grained PAT scoped
 * to their org, making cross-org repo access impossible by construction.
 */
function readSecrets(
  groupFolder: string,
  tools?: string[],
): Record<string, string> {
  // Determine which GitHub token env var to read
  const { scopes: githubScopes, isScoped: githubScoped } = extractToolScopes(
    tools,
    'github',
  );
  const githubTokenKey = githubScoped
    ? `GITHUB_TOKEN_${githubScopes[0].toUpperCase()}`
    : 'GITHUB_TOKEN';

  if (githubScopes.length > 1) {
    logger.warn(
      'Multiple github: scopes specified — only the first (%s) is used',
      githubScopes[0],
    );
  }

  // Derive the scope suffix for this group (e.g. "sunday" → "SUNDAY")
  const scope = groupFolder.toUpperCase();

  // Build dbt keys: scoped variants take priority; fall back to unscoped globals
  const dbtScopedEmail = `DBT_CLOUD_EMAIL_${scope}`;
  const dbtScopedPassword = `DBT_CLOUD_PASSWORD_${scope}`;
  const dbtScopedApiKey = `DBT_CLOUD_API_KEY_${scope}`;
  const dbtScopedApiUrl = `DBT_CLOUD_API_URL_${scope}`;

  // Build env var list — conditionally include google-workspace OAuth keys
  const envKeys = [
    'CLAUDE_CODE_OAUTH_TOKEN',
    'ANTHROPIC_API_KEY',
    githubTokenKey,
    'DBT_CLOUD_EMAIL',
    'DBT_CLOUD_PASSWORD',
    dbtScopedEmail,
    dbtScopedPassword,
    dbtScopedApiKey,
    dbtScopedApiUrl,
    ...(isToolEnabled(tools, 'google-workspace')
      ? ['GOOGLE_OAUTH_CLIENT_ID', 'GOOGLE_OAUTH_CLIENT_SECRET']
      : []),
  ];
  const secrets = readEnvFile(envKeys);

  // Warn if scoped token is missing (fail-closed: no GITHUB_TOKEN at all)
  if (githubTokenKey !== 'GITHUB_TOKEN' && !secrets[githubTokenKey]) {
    logger.warn(
      { key: githubTokenKey },
      'Scoped GitHub token not found in .env — container will have no GitHub access',
    );
  }

  // Normalize scoped token key to GITHUB_TOKEN so the container entrypoint finds it
  if (githubTokenKey !== 'GITHUB_TOKEN' && secrets[githubTokenKey]) {
    secrets.GITHUB_TOKEN = secrets[githubTokenKey];
    delete secrets[githubTokenKey];
  }

  // Normalize scoped dbt keys to their generic names, then remove the scoped originals.
  // Scoped values override unscoped globals — unscoped globals remain as fallback if
  // no scoped key exists for this group.
  for (const [scoped, generic] of [
    [dbtScopedEmail, 'DBT_CLOUD_EMAIL'],
    [dbtScopedPassword, 'DBT_CLOUD_PASSWORD'],
    [dbtScopedApiKey, 'DBT_CLOUD_API_KEY'],
    [dbtScopedApiUrl, 'DBT_CLOUD_API_URL'],
  ] as const) {
    if (secrets[scoped]) {
      secrets[generic] = secrets[scoped];
      delete secrets[scoped];
    }
  }

  return secrets;
}

function buildContainerArgs(
  mounts: VolumeMount[],
  containerName: string,
  ipcInputSubdir: string,
): string[] {
  const args: string[] = [
    'run',
    '-i',
    '--rm',
    '--shm-size=256m',
    '--name',
    containerName,
  ];

  // Pass host timezone so container's local time matches the user's
  args.push('-e', `TZ=${TIMEZONE}`);

  // Pass IPC input subdirectory so container reads from the right thread-specific dir
  args.push('-e', `IPC_INPUT_SUBDIR=${ipcInputSubdir}`);

  // Pass residential proxy URL for browser automation on geo-fenced sites
  if (RESIDENTIAL_PROXY_URL) {
    args.push('-e', `RESIDENTIAL_PROXY_URL=${RESIDENTIAL_PROXY_URL}`);
  }

  // Set plugin root so hook shell commands can resolve ${CLAUDE_PLUGIN_ROOT}
  if (fs.existsSync(PLUGIN_DIR)) {
    args.push('-e', 'CLAUDE_PLUGIN_ROOT=/workspace/plugin');
  }

  // Runtime-specific args for host gateway resolution
  args.push(...hostGatewayArgs());

  // Run as host user so bind-mounted files are accessible.
  // Skip when running as root (uid 0), as the container's node user (uid 1000),
  // or when getuid is unavailable (native Windows without WSL).
  const hostUid = process.getuid?.();
  const hostGid = process.getgid?.();
  if (hostUid != null && hostUid !== 0 && hostUid !== 1000) {
    args.push('--user', `${hostUid}:${hostGid}`);
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
  onProgress?: (event: ProgressEvent) => void,
): Promise<ContainerOutput> {
  const startTime = Date.now();

  const groupDir = resolveGroupFolderPath(group.folder);
  fs.mkdirSync(groupDir, { recursive: true });

  // Resolve Granola OAuth access token (refreshes if expired)
  const tools = group.containerConfig?.tools;
  let granolaAccessToken: string | undefined;
  if (isToolEnabled(tools, 'granola')) {
    granolaAccessToken = (await getGranolaAccessToken()) || undefined;
    if (!granolaAccessToken) {
      logger.warn(
        { group: group.name },
        'Granola enabled but no valid token — Granola tools will be unavailable',
      );
    }
  }

  // Determine IPC input subdirectory for this container
  const ipcInputSubdir = input.threadId || GROUP_THREAD_KEY;

  // Prepare worktree workspace for thread-based concurrency.
  // Non-threaded channels (threadId undefined) mount the group folder directly.
  let worktreePath: string | undefined;
  if (input.threadId) {
    try {
      worktreePath = await withGroupMutex(group.folder, () =>
        prepareThreadWorkspace(group.folder, input.threadId!),
      );
      logger.debug(
        { group: group.name, threadId: input.threadId, worktreePath },
        'Thread worktree prepared',
      );
    } catch (err) {
      logger.error(
        { group: group.name, threadId: input.threadId, err },
        'Failed to prepare thread worktree',
      );
      throw err;
    }
  }

  // Create worktrees for additionalMounts with useWorktree: true.
  // Isolates the container's git operations from the host working tree.
  const mountWorktrees: Array<{ repoDir: string; wtPath: string }> = [];
  let mountSessionId: string | undefined;
  let validatedAdditionalMounts:
    | Array<{
        hostPath: string;
        containerPath: string;
        readonly: boolean;
        useWorktree?: boolean;
      }>
    | undefined;

  if (group.containerConfig?.additionalMounts?.some((m) => m.useWorktree)) {
    const validated = validateAdditionalMounts(
      group.containerConfig.additionalMounts,
      group.name,
      input.isMain,
    );

    mountSessionId = crypto.randomUUID().slice(0, 8);
    validatedAdditionalMounts = [];

    for (const vm of validated) {
      if (
        vm.useWorktree &&
        !vm.readonly &&
        fs.existsSync(path.join(vm.hostPath, '.git'))
      ) {
        try {
          const containerBasename = path.basename(vm.containerPath);
          const wtPath = await withGroupMutex(vm.hostPath, () =>
            prepareAdditionalMountWorktree(
              vm.hostPath,
              mountSessionId!,
              containerBasename,
            ),
          );
          mountWorktrees.push({ repoDir: vm.hostPath, wtPath });
          validatedAdditionalMounts.push({
            hostPath: wtPath,
            containerPath: vm.containerPath,
            readonly: vm.readonly,
          });
          logger.info(
            {
              hostPath: vm.hostPath,
              wtPath,
              sessionId: mountSessionId,
            },
            'Additional mount worktree prepared',
          );
        } catch (err) {
          logger.error(
            { hostPath: vm.hostPath, err },
            'Failed to create worktree for additional mount, using direct mount',
          );
          validatedAdditionalMounts.push(vm);
        }
      } else {
        validatedAdditionalMounts.push(vm);
      }
    }
  }

  // Create thread-specific IPC input directory before container launch.
  // chown to 1000 (container user) so the container can delete consumed files.
  const ipcInputDir = resolveGroupIpcInputPath(group.folder, ipcInputSubdir);
  fs.mkdirSync(ipcInputDir, { recursive: true });
  if (process.getuid?.() === 0) {
    try {
      fs.chownSync(ipcInputDir, 1000, 1000);
    } catch {
      // best-effort
    }
  }

  const mounts = buildVolumeMounts(
    group,
    input.isMain,
    input.threadId,
    worktreePath,
    validatedAdditionalMounts,
  );

  // When running as root (UID 0), writable mount directories are owned by root,
  // but the container runs as `node` (UID 1000). chown them so the container can write.
  if (process.getuid?.() === 0) {
    for (const m of mounts) {
      if (!m.readonly && fs.existsSync(m.hostPath)) {
        try {
          fs.chownSync(m.hostPath, 1000, 1000);
          // Also chown immediate children (e.g. debug/, input/, messages/)
          for (const child of fs.readdirSync(m.hostPath)) {
            const childPath = path.join(m.hostPath, child);
            try {
              fs.chownSync(childPath, 1000, 1000);
            } catch {
              // skip files we can't chown (e.g. read-only)
            }
          }
        } catch {
          // best-effort
        }
      }
    }
  }

  const safeName = group.folder.replace(/[^a-zA-Z0-9-]/g, '-');
  const containerName = `nanoclaw-${safeName}-${Date.now()}`;
  const containerArgs = buildContainerArgs(
    mounts,
    containerName,
    ipcInputSubdir,
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

    // Pass secrets via stdin (never written to disk or mounted as files)
    input.secrets = readSecrets(group.folder, tools);
    if (granolaAccessToken) {
      input.secrets.GRANOLA_ACCESS_TOKEN = granolaAccessToken;
    }
    // Pass tools restriction so agent-runner can gate MCP servers
    input.tools = group.containerConfig?.tools;
    container.stdin.write(JSON.stringify(input));
    container.stdin.end();

    // Streaming output: parse OUTPUT_START/END marker pairs as they arrive
    let parseBuffer = '';
    // Separate progress buffer — cannot share with parseBuffer because consuming
    // a PROGRESS marker would discard incomplete OUTPUT markers and vice versa
    let progressBuffer = '';
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

      // Stream-parse for progress markers (does NOT reset timeout or count toward output size)
      if (onProgress) {
        progressBuffer += chunk;
        let pIdx: number;
        while ((pIdx = progressBuffer.indexOf(PROGRESS_START_MARKER)) !== -1) {
          const pEnd = progressBuffer.indexOf(PROGRESS_END_MARKER, pIdx);
          if (pEnd === -1) break;
          const json = progressBuffer
            .slice(pIdx + PROGRESS_START_MARKER.length, pEnd)
            .trim();
          progressBuffer = progressBuffer.slice(
            pEnd + PROGRESS_END_MARKER.length,
          );
          try {
            onProgress(JSON.parse(json));
          } catch {
            // skip malformed progress events
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
    const configTimeout = group.containerConfig?.timeout || CONTAINER_TIMEOUT;
    // Grace period: hard timeout must be at least IDLE_TIMEOUT + 30s so the
    // graceful _close sentinel has time to trigger before the hard kill fires.
    const timeoutMs = Math.max(configTimeout, IDLE_TIMEOUT + 30_000);

    const killOnTimeout = () => {
      timedOut = true;
      logger.error(
        { group: group.name, containerName },
        'Container timeout, stopping gracefully',
      );
      exec(stopContainer(containerName), { timeout: 15000 }, (err) => {
        if (err) {
          logger.warn(
            { group: group.name, containerName, err },
            'Graceful stop failed, force killing',
          );
          container.kill('SIGKILL');
        }
      });
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

      // Clean up additional-mount worktrees (fire-and-forget)
      if (mountWorktrees.length > 0) {
        cleanupAdditionalMountWorktrees(mountSessionId!, mountWorktrees).catch(
          (err) =>
            logger.warn({ err }, 'Additional mount worktree cleanup error'),
        );
      }

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
            ``,
            `=== Stderr${stderrTruncated ? ' (TRUNCATED)' : ''} ===`,
            stderr,
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
        logLines.push(
          `=== Input ===`,
          JSON.stringify(input, null, 2),
          ``,
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
    schedule_type: string;
    schedule_value: string;
    status: string;
    next_run: string | null;
  }>,
): void {
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
  registeredJids: Set<string>,
): void {
  const groupIpcDir = resolveGroupIpcPath(groupFolder);
  fs.mkdirSync(groupIpcDir, { recursive: true });

  // Main sees all groups; others see nothing (they can't activate groups)
  const visibleGroups = isMain ? groups : [];

  const groupsFile = path.join(groupIpcDir, 'available_groups.json');
  fs.writeFileSync(
    groupsFile,
    JSON.stringify(
      {
        groups: visibleGroups,
        lastSync: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
}
