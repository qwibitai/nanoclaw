/**
 * Per-group container config, stored as a plain JSON file at
 * `groups/<folder>/container.json`. Mounted read-only inside the container
 * at `/workspace/agent/container.json` — the runner reads it at startup but
 * cannot modify it.
 *
 * Writers: multiple host-side surfaces (operator-driven `/install-plugin`
 * skill, agent-driven self-mod approval handlers, container-runner's
 * runtime-field sync at spawn). To avoid lost-update races between
 * concurrent writers, all read-modify-write sequences must go through
 * `updateContainerConfig()` which acquires an advisory lock and writes
 * atomically (write-then-rename).
 *
 * Direct callers of `writeContainerConfig` should be limited to first-write
 * paths where the file doesn't exist yet (e.g. `initContainerConfig`).
 */
import fs from 'fs';
import path from 'path';

import { GROUPS_DIR } from './config.js';

export interface McpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  // Optional always-in-context guidance. When set, the host writes the
  // content to `.claude-fragments/mcp-<name>.md` at spawn and imports it
  // into the composed CLAUDE.md.
  instructions?: string;
}

export interface AdditionalMountConfig {
  hostPath: string;
  containerPath: string;
  readonly?: boolean;
}

/**
 * Source variants for `extraKnownMarketplaces` entries. Mirrors the SDK's
 * typed schema verbatim — see `extraKnownMarketplaces` in the SDK type
 * definitions. Don't reshape; pass through to settings.json as-is.
 */
export type ExtraKnownMarketplaceSource =
  | { source: 'url'; url: string; headers?: Record<string, string> }
  | { source: 'github'; repo: string; ref?: string; path?: string; sparsePaths?: string[] }
  | { source: 'git'; url: string; ref?: string; path?: string; sparsePaths?: string[] }
  | { source: 'npm'; package: string }
  | { source: 'file'; path: string }
  | { source: 'directory'; path: string }
  | { source: 'hostPattern'; hostPattern: string }
  | { source: 'pathPattern'; pathPattern: string }
  | { source: 'settings'; name: string; plugins: unknown[] };

export interface PluginsConfig {
  /** Marketplaces to register. Same shape as SDK's extraKnownMarketplaces. */
  marketplaces?: Record<string, { source: ExtraKnownMarketplaceSource }>;
  /**
   * Plugin enablement keyed by "plugin-id@marketplace-id". Mirrors SDK's
   * `enabledPlugins` value union — boolean flag, version-constraint array,
   * or object form. Don't narrow to just boolean.
   */
  enabled?: Record<string, boolean | string[] | { [k: string]: unknown }>;
}

export interface ContainerConfig {
  mcpServers: Record<string, McpServerConfig>;
  packages: { apt: string[]; npm: string[] };
  imageTag?: string;
  additionalMounts: AdditionalMountConfig[];
  /** Which skills to enable — array of skill names or "all" (default). */
  skills: string[] | 'all';
  /** Agent provider name (e.g. "claude", "opencode"). Default: "claude". */
  provider?: string;
  /** Agent group display name (used in transcript archiving). */
  groupName?: string;
  /** Assistant display name (used in system prompt / responses). */
  assistantName?: string;
  /** Agent group ID — set by the host, read by the runner. */
  agentGroupId?: string;
  /** Max messages per prompt. Falls back to code default if unset. */
  maxMessagesPerPrompt?: number;
  /**
   * Plugin marketplaces and enabled plugins. When set, the host writes these
   * into per-group `settings.json` (`extraKnownMarketplaces` / `enabledPlugins`)
   * and sets `CLAUDE_CODE_SYNC_PLUGIN_INSTALL=1` + `CLAUDE_CODE_REMOTE=1` in
   * the container env so the SDK installs them at session init.
   */
  plugins?: PluginsConfig;
}

function emptyConfig(): ContainerConfig {
  return {
    mcpServers: {},
    packages: { apt: [], npm: [] },
    additionalMounts: [],
    skills: 'all',
  };
}

function configPath(folder: string): string {
  return path.join(GROUPS_DIR, folder, 'container.json');
}

function lockPath(folder: string): string {
  return path.join(GROUPS_DIR, folder, 'container.json.lock');
}

/**
 * Read the container config for a group, returning sensible defaults for
 * any missing fields (or an entirely empty config if the file is absent).
 * Never throws for missing / malformed files — corruption logs a warning
 * via console.error and falls back to empty.
 *
 * Reads are unlocked: writes are atomic via write-then-rename, so a reader
 * always observes either the previous complete file or the next complete
 * file, never a half-written one.
 */
export function readContainerConfig(folder: string): ContainerConfig {
  const p = configPath(folder);
  if (!fs.existsSync(p)) return emptyConfig();
  try {
    const raw = JSON.parse(fs.readFileSync(p, 'utf8')) as Partial<ContainerConfig>;
    return {
      mcpServers: raw.mcpServers ?? {},
      packages: {
        apt: raw.packages?.apt ?? [],
        npm: raw.packages?.npm ?? [],
      },
      imageTag: raw.imageTag,
      additionalMounts: raw.additionalMounts ?? [],
      skills: raw.skills ?? 'all',
      provider: raw.provider,
      groupName: raw.groupName,
      assistantName: raw.assistantName,
      agentGroupId: raw.agentGroupId,
      maxMessagesPerPrompt: raw.maxMessagesPerPrompt,
      plugins: raw.plugins,
    };
  } catch (err) {
    console.error(`[container-config] failed to parse ${p}: ${String(err)}`);
    return emptyConfig();
  }
}

/**
 * Write the container config for a group atomically (write-then-rename),
 * creating the groups/<folder>/ directory if necessary. Pretty-printed JSON
 * so diffs in the activation flow are reviewable.
 *
 * **Concurrency:** this is the low-level writer. For read-modify-write
 * sequences from concurrent writers (operator skills, agent self-mod,
 * runtime-field sync), use `updateContainerConfig()` which acquires an
 * advisory lock first.
 */
export function writeContainerConfig(folder: string, config: ContainerConfig): void {
  const p = configPath(folder);
  const dir = path.dirname(p);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const tmp = `${p}.tmp.${process.pid}.${Math.random().toString(36).slice(2, 10)}`;
  fs.writeFileSync(tmp, JSON.stringify(config, null, 2) + '\n');
  fs.renameSync(tmp, p);
}

const LOCK_STALE_MS = 60_000;
const LOCK_TIMEOUT_MS = 30_000;
const LOCK_POLL_MS = 50;

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Acquire an advisory lock at `<configPath>.lock`. The lockfile contains
 * `<pid>` as a debugging aid. Stale locks (older than LOCK_STALE_MS) are
 * cleared on next acquire to recover from crashed writers. Polls every
 * LOCK_POLL_MS ms with jitter; throws after LOCK_TIMEOUT_MS.
 */
async function acquireLock(folder: string): Promise<() => void> {
  const lp = lockPath(folder);
  const dir = path.dirname(lp);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const start = Date.now();
  while (true) {
    try {
      const fd = fs.openSync(lp, 'wx');
      try {
        fs.writeSync(fd, String(process.pid));
      } finally {
        fs.closeSync(fd);
      }
      // Got the lock; return a release function.
      return () => {
        try {
          fs.unlinkSync(lp);
        } catch {
          /* lock already gone — release is best-effort */
        }
      };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST') throw err;
      // Lock held by another process. Check for staleness.
      try {
        const stat = fs.statSync(lp);
        if (Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
          // Stale — try to clear it. Race-safe: if another process clears it
          // between our stat and unlink, the next acquire attempt will retry.
          try {
            fs.unlinkSync(lp);
          } catch {
            /* race with another acquirer — fine */
          }
          continue;
        }
      } catch {
        // Lock disappeared between EEXIST and stat — retry.
        continue;
      }
      if (Date.now() - start > LOCK_TIMEOUT_MS) {
        throw new Error(`Timeout acquiring container.json lock for group "${folder}"`);
      }
      await sleep(LOCK_POLL_MS + Math.random() * LOCK_POLL_MS);
    }
  }
}

/**
 * Apply a mutator function to a group's container config and persist the
 * result, atomically and serialized against concurrent writers.
 *
 * The mutator may be sync or async. Returns the updated config.
 *
 * Use this for any read-modify-write sequence: appending to packages,
 * adding/removing plugin marketplaces, syncing runtime identity fields,
 * etc.
 */
export async function updateContainerConfig(
  folder: string,
  mutate: (config: ContainerConfig) => void | Promise<void>,
): Promise<ContainerConfig> {
  const release = await acquireLock(folder);
  try {
    const config = readContainerConfig(folder);
    await mutate(config);
    writeContainerConfig(folder, config);
    return config;
  } finally {
    release();
  }
}

/**
 * Initialize an empty container.json for a group if one doesn't already
 * exist. Idempotent — used from `group-init.ts`. No lock required because
 * this is a first-write path: the file doesn't exist yet.
 */
export function initContainerConfig(folder: string): boolean {
  const p = configPath(folder);
  if (fs.existsSync(p)) return false;
  writeContainerConfig(folder, emptyConfig());
  return true;
}
