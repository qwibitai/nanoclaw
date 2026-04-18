/**
 * Container Runner for NanoClaw
 * Spawns agent execution in containers and handles IPC
 */
import { ChildProcess, execSync, spawn } from 'child_process';
import { randomUUID } from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  CONTAINER_IMAGE,
  CONTAINER_MAX_OUTPUT_SIZE,
  CONTAINER_TIMEOUT,
  DATA_DIR,
  GROUPS_DIR,
  IDLE_TIMEOUT,
  ONECLI_API_KEY,
  ONECLI_URL,
  SUPERPILOT_API_URL,
  SUPERPILOT_MCP_URL,
  TIMEZONE,
  TRUST_GATEWAY_URL,
  BROWSER_CDP_URL,
} from './config.js';
import { resolveGroupFolderPath, resolveGroupIpcPath } from './group-folder.js';
import { logger } from './logger.js';
import {
  CONTAINER_RUNTIME_BIN,
  hostGatewayArgs,
  readonlyMountArgs,
  stopContainer,
} from './container-runtime.js';
import { OneCLI } from '@onecli-sh/sdk';
import { readEnvFile } from './env.js';
import { validateAdditionalMounts } from './mount-security.js';
import { RegisteredGroup } from './types.js';

const onecli = new OneCLI({ url: ONECLI_URL, apiKey: ONECLI_API_KEY });

// Track which gmail account directories we've already logged the
// "skipping mount, no credentials.json" warning for, so the operator
// gets one nudge per process lifetime instead of one per spawn.
const gmailSkipLoggedFor = new Set<string>();

// Sentinel markers for robust output parsing (must match agent-runner)
const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

export interface ContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  assistantName?: string;
  script?: string;
  verbose?: boolean;
  provider?: 'anthropic' | 'openai' | 'google' | 'ollama' | 'groq' | 'together';
  model?: string;
  providerBaseUrl?: string;
}

export interface ContainerOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  error?: string;
  /** Real API cost reported by the SDK's result message (USD). */
  totalCostUsd?: number;
  /** Token usage reported by the SDK's result message. */
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
  /** Number of turns in this SDK query (for diagnostics). */
  numTurns?: number;
  /**
   * Short human-readable label for in-flight work (e.g. "Reading Gmail
   * thread"). Emitted when a tool_use block is detected. Host edits the
   * in-place "⏳ working" message with this. Always paired with result=null.
   */
  progressLabel?: string;
}

interface VolumeMount {
  hostPath: string;
  containerPath: string;
  readonly: boolean;
  /** If true, mount failure won't prevent container from starting. */
  optional?: boolean;
  /** Internal: set to true on retry to skip this mount. */
  _skip?: boolean;
}

function buildVolumeMounts(
  group: RegisteredGroup,
  isMain: boolean,
): VolumeMount[] {
  const mounts: VolumeMount[] = [];
  const projectRoot = process.cwd();
  const groupDir = resolveGroupFolderPath(group.folder);

  if (isMain) {
    // Main gets the project root read-only. Writable paths the agent needs
    // (store, group folder, IPC, .claude/) are mounted separately below.
    // Read-only prevents the agent from modifying host application code
    // (src/, dist/, package.json, etc.) which would bypass the sandbox
    // entirely on next restart.
    mounts.push({
      hostPath: projectRoot,
      containerPath: '/workspace/project',
      readonly: true,
    });

    // Shadow .env so the agent cannot read secrets from the mounted project root.
    // Credentials are injected by the OneCLI gateway, never exposed to containers.
    const envFile = path.join(projectRoot, '.env');
    if (fs.existsSync(envFile)) {
      mounts.push({
        hostPath: '/dev/null',
        containerPath: '/workspace/project/.env',
        readonly: true,
      });
    }

    // Main gets writable access to the store (SQLite DB) so it can
    // query and write to the database directly.
    const storeDir = path.join(projectRoot, 'store');
    mounts.push({
      hostPath: storeDir,
      containerPath: '/workspace/project/store',
      readonly: false,
    });

    // Main also gets its group folder as the working directory
    mounts.push({
      hostPath: groupDir,
      containerPath: '/workspace/group',
      readonly: false,
    });

    // Global memory directory — writable for main so it can update shared context
    const globalDir = path.join(GROUPS_DIR, 'global');
    if (fs.existsSync(globalDir)) {
      mounts.push({
        hostPath: globalDir,
        containerPath: '/workspace/global',
        readonly: false,
      });
    }
  } else {
    // Other groups only get their own folder
    mounts.push({
      hostPath: groupDir,
      containerPath: '/workspace/group',
      readonly: false,
    });

    // Global memory directory (read-only for non-main)
    // Only directory mounts are supported, not file mounts
    const globalDir = path.join(GROUPS_DIR, 'global');
    if (fs.existsSync(globalDir)) {
      mounts.push({
        hostPath: globalDir,
        containerPath: '/workspace/global',
        readonly: true,
      });
    }
  }

  // Per-group Claude sessions directory (isolated from other groups)
  // Each group gets their own .claude/ to prevent cross-group session access
  const groupSessionsDir = path.join(
    DATA_DIR,
    'sessions',
    group.folder,
    '.claude',
  );
  fs.mkdirSync(groupSessionsDir, { recursive: true });
  const settingsFile = path.join(groupSessionsDir, 'settings.json');
  if (!fs.existsSync(settingsFile)) {
    fs.writeFileSync(
      settingsFile,
      JSON.stringify(
        {
          env: {
            // Enable agent swarms (subagent orchestration)
            // https://code.claude.com/docs/en/agent-teams#orchestrate-teams-of-claude-code-sessions
            CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
            // Load CLAUDE.md from additional mounted directories
            // https://code.claude.com/docs/en/memory#load-memory-from-additional-directories
            CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: '1',
            // Enable Claude's memory feature (persists user preferences between sessions)
            // https://code.claude.com/docs/en/memory#manage-auto-memory
            CLAUDE_CODE_DISABLE_AUTO_MEMORY: '0',
          },
        },
        null,
        2,
      ) + '\n',
    );
  }

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
  mounts.push({
    hostPath: groupSessionsDir,
    containerPath: '/home/node/.claude',
    readonly: false,
  });

  // Gmail credentials directories (multi-account: personal, whoisxml/jonathan,
  // attaxion, dev). Only mount accounts that have a credentials.json — mounting
  // a directory with only gcp-oauth.keys.json gives the gmail-mcp something
  // to discover but no usable token, which produces confusing "no credentials"
  // errors when the agent first tries to call a Gmail tool. Better to omit
  // the mount entirely so the gmail-mcp never sees a half-configured directory.
  //
  // NOTE: The in-container @gongrzhe/server-gmail-autoauth-mcp package is
  // hard-coded to a single account directory (~/.gmail-mcp), so the jonathan,
  // attaxion, and dev mounts are reserved for a future per-account MCP launcher
  // and are currently inert from the agent's perspective. Personal is the only
  // reachable account today.
  const homeDir = os.homedir();
  const gmailDirs = [
    { hostDir: '.gmail-mcp', containerDir: '.gmail-mcp' },
    { hostDir: '.gmail-mcp-jonathan', containerDir: '.gmail-mcp-jonathan' },
    { hostDir: '.gmail-mcp-attaxion', containerDir: '.gmail-mcp-attaxion' },
    { hostDir: '.gmail-mcp-dev', containerDir: '.gmail-mcp-dev' },
  ];
  for (const gd of gmailDirs) {
    const gmailDir = path.join(homeDir, gd.hostDir);
    const credsFile = path.join(gmailDir, 'credentials.json');
    if (fs.existsSync(gmailDir) && fs.existsSync(credsFile)) {
      mounts.push({
        hostPath: gmailDir,
        containerPath: `/home/node/${gd.containerDir}`,
        readonly: false, // MCP may need to refresh OAuth tokens
        optional: true,
      });
    } else if (fs.existsSync(gmailDir)) {
      if (!gmailSkipLoggedFor.has(gmailDir)) {
        gmailSkipLoggedFor.add(gmailDir);
        logger.info(
          { gmailDir },
          'Gmail account directory present but no credentials.json — skipping mount (account not authorized yet; run gmail-mcp auth flow to enable)',
        );
      }
    }
  }

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

  // Copy agent-runner source into a per-group writable location so agents
  // can customize it (add tools, change behavior) without affecting other
  // groups. Recompiled on container startup via entrypoint.sh.
  const agentRunnerSrc = path.join(
    projectRoot,
    'container',
    'agent-runner',
    'src',
  );
  const groupAgentRunnerDir = path.join(
    DATA_DIR,
    'sessions',
    group.folder,
    'agent-runner-src',
  );
  if (fs.existsSync(agentRunnerSrc)) {
    const srcIndex = path.join(agentRunnerSrc, 'index.ts');
    const cachedIndex = path.join(groupAgentRunnerDir, 'index.ts');
    const needsCopy =
      !fs.existsSync(groupAgentRunnerDir) ||
      !fs.existsSync(cachedIndex) ||
      (fs.existsSync(srcIndex) &&
        fs.statSync(srcIndex).mtimeMs > fs.statSync(cachedIndex).mtimeMs);
    if (needsCopy) {
      fs.cpSync(agentRunnerSrc, groupAgentRunnerDir, { recursive: true });
    }
  }
  mounts.push({
    hostPath: groupAgentRunnerDir,
    containerPath: '/app/src',
    readonly: false,
  });

  // macOS Contacts database (readonly) — enables contact lookup from agents.
  // Docker Desktop may not have permission to mount from ~/Library/Application Support.
  // Export a copy to a Docker-accessible location instead.
  const addressBookDir = path.join(
    homeDir,
    'Library',
    'Application Support',
    'AddressBook',
  );
  const contactsCacheDir = path.join(DATA_DIR, 'contacts-cache');
  try {
    if (fs.existsSync(addressBookDir)) {
      const sourcesDir = path.join(addressBookDir, 'Sources');
      const cachedSourcesDir = path.join(contactsCacheDir, 'Sources');
      if (fs.existsSync(sourcesDir)) {
        // Only re-copy if the source DB is newer than the cache (staleness check)
        let needsCopy = !fs.existsSync(cachedSourcesDir);
        if (!needsCopy) {
          const srcStat = fs.statSync(sourcesDir);
          const cacheStat = fs.statSync(cachedSourcesDir);
          needsCopy = srcStat.mtimeMs > cacheStat.mtimeMs;
        }
        if (needsCopy) {
          fs.mkdirSync(contactsCacheDir, { recursive: true });
          fs.cpSync(sourcesDir, cachedSourcesDir, { recursive: true });
          logger.debug('Contacts cache refreshed');
        }
        mounts.push({
          hostPath: contactsCacheDir,
          containerPath: '/workspace/contacts',
          readonly: true,
          optional: true,
        });
      }
    }
  } catch (err) {
    logger.debug(
      { err: err instanceof Error ? err.message : String(err) },
      'Contacts cache copy failed — search_contacts will be unavailable',
    );
  }

  // Additional mounts validated against external allowlist (tamper-proof from containers)
  if (group.containerConfig?.additionalMounts) {
    const validatedMounts = validateAdditionalMounts(
      group.containerConfig.additionalMounts,
      group.name,
      isMain,
    );
    mounts.push(...validatedMounts.map((m) => ({ ...m, optional: true })));
  }

  return mounts;
}

/**
 * Usage-aware OAuth token routing across multiple Max subscriptions.
 * Tracks per-token cost and rate-limit events to distribute load optimally.
 */
interface TokenStats {
  costUsd: number; // Accumulated cost this period
  requests: number; // Number of container spawns
  rateLimitedUntil: number; // Timestamp — deprioritize until this time
  lastUsed: number; // Timestamp of last use
}

const oauthTokenStats = new Map<string, TokenStats>();
let oauthTokenCache: { tokens: string[]; expiresAt: number } = {
  tokens: [],
  expiresAt: 0,
};
const OAUTH_CACHE_TTL_MS = 5 * 60 * 1000;
const RATE_LIMIT_COOLDOWN_MS = 10 * 60 * 1000; // 10 min cooldown on rate limit
const COST_RESET_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours
let costPeriodStart = Date.now();

function refreshOAuthTokens(): string[] {
  try {
    const pids = execSync('pgrep -f "claude"', {
      encoding: 'utf-8',
      timeout: 5000,
    })
      .trim()
      .split('\n')
      .filter(Boolean)
      .slice(0, 40);

    const tokens = new Set<string>();
    for (const pid of pids) {
      try {
        const env = execSync(`ps eww ${pid}`, {
          encoding: 'utf-8',
          timeout: 3000,
        });
        const match = env.match(/CLAUDE_CODE_OAUTH_TOKEN=(sk-ant-oat01-\S+)/);
        if (match) tokens.add(match[1]);
      } catch {
        continue;
      }
    }
    return [...tokens];
  } catch (err) {
    logger.debug(
      { err: err instanceof Error ? err.message : String(err) },
      'OAuth token scan failed',
    );
    return [];
  }
}

function getTokenStats(token: string): TokenStats {
  let stats = oauthTokenStats.get(token);
  if (!stats) {
    stats = { costUsd: 0, requests: 0, rateLimitedUntil: 0, lastUsed: 0 };
    oauthTokenStats.set(token, stats);
  }
  return stats;
}

export function getNextOAuthToken(): string | null {
  const now = Date.now();

  // Daily cost reset — prevents routing from converging to random as all
  // tokens accumulate similar lifetime costs.
  if (now - costPeriodStart >= COST_RESET_INTERVAL_MS) {
    for (const stats of oauthTokenStats.values()) {
      stats.costUsd = 0;
      stats.requests = 0;
    }
    costPeriodStart = now;
    logger.info('Token cost stats reset (24h period)');
  }

  if (now >= oauthTokenCache.expiresAt) {
    const tokens = refreshOAuthTokens();
    oauthTokenCache = { tokens, expiresAt: now + OAUTH_CACHE_TTL_MS };
    // Clean up stats for tokens that no longer exist
    for (const key of oauthTokenStats.keys()) {
      if (!tokens.includes(key)) oauthTokenStats.delete(key);
    }
    if (tokens.length > 0) {
      logger.info(
        { count: tokens.length },
        `Found ${tokens.length} Max subscription OAuth token(s)`,
      );
    }
  }

  const { tokens } = oauthTokenCache;
  if (tokens.length === 0) return null;
  if (tokens.length === 1) {
    const stats = getTokenStats(tokens[0]);
    stats.requests++;
    stats.lastUsed = now;
    return tokens[0];
  }

  // Pick the token with the lowest effective score.
  // Score = accumulated cost + rate-limit penalty.
  // Rate-limited tokens get a large penalty until cooldown expires.
  let bestToken = tokens[0];
  let bestScore = Infinity;

  for (const token of tokens) {
    const stats = getTokenStats(token);
    let score = stats.costUsd;
    if (now < stats.rateLimitedUntil) {
      score += 1000; // Heavy penalty — avoid rate-limited tokens
    }
    if (score < bestScore) {
      bestScore = score;
      bestToken = token;
    }
  }

  const stats = getTokenStats(bestToken);
  stats.requests++;
  stats.lastUsed = now;
  return bestToken;
}

/**
 * Report cost for a token after a container run completes.
 * Called from runContainerAgent to update per-token usage stats.
 */
export function reportTokenUsage(token: string, costUsd: number): void {
  const stats = getTokenStats(token);
  stats.costUsd += costUsd;
}

/**
 * Mark a token as rate-limited. Called when a container error
 * suggests the token hit a usage or rate limit.
 */
export function markTokenRateLimited(token: string): void {
  const stats = getTokenStats(token);
  stats.rateLimitedUntil = Date.now() + RATE_LIMIT_COOLDOWN_MS;
  logger.warn(
    {
      tokenPrefix: token.slice(0, 20) + '...',
      cooldownMs: RATE_LIMIT_COOLDOWN_MS,
    },
    'Token rate-limited, deprioritizing',
  );
}

/** Check if an error message indicates a rate limit or usage limit. */
function isRateLimitError(errorMsg: string): boolean {
  const lower = errorMsg.toLowerCase();
  return (
    lower.includes('rate limit') ||
    lower.includes('rate_limit') ||
    lower.includes('429') ||
    lower.includes('too many requests') ||
    lower.includes('usage limit') ||
    lower.includes('quota exceeded') ||
    lower.includes('overloaded')
  );
}

async function buildContainerArgs(
  mounts: VolumeMount[],
  containerName: string,
  isMain: boolean,
  agentIdentifier?: string,
): Promise<{
  args: string[];
  oauthToken: string | null;
  envFilePath: string | null;
}> {
  const args: string[] = ['run', '-i', '--rm', '--name', containerName];

  // Connect to nanoclaw Docker network for sidecar access
  args.push('--network', 'nanoclaw');

  // Pass host timezone so container's local time matches the user's
  args.push('-e', `TZ=${TIMEZONE}`);

  // Superpilot MCP and service tokens — all groups need these so agents
  // can access superpilot tools, Discord, and mark items as processed
  // regardless of which channel the container was spawned from.
  args.push('-e', `SUPERPILOT_MCP_URL=${SUPERPILOT_MCP_URL}`);
  args.push('-e', `SUPERPILOT_API_URL=${SUPERPILOT_API_URL}`);
  // Trust gateway — containers call this before executing write/transact ops
  args.push('-e', `TRUST_GATEWAY_URL=${TRUST_GATEWAY_URL}`);
  // Browser sidecar — CDP endpoint for browser automation
  // Containers on the Docker network connect via the service name, not localhost
  const containerCdpUrl = BROWSER_CDP_URL.replace(
    'localhost',
    'host.docker.internal',
  );
  args.push('-e', `BROWSER_CDP_URL=${containerCdpUrl}`);
  // readEnvFile() is needed because .env values are NOT loaded into process.env.
  const containerEnv = readEnvFile([
    'DISCORD_BOT_TOKEN',
    'NANOCLAW_SERVICE_TOKEN',
    'GH_TOKEN',
    'NOTION_TOKEN',
  ]);
  const discordToken =
    process.env.DISCORD_BOT_TOKEN || containerEnv.DISCORD_BOT_TOKEN;
  if (discordToken) {
    args.push('-e', `DISCORD_BOT_TOKEN=${discordToken}`);
  }
  // Pass only the primary (first) service token to containers.
  // The env may contain comma-separated tokens with @label suffixes
  // for multi-account SSE; containers only need the primary token for MCP auth.
  const rawServiceToken =
    process.env.NANOCLAW_SERVICE_TOKEN || containerEnv.NANOCLAW_SERVICE_TOKEN;
  if (rawServiceToken) {
    const first = rawServiceToken.split(',')[0].trim();
    const token = first.includes('@')
      ? first.slice(0, first.indexOf('@'))
      : first;
    args.push('-e', `NANOCLAW_SERVICE_TOKEN=${token}`);
  }
  // GitHub token for gh CLI and git push (same pattern as GitHub Actions)
  const ghToken = process.env.GH_TOKEN || containerEnv.GH_TOKEN;
  if (ghToken) {
    args.push('-e', `GH_TOKEN=${ghToken}`);
  }
  // Notion integration token for Notion MCP server
  const notionToken = process.env.NOTION_TOKEN || containerEnv.NOTION_TOKEN;
  if (notionToken) {
    args.push('-e', `NOTION_TOKEN=${notionToken}`);
  }

  // Non-Anthropic LLM provider keys
  const openaiKey = process.env.OPENAI_API_KEY;
  if (openaiKey) {
    args.push('-e', `OPENAI_API_KEY=${openaiKey}`);
  }
  const googleKey = process.env.GOOGLE_GENERATIVE_AI_API_KEY;
  if (googleKey) {
    args.push('-e', `GOOGLE_GENERATIVE_AI_API_KEY=${googleKey}`);
  }
  const groqKey = process.env.GROQ_API_KEY;
  if (groqKey) {
    args.push('-e', `GROQ_API_KEY=${groqKey}`);
  }
  const togetherKey = process.env.TOGETHER_AI_API_KEY;
  if (togetherKey) {
    args.push('-e', `TOGETHER_AI_API_KEY=${togetherKey}`);
  }

  // OneCLI gateway handles credential injection for non-Anthropic services
  // (GitHub, Gmail, etc.) and as fallback for Anthropic if no OAuth token.
  const onecliApplied = await onecli.applyContainerConfig(args, {
    addHostMapping: false, // Nanoclaw already handles host gateway
    agent: agentIdentifier,
  });

  // Auth strategy: prefer Max subscription OAuth token (free included usage)
  // over OneCLI API key injection (billed per token).
  // Applied AFTER OneCLI so our -e flags override OneCLI's ANTHROPIC_BASE_URL.
  const oauthToken = getNextOAuthToken();
  if (oauthToken) {
    args.push('-e', `CLAUDE_CODE_OAUTH_TOKEN=${oauthToken}`);
    // Override OneCLI's proxy URL — OAuth must talk directly to Anthropic
    args.push('-e', 'ANTHROPIC_BASE_URL=https://api.anthropic.com');
    const stats = getTokenStats(oauthToken);
    logger.info(
      {
        containerName,
        tokenPrefix: oauthToken.slice(0, 20) + '...',
        totalTokens: oauthTokenCache.tokens.length,
        tokenCostSoFar: `$${stats.costUsd.toFixed(2)}`,
        tokenRequests: stats.requests,
      },
      'Using Max subscription OAuth token',
    );
  } else if (onecliApplied) {
    logger.info({ containerName }, 'OneCLI gateway config applied');
  } else {
    logger.warn(
      { containerName },
      'No OAuth token and OneCLI not reachable — container will have no Anthropic credentials',
    );
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
    if (mount.optional && mount._skip) continue; // Skipped on retry
    if (mount.readonly) {
      args.push(...readonlyMountArgs(mount.hostPath, mount.containerPath));
    } else {
      args.push('-v', `${mount.hostPath}:${mount.containerPath}`);
    }
  }

  args.push(CONTAINER_IMAGE);

  // Security: extract secret -e flags into a tmpfile so they're not visible in `ps aux`.
  // Sensitive keys include our own secrets plus anything OneCLI injected (proxy creds, certs).
  const SECRET_KEY_PREFIXES = [
    'DISCORD_BOT_TOKEN=',
    'NANOCLAW_SERVICE_TOKEN=',
    'GH_TOKEN=',
    'NOTION_TOKEN=',
    'CLAUDE_CODE_OAUTH_TOKEN=',
    'HTTPS_PROXY=',
    'HTTP_PROXY=',
    'https_proxy=',
    'http_proxy=',
    'ANTHROPIC_API_KEY=',
    'OPENAI_API_KEY=',
    'GOOGLE_GENERATIVE_AI_API_KEY=',
    'GROQ_API_KEY=',
    'TOGETHER_AI_API_KEY=',
  ];

  const secretEnvLines: string[] = [];
  const cleanedArgs: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '-e' && i + 1 < args.length) {
      const envVal = args[i + 1];
      if (SECRET_KEY_PREFIXES.some((prefix) => envVal.startsWith(prefix))) {
        secretEnvLines.push(envVal);
        i++; // skip the value too
        continue;
      }
    }
    cleanedArgs.push(args[i]);
  }

  let envFilePath: string | null = null;
  if (secretEnvLines.length > 0) {
    envFilePath = path.join(os.tmpdir(), `nanoclaw-env-${randomUUID()}`);
    fs.writeFileSync(envFilePath, secretEnvLines.join('\n') + '\n', {
      mode: 0o600,
    });
    // Insert --env-file right after 'run' (before other flags)
    const runIdx = cleanedArgs.indexOf('run');
    cleanedArgs.splice(runIdx + 1, 0, '--env-file', envFilePath);
  }

  // Replace args contents with cleaned version
  args.length = 0;
  args.push(...cleanedArgs);

  return { args, oauthToken, envFilePath };
}

export async function runContainerAgent(
  group: RegisteredGroup,
  input: ContainerInput,
  onProcess: (proc: ChildProcess, containerName: string) => void,
  onOutput?: (output: ContainerOutput) => Promise<void>,
): Promise<ContainerOutput> {
  const groupDir = resolveGroupFolderPath(group.folder);
  fs.mkdirSync(groupDir, { recursive: true });

  const mounts = buildVolumeMounts(group, input.isMain);
  const safeName = group.folder.replace(/[^a-zA-Z0-9-]/g, '-');
  const containerName = `nanoclaw-${safeName}-${Date.now()}`;
  // Main group uses the default OneCLI agent; others use their own agent.
  const agentIdentifier = input.isMain
    ? undefined
    : group.folder.toLowerCase().replace(/_/g, '-');

  const result = await spawnContainerWithRetry(
    group,
    input,
    mounts,
    containerName,
    agentIdentifier,
    onProcess,
    onOutput,
  );
  return result;
}

/**
 * Spawn container with automatic retry on mount failures.
 * If exit code 125 (Docker config error), retry without optional mounts.
 */
async function spawnContainerWithRetry(
  group: RegisteredGroup,
  input: ContainerInput,
  mounts: VolumeMount[],
  containerName: string,
  agentIdentifier: string | undefined,
  onProcess: (proc: ChildProcess, containerName: string) => void,
  onOutput?: (output: ContainerOutput) => Promise<void>,
): Promise<ContainerOutput> {
  const {
    args: containerArgs,
    oauthToken: selectedToken,
    envFilePath,
  } = await buildContainerArgs(
    mounts,
    containerName,
    input.isMain,
    agentIdentifier,
  );

  let result: ContainerOutput;
  try {
    result = await spawnContainer(
      group,
      input,
      containerArgs,
      containerName,
      selectedToken,
      onProcess,
      onOutput,
    );
  } finally {
    // Clean up secrets tmpfile — must run even if spawnContainer throws,
    // otherwise secret-containing tmpfile is left on disk indefinitely.
    if (envFilePath) {
      try {
        fs.unlinkSync(envFilePath);
      } catch {
        /* already gone */
      }
    }
  }

  // If Docker failed with exit code 125 (mount/config error) and we have
  // optional mounts, retry without them. This prevents optional features
  // (contacts, gmail, extra dirs) from taking down the entire bot.
  if (
    result.status === 'error' &&
    result.error?.includes('code 125') &&
    mounts.some((m) => m.optional && !m._skip)
  ) {
    const skippedPaths: string[] = [];
    for (const m of mounts) {
      if (m.optional) {
        m._skip = true;
        skippedPaths.push(m.hostPath);
      }
    }
    logger.warn(
      { group: group.name, skippedMounts: skippedPaths },
      'Container failed with mount error — retrying without optional mounts',
    );

    const retryName = `${containerName}-retry`;
    const {
      args: retryArgs,
      oauthToken: retryToken,
      envFilePath: retryEnvFilePath,
    } = await buildContainerArgs(
      mounts,
      retryName,
      input.isMain,
      agentIdentifier,
    );

    let retryResult: ContainerOutput;
    try {
      retryResult = await spawnContainer(
        group,
        input,
        retryArgs,
        retryName,
        retryToken,
        onProcess,
        onOutput,
      );
    } finally {
      if (retryEnvFilePath) {
        try {
          fs.unlinkSync(retryEnvFilePath);
        } catch {
          /* already gone */
        }
      }
    }

    return retryResult;
  }

  return result;
}

async function spawnContainer(
  group: RegisteredGroup,
  input: ContainerInput,
  containerArgs: string[],
  containerName: string,
  selectedToken: string | null,
  onProcess: (proc: ChildProcess, containerName: string) => void,
  onOutput?: (output: ContainerOutput) => Promise<void>,
): Promise<ContainerOutput> {
  const startTime = Date.now();

  logger.info(
    {
      group: group.name,
      containerName,
      isMain: input.isMain,
    },
    'Spawning container agent',
  );

  const groupDir = resolveGroupFolderPath(input.groupFolder);
  const logsDir = path.join(groupDir, 'logs');
  fs.mkdirSync(logsDir, { recursive: true });

  // Track per-token cost and accumulate from streamed results
  let accumulatedCostUsd = 0;
  const originalOnOutput = onOutput;
  const trackingOnOutput = onOutput
    ? async (output: ContainerOutput) => {
        if (typeof output.totalCostUsd === 'number') {
          accumulatedCostUsd += output.totalCostUsd;
        }
        return originalOnOutput!(output);
      }
    : undefined;
  onOutput = trackingOnOutput;

  const containerPromise = new Promise<ContainerOutput>((resolve) => {
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
          `=== Mounts (from args) ===`,
          containerArgs
            .filter((a) => a.includes(':/workspace') || a.includes(':/home'))
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
          `=== Mounts (from args) ===`,
          containerArgs
            .filter((a) => a.includes(':/workspace') || a.includes(':/home'))
            .join('\n'),
          ``,
        );
        // Even on exit 0, surface MCP probe results and any MCP errors so
        // "Gmail tools offline" complaints have forensic evidence. Filter
        // to the relevant lines to keep the log small.
        const diagLines = stderr
          .split('\n')
          .filter((l) => /\[mcp-probe\]|MCP server|mcp server|gmail/i.test(l));
        if (diagLines.length > 0) {
          logLines.push(`=== MCP Diagnostics (from stderr) ===`, diagLines.join('\n'), ``);
        }
      }

      fs.writeFileSync(logFile, logLines.join('\n'));
      logger.debug({ logFile, verbose: isVerbose }, 'Container log written');

      if (code !== 0) {
        // If we already streamed a successful agent result, a non-zero exit is
        // almost always a post-response cleanup failure (OOM reaper, runtime
        // kill, SDK teardown crash). The user already received the response,
        // so surfacing a "trigger failed" error to them would be wrong.
        // Log the anomaly but resolve as success.
        if (hadStreamingOutput) {
          logger.warn(
            {
              group: group.name,
              containerName,
              code,
              duration,
              stderrTail: stderr.slice(-400),
              logFile,
            },
            'Container exited non-zero after streaming output (treated as post-response cleanup, not an agent failure)',
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

  // After container completes, report usage and detect rate limits
  return containerPromise.then((result) => {
    if (selectedToken) {
      if (accumulatedCostUsd > 0) {
        reportTokenUsage(selectedToken, accumulatedCostUsd);
      }
      if (
        result.status === 'error' &&
        result.error &&
        isRateLimitError(result.error)
      ) {
        markTokenRateLimited(selectedToken);
      }
    }
    return result;
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
  _registeredJids: Set<string>,
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

/** @internal — test helpers for token cost routing */
export function _testResetTokenState(): void {
  oauthTokenStats.clear();
  oauthTokenCache = { tokens: [], expiresAt: 0 };
  costPeriodStart = Date.now();
}

export function _testSetOAuthTokens(tokens: string[]): void {
  oauthTokenCache = { tokens, expiresAt: Date.now() + 999_999_999 };
}

export function _testAdvancePeriod(): void {
  costPeriodStart = Date.now() - COST_RESET_INTERVAL_MS - 1;
}
