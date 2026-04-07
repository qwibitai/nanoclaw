import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';

import { isErrnoException, isError, isSyntaxError } from './error-utils.js';
import { readEnvFile } from './env.js';

export interface McpConfig {
  mcpServers?: Record<string, unknown>;
}

const NOTION_MCP_URL = 'https://mcp.notion.com/mcp';
const GITHUB_MCP_URL = 'https://api.githubcopilot.com/mcp/';
const GITHUB_MCP_ENV_VAR = 'GITHUB_MCP_PAT';

function readJsonFile<T>(filePath: string): T | null {
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as T;
  } catch (err) {
    if (!isSyntaxError(err) && !isErrnoException(err, 'ENOENT')) throw err;
    return null;
  }
}

function writeJsonFile(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2) + '\n');
}

function upsertEnvFile(
  filePath: string,
  envVars: Record<string, string>,
): void {
  const existing = fs.existsSync(filePath)
    ? fs.readFileSync(filePath, 'utf-8').split(/\r?\n/)
    : [];
  const next = new Map<string, string>();

  for (const line of existing) {
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (!match) continue;
    next.set(match[1], match[2]);
  }

  for (const [key, value] of Object.entries(envVars)) {
    next.set(key, value);
  }

  const content = Array.from(next.entries())
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content ? `${content}\n` : '');
}

export function syncDirectoryEntries(
  sources: string[],
  destination: string,
): void {
  for (const source of sources) {
    if (!fs.existsSync(source)) continue;
    fs.mkdirSync(destination, { recursive: true });
    for (const entry of fs.readdirSync(source)) {
      const srcPath = path.join(source, entry);
      const dstPath = path.join(destination, entry);
      const samePath = srcPath === dstPath;
      const sameRealPath =
        fs.existsSync(dstPath) &&
        fs.realpathSync.native(srcPath) === fs.realpathSync.native(dstPath);
      if (samePath || sameRealPath) continue;
      if (fs.statSync(srcPath).isDirectory()) {
        fs.cpSync(srcPath, dstPath, { recursive: true });
      } else {
        fs.copyFileSync(srcPath, dstPath);
      }
    }
  }
}

function syncSelectedSkillDirectories(
  sources: string[],
  destination: string,
  allowedNames: Set<string>,
): void {
  for (const source of sources) {
    if (!fs.existsSync(source)) continue;
    fs.mkdirSync(destination, { recursive: true });
    for (const entry of fs.readdirSync(source)) {
      if (!allowedNames.has(entry)) continue;
      const srcPath = path.join(source, entry);
      const dstPath = path.join(destination, entry);
      if (!fs.existsSync(srcPath) || !fs.statSync(srcPath).isDirectory())
        continue;
      const samePath = srcPath === dstPath;
      const sameRealPath =
        fs.existsSync(dstPath) &&
        fs.realpathSync.native(srcPath) === fs.realpathSync.native(dstPath);
      if (samePath || sameRealPath) continue;
      fs.cpSync(srcPath, dstPath, { recursive: true });
    }
  }
}

function getSharedSkillSources(groupDir: string): string[] {
  return [
    path.join(os.homedir(), '.claude', 'skills'),
    path.join(os.homedir(), '.copilot', 'skills'),
    path.join(os.homedir(), '.gemini', 'skills'),
    path.join(os.homedir(), '.agents', 'skills'),
    path.join(groupDir, '.claude', 'skills'),
    path.join(process.cwd(), 'container', 'skills'),
  ];
}

function getGeminiWorkspaceSkillSources(groupDir: string): string[] {
  return [
    path.join(groupDir, '.claude', 'skills'),
    path.join(process.cwd(), 'container', 'skills'),
  ];
}

const COPILOT_ALLOWED_SKILLS = new Set([
  'agent-browser',
  'capabilities',
  'nanoclaw-admin',
  'notion-lecture-notes',
  'read-pdf',
  'slack-formatting',
  'status',
]);

function collectMcpConfigs(filePaths: string[]): McpConfig {
  const mergedServers: Record<string, unknown> = {};
  for (const filePath of filePaths) {
    const config = readJsonFile<McpConfig>(filePath);
    if (!config?.mcpServers || typeof config.mcpServers !== 'object') continue;
    Object.assign(mergedServers, config.mcpServers);
  }
  return Object.keys(mergedServers).length > 0
    ? { mcpServers: mergedServers }
    : {};
}

function getProjectMcpConfigPaths(groupDir: string): string[] {
  const root = process.cwd();
  const candidates = [
    path.join(root, '.mcp.json'),
    path.join(root, '.mcp.local.json'),
    path.join(groupDir, '.mcp.json'),
    path.join(groupDir, '.mcp.local.json'),
  ];
  return candidates.filter(
    (candidate, index) => candidates.indexOf(candidate) === index,
  );
}

function loadTavilyApiKey(): string | null {
  const env = readEnvFile(['TAVILY_API_KEY']);
  return env.TAVILY_API_KEY || process.env.TAVILY_API_KEY || null;
}

function getLegacyTavilyServer(
  groupDir: string,
): Record<string, unknown> | null {
  const tavilyKeyFile = path.join(groupDir, '.tavily-key');
  const tavilyBin = path.join(
    groupDir,
    'node_modules',
    'tavily-mcp',
    'build',
    'index.js',
  );
  if (!fs.existsSync(tavilyKeyFile) || !fs.existsSync(tavilyBin)) return null;
  const tavilyKey = fs.readFileSync(tavilyKeyFile, 'utf-8').trim();
  if (!tavilyKey) return null;
  return {
    command: 'node',
    args: [tavilyBin],
    env: { TAVILY_API_KEY: tavilyKey },
  };
}

function withInjectedTavilyEnv(
  server: Record<string, unknown>,
): Record<string, unknown> {
  const tavilyKey = loadTavilyApiKey();
  if (!tavilyKey || typeof server.command !== 'string') return server;
  const env =
    server.env && typeof server.env === 'object'
      ? { ...(server.env as Record<string, unknown>) }
      : {};
  if (typeof env.TAVILY_API_KEY === 'string' && env.TAVILY_API_KEY.trim()) {
    return server;
  }
  return {
    ...server,
    env: {
      ...env,
      TAVILY_API_KEY: tavilyKey,
    },
  };
}

function loadNotionToken(): string | null {
  const env = readEnvFile(['NOTION_TOKEN', 'NOTION_API_KEY']);
  return (
    env.NOTION_TOKEN ||
    env.NOTION_API_KEY ||
    process.env.NOTION_TOKEN ||
    process.env.NOTION_API_KEY ||
    null
  );
}

function getNotionServer(): Record<string, unknown> {
  const notionToken = loadNotionToken();
  if (notionToken) {
    return {
      command: 'npx',
      args: ['-y', '@notionhq/notion-mcp-server'],
      env: {
        NOTION_TOKEN: notionToken,
      },
    };
  }
  return {
    url: NOTION_MCP_URL,
  };
}

function loadGithubPatFromGh(): string | null {
  try {
    const token = execFileSync('gh', ['auth', 'token'], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return token || null;
  } catch (err) {
    if (!isError(err)) throw err;
    return null;
  }
}

export function loadGithubPat(): string | null {
  return (
    process.env.GITHUB_MCP_PAT ||
    process.env.GITHUB_PERSONAL_ACCESS_TOKEN ||
    loadGithubPatFromGh()
  );
}

function getGithubServerConfig(): Record<string, unknown> {
  return {
    httpUrl: GITHUB_MCP_URL,
    headers: {
      Authorization: `Bearer $${GITHUB_MCP_ENV_VAR}`,
    },
  };
}

export function buildMergedMcpConfig(groupDir: string): McpConfig | null {
  const merged = collectMcpConfigs(getProjectMcpConfigPaths(groupDir));
  if (
    merged.mcpServers?.tavily &&
    typeof merged.mcpServers.tavily === 'object'
  ) {
    merged.mcpServers = {
      ...merged.mcpServers,
      tavily: withInjectedTavilyEnv(
        merged.mcpServers.tavily as Record<string, unknown>,
      ),
    };
  }
  merged.mcpServers = {
    ...(merged.mcpServers || {}),
    notion: getNotionServer(),
  };
  const tavilyServer = getLegacyTavilyServer(groupDir);
  if (tavilyServer) {
    merged.mcpServers = {
      ...(merged.mcpServers || {}),
      tavily: tavilyServer,
    };
  }
  return merged.mcpServers && Object.keys(merged.mcpServers).length > 0
    ? merged
    : null;
}

function buildGeminiWorkspaceSettings(
  existing: Record<string, unknown>,
  groupDir: string,
) {
  const mergedMcpConfig = buildMergedMcpConfig(groupDir);
  const githubPat = loadGithubPat();
  const geminiMcpServers = {
    ...(mergedMcpConfig?.mcpServers || {}),
    ...(githubPat
      ? {
          github: getGithubServerConfig(),
        }
      : {}),
  };
  const existingMcp = (
    existing.mcp && typeof existing.mcp === 'object' ? existing.mcp : {}
  ) as Record<string, unknown>;

  return {
    ...existing,
    skillsSupport: true,
    mcpServers:
      Object.keys(geminiMcpServers).length > 0
        ? geminiMcpServers
        : existing.mcpServers,
    mcp: {
      ...existingMcp,
      allowed:
        Object.keys(geminiMcpServers).length > 0
          ? Object.keys(geminiMcpServers)
          : existingMcp.allowed,
    },
  };
}

export function prepareGeminiWorkspace(groupDir: string): void {
  const workspaceGeminiDir = path.join(groupDir, '.gemini');
  const workspaceAgentsDir = path.join(groupDir, '.agents');
  const agentSkillsDir = path.join(workspaceAgentsDir, 'skills');
  const skillSources = getGeminiWorkspaceSkillSources(groupDir);

  fs.rmSync(agentSkillsDir, { recursive: true, force: true });
  syncDirectoryEntries(skillSources, agentSkillsDir);
  const legacyGeminiSkillsDir = path.join(workspaceGeminiDir, 'skills');
  if (fs.existsSync(legacyGeminiSkillsDir)) {
    fs.rmSync(legacyGeminiSkillsDir, { recursive: true, force: true });
  }

  const settingsPath = path.join(workspaceGeminiDir, 'settings.json');
  const existing = readJsonFile<Record<string, unknown>>(settingsPath) || {};
  const githubPat = loadGithubPat();
  const geminiSecrets = readEnvFile([
    'GEMINI_API_KEY',
    'GEMINI_API_KEY_2',
    'GEMINI_API_KEY_3',
    'GEMINI_API_KEY_4',
    'GEMINI_API_KEY_5',
  ]);
  for (const key of [
    'GEMINI_API_KEY',
    'GEMINI_API_KEY_2',
    'GEMINI_API_KEY_3',
    'GEMINI_API_KEY_4',
    'GEMINI_API_KEY_5',
  ] as const) {
    if (!geminiSecrets[key] && process.env[key]) {
      geminiSecrets[key] = process.env[key] as string;
    }
  }
  const workspaceEnvVars: Record<string, string> = {};
  if (githubPat) {
    workspaceEnvVars[GITHUB_MCP_ENV_VAR] = githubPat;
  }
  for (const [key, value] of Object.entries(geminiSecrets)) {
    workspaceEnvVars[key] = value;
  }
  if (Object.keys(workspaceEnvVars).length > 0) {
    upsertEnvFile(path.join(workspaceGeminiDir, '.env'), workspaceEnvVars);
  }
  writeJsonFile(settingsPath, buildGeminiWorkspaceSettings(existing, groupDir));
}

function toCopilotMcpServerConfig(
  serverName: string,
  serverConfig: Record<string, unknown>,
) {
  if (typeof serverConfig.command === 'string') {
    return {
      type: 'local',
      command: serverConfig.command,
      args: Array.isArray(serverConfig.args) ? serverConfig.args : [],
      env:
        serverConfig.env && typeof serverConfig.env === 'object'
          ? serverConfig.env
          : {},
      tools: ['*'],
    };
  }

  const url =
    typeof serverConfig.httpUrl === 'string'
      ? serverConfig.httpUrl
      : typeof serverConfig.url === 'string'
        ? serverConfig.url
        : undefined;
  if (!url) return null;

  return {
    type: typeof serverConfig.httpUrl === 'string' ? 'http' : 'http',
    url,
    headers:
      serverConfig.headers && typeof serverConfig.headers === 'object'
        ? serverConfig.headers
        : {},
    tools: ['*'],
    description: serverName,
  };
}

export function buildCopilotAdditionalMcpConfig(
  groupDir: string,
): string | null {
  const merged = buildMergedMcpConfig(groupDir);
  if (!merged?.mcpServers) return null;

  const mcpServers: Record<string, unknown> = {};
  for (const [serverName, config] of Object.entries(merged.mcpServers)) {
    if (!config || typeof config !== 'object') continue;
    const normalized = toCopilotMcpServerConfig(
      serverName,
      config as Record<string, unknown>,
    );
    if (normalized) {
      mcpServers[serverName] = normalized;
    }
  }

  return Object.keys(mcpServers).length > 0
    ? JSON.stringify({ mcpServers })
    : null;
}

export function prepareCopilotWorkspace(groupDir: string): void {
  const projectSkillsDir = path.join(groupDir, '.claude', 'skills');
  fs.rmSync(projectSkillsDir, { recursive: true, force: true });
  syncSelectedSkillDirectories(
    getSharedSkillSources(groupDir),
    projectSkillsDir,
    COPILOT_ALLOWED_SKILLS,
  );

  const systemMdPath = path.join(groupDir, 'SYSTEM.md');
  const copilotInstructionsPath = path.join(
    groupDir,
    'copilot-instructions.md',
  );
  if (fs.existsSync(systemMdPath)) {
    fs.copyFileSync(systemMdPath, copilotInstructionsPath);
  }

  const copilotConfigPath = path.join(
    os.homedir(),
    '.copilot',
    'mcp-config.json',
  );
  const existing = readJsonFile<McpConfig>(copilotConfigPath) || {};
  const normalizedText = buildCopilotAdditionalMcpConfig(groupDir);
  const normalized = normalizedText
    ? (JSON.parse(normalizedText) as McpConfig)
    : { mcpServers: {} };

  writeJsonFile(copilotConfigPath, {
    ...existing,
    mcpServers: {
      ...(existing.mcpServers || {}),
      ...(normalized.mcpServers || {}),
    },
  });
}
