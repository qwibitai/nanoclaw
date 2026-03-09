/**
 * Container Runner for NanoClaw
 * Spawns agent execution in containers and handles IPC
 */
import { ChildProcess, exec, spawn } from 'child_process';
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
  PLUGIN_DIR,
  RESIDENTIAL_PROXY_URL,
  TIMEZONE,
  escapeRegex,
} from './config.js';
import { readEnvFile } from './env.js';
import { resolveGroupFolderPath, resolveGroupIpcPath } from './group-folder.js';
import { logger } from './logger.js';
import {
  CONTAINER_RUNTIME_BIN,
  readonlyMountArgs,
  stopContainer,
} from './container-runtime.js';
import { validateAdditionalMounts } from './mount-security.js';
import { RegisteredGroup } from './types.js';

// Sentinel markers for robust output parsing (must match agent-runner)
const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

// Path to Claude Code's host credentials (contains MCP OAuth tokens)
const HOST_CREDENTIALS_PATH = path.join(
  os.homedir(),
  '.claude',
  '.credentials.json',
);

const GRANOLA_TOKEN_ENDPOINT = 'https://mcp-auth.granola.ai/oauth2/token';
const GRANOLA_REFRESH_TIMEOUT_MS = 10_000;

// In-memory cache to avoid redundant disk reads / duplicate refresh calls
let granolaTokenCache: { token: string; expiresAt: number } | null = null;

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
    logger.error('Granola OAuth token expired and no refresh token available');
    return accessToken || null;
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
      logger.error(
        `Granola token refresh failed: ${resp.status} ${resp.statusText}`,
      );
      return accessToken || null;
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
    logger.error(`Granola token refresh error: ${err}`);
    return accessToken || null;
  }
}

export interface ContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  assistantName?: string;
  model?: string;
  secrets?: Record<string, string>;
  tools?: string[];
}

export interface ContainerOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  error?: string;
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

function buildVolumeMounts(
  group: RegisteredGroup,
  isMain: boolean,
): VolumeMount[] {
  const mounts: VolumeMount[] = [];
  const projectRoot = process.cwd();
  const homeDir = os.homedir();
  const groupDir = resolveGroupFolderPath(group.folder);

  if (isMain) {
    // Main gets the project root read-only. Writable paths the agent needs
    // (group folder, IPC, .claude/) are mounted separately below.
    // Read-only prevents the agent from modifying host application code
    // (src/, dist/, package.json, etc.) which would bypass the sandbox
    // entirely on next restart.
    mounts.push({
      hostPath: projectRoot,
      containerPath: '/workspace/project',
      readonly: true,
    });

    // Main also gets its group folder as the working directory
    mounts.push({
      hostPath: groupDir,
      containerPath: '/workspace/group',
      readonly: false,
    });
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
  if (!fs.existsSync(settingsFile)) {
    fs.writeFileSync(
      settingsFile,
      JSON.stringify({ env: requiredEnv }, null, 2) + '\n',
    );
  } else {
    // Ensure required env vars are present in existing settings
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
        JSON.stringify({ env: requiredEnv }, null, 2) + '\n',
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

  // Gmail credentials — gated by tools config
  if (isToolEnabled(tools, 'gmail')) {
    // Check for account-specific restriction (e.g. 'gmail:illysium')
    const gmailAccounts = tools
      ?.filter((t) => t.startsWith('gmail:'))
      .map((t) => t.split(':')[1]);
    const accountSpecific =
      gmailAccounts && gmailAccounts.length > 0 && !tools!.includes('gmail');

    if (accountSpecific) {
      // Mount only the specified account's credentials as /home/node/.gmail-mcp
      // so the Gmail MCP server finds it at its default location
      const accountDir = path.join(homeDir, `.gmail-mcp-${gmailAccounts[0]}`);
      if (fs.existsSync(accountDir)) {
        mounts.push({
          hostPath: accountDir,
          containerPath: '/home/node/.gmail-mcp',
          readonly: false,
        });
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
  // Calendar uses the same GCP OAuth app as Gmail, so mount the primary
  // Gmail OAuth keys even when gmail tool is not enabled for this group.
  if (isToolEnabled(tools, 'calendar')) {
    const calendarDir = path.join(homeDir, '.config', 'google-calendar-mcp');
    fs.mkdirSync(calendarDir, { recursive: true });
    mounts.push({
      hostPath: calendarDir,
      containerPath: '/home/node/.config/google-calendar-mcp',
      readonly: false,
    });
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

  // Snowflake credentials — gated by tools config.
  // Supports scoped access: 'snowflake' = all connections,
  // 'snowflake:sunday' or 'snowflake:apollo' = only those connections.
  if (isToolEnabled(tools, 'snowflake')) {
    const snowflakeDir = path.join(homeDir, '.snowflake');
    if (fs.existsSync(snowflakeDir)) {
      const origToml = path.join(snowflakeDir, 'connections.toml');
      if (fs.existsSync(origToml)) {
        // Determine which connections this group may access
        const allowedConns = tools
          ?.filter((t) => t.startsWith('snowflake:'))
          .map((t) => t.split(':')[1]);
        const filterConnections =
          allowedConns &&
          allowedConns.length > 0 &&
          !tools!.includes('snowflake');

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
              return allowedConns!.includes(match[1]);
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
    fs.cpSync(agentRunnerSrc, groupAgentRunnerDir, { recursive: true });
  }
  mounts.push({
    hostPath: groupAgentRunnerDir,
    containerPath: '/app/src',
    readonly: false,
  });

  // Additional mounts validated against external allowlist (tamper-proof from containers)
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

/**
 * Read allowed secrets from .env for passing to the container via stdin.
 * Secrets are never written to disk or mounted as files.
 */
function readSecrets(): Record<string, string> {
  return readEnvFile([
    'CLAUDE_CODE_OAUTH_TOKEN',
    'ANTHROPIC_API_KEY',
    'GITHUB_TOKEN',
  ]);
}

function buildContainerArgs(
  mounts: VolumeMount[],
  containerName: string,
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

  // Pass residential proxy URL for browser automation on geo-fenced sites
  if (RESIDENTIAL_PROXY_URL) {
    args.push('-e', `RESIDENTIAL_PROXY_URL=${RESIDENTIAL_PROXY_URL}`);
  }

  // Set plugin root so hook shell commands can resolve ${CLAUDE_PLUGIN_ROOT}
  if (fs.existsSync(PLUGIN_DIR)) {
    args.push('-e', 'CLAUDE_PLUGIN_ROOT=/workspace/plugin');
  }

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
): Promise<ContainerOutput> {
  const startTime = Date.now();

  const groupDir = resolveGroupFolderPath(group.folder);
  fs.mkdirSync(groupDir, { recursive: true });

  // Resolve Granola OAuth access token (refreshes if expired)
  const tools = group.containerConfig?.tools;
  let granolaAccessToken: string | undefined;
  if (isToolEnabled(tools, 'granola')) {
    granolaAccessToken = (await getGranolaAccessToken()) || undefined;
  }

  const mounts = buildVolumeMounts(group, input.isMain);

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
  const containerArgs = buildContainerArgs(mounts, containerName);

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
    input.secrets = readSecrets();
    if (granolaAccessToken) {
      input.secrets.GRANOLA_ACCESS_TOKEN = granolaAccessToken;
    }
    // Pass tools restriction so agent-runner can gate MCP servers
    input.tools = group.containerConfig?.tools;
    container.stdin.write(JSON.stringify(input));
    container.stdin.end();
    // Remove secrets from input so they don't appear in logs
    delete input.secrets;

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
