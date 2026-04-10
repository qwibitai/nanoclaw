process.env.NANOCLAW_PROCESS_ROLE ??= 'dashboard';

import { spawn, ChildProcess } from 'child_process';
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';

import './channels/index.js';
import { ASSISTANT_NAME, DATA_DIR } from './config.js';
import {
  DASHBOARD_EVENTS_FILE,
  DASHBOARD_RUNTIME_FILE,
} from './dashboard-state.js';
import { getRegisteredChannelNames } from './channels/registry.js';
import {
  getAllChats,
  getAllRegisteredGroups,
  getAllTasks,
  getMessagesSince,
  getRecentTaskRunLogs,
  getRouterState,
  initDatabase,
} from './db.js';
import { applySupportedEnvAliases } from './env.js';
import { logger } from './logger.js';

applySupportedEnvAliases();

interface DashboardRuntimeState {
  role: 'agent';
  pid: number;
  status: 'starting' | 'running' | 'shutting_down' | 'stopped' | 'error';
  startedAt: string;
  updatedAt: string;
  heartbeatAt: string;
  defaultTrigger: string;
  channels: Array<{ name: string; connected: boolean }>;
  queue: {
    activeCount: number;
    waitingGroups: string[];
    groups: Record<
      string,
      {
        active: boolean;
        idleWaiting: boolean;
        isTaskContainer: boolean;
        runningTaskId: string | null;
        pendingMessages: boolean;
        pendingTaskCount: number;
        containerName: string | null;
        groupFolder: string | null;
        retryCount: number;
      }
    >;
  };
}

interface DashboardEvent {
  at: string;
  pid: number;
  level: string;
  role: string;
  msg: string;
  data?: Record<string, unknown>;
}

interface SkillSummary {
  id: string;
  name: string;
  description: string;
  source: 'system' | 'plugin' | 'repo';
  enabled: boolean;
  app: string | null;
  plugin: string | null;
  manifestPath: string;
}

interface AppSummary {
  id: string;
  name: string;
  enabled: boolean;
  skillCount: number;
  source: 'plugin' | 'system' | 'repo';
  note: string;
}

const PORT = parseInt(process.env.NANOCLAW_DASHBOARD_PORT || '4780', 10);
const HOST = process.env.NANOCLAW_DASHBOARD_HOST || '127.0.0.1';
const HEARTBEAT_STALE_MS = 5000;
const MAX_LOG_EVENTS = 80;
const DASHBOARD_STATE_DIR = path.join(DATA_DIR, 'dashboard');
const CODEX_HOME = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
const SYSTEM_SKILLS_DIR = path.join(CODEX_HOME, 'skills', '.system');
const CURATED_PLUGINS_DIR = path.join(
  CODEX_HOME,
  'plugins',
  'cache',
  'openai-curated',
);
const REPO_SKILLS_DIR = path.join(process.cwd(), '.claude', 'skills');

let managedAgent: ChildProcess | null = null;
let managedAgentStartedAt: string | null = null;
let managedAgentCommand: string[] = [];
let managedAgentStatusMessage: string | null = null;
let managedAgentLastExit: {
  at: string;
  code: number | null;
  signal: NodeJS.Signals | null;
} | null = null;
let managedAgentOutput: Array<{
  at: string;
  stream: 'stdout' | 'stderr';
  line: string;
}> = [];

const sseClients = new Set<http.ServerResponse>();

function json(
  response: http.ServerResponse,
  statusCode: number,
  body: unknown,
): void {
  response.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
  });
  response.end(JSON.stringify(body));
}

function readJsonFile<T>(filePath: string): T | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T;
  } catch {
    return null;
  }
}

function readRecentEvents(limit: number): DashboardEvent[] {
  try {
    if (!fs.existsSync(DASHBOARD_EVENTS_FILE)) return [];
    const lines = fs
      .readFileSync(DASHBOARD_EVENTS_FILE, 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean);
    return lines
      .slice(-limit)
      .map((line) => JSON.parse(line) as DashboardEvent)
      .filter((entry) => entry.role === 'agent');
  } catch {
    return [];
  }
}

function appendManagedOutput(
  stream: 'stdout' | 'stderr',
  chunk: Buffer | string,
): void {
  const text = chunk.toString();
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    managedAgentOutput.push({
      at: new Date().toISOString(),
      stream,
      line,
    });
  }
  managedAgentOutput = managedAgentOutput.slice(-50);
}

function getAgentCommand(): { command: string; args: string[] } {
  const projectRoot = process.cwd();
  const distEntry = path.join(projectRoot, 'dist', 'index.js');
  const srcDir = path.join(projectRoot, 'src');

  const newestMtime = (dirPath: string): number => {
    let newest = 0;
    if (!fs.existsSync(dirPath)) return newest;
    for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
      const fullPath = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        newest = Math.max(newest, newestMtime(fullPath));
      } else {
        newest = Math.max(newest, fs.statSync(fullPath).mtimeMs);
      }
    }
    return newest;
  };

  const distIsFresh =
    fs.existsSync(distEntry) &&
    fs.statSync(distEntry).mtimeMs >= newestMtime(srcDir);

  const tsxBin = path.join(
    projectRoot,
    'node_modules',
    '.bin',
    process.platform === 'win32' ? 'tsx.cmd' : 'tsx',
  );

  if (
    (!distIsFresh || process.env.NANOCLAW_PREFER_TSX === '1') &&
    fs.existsSync(tsxBin)
  ) {
    return { command: tsxBin, args: ['src/index.ts'] };
  }

  if (fs.existsSync(distEntry)) {
    return { command: process.execPath, args: [distEntry] };
  }

  if (fs.existsSync(tsxBin)) {
    return { command: tsxBin, args: ['src/index.ts'] };
  }

  return {
    command: process.platform === 'win32' ? 'npm.cmd' : 'npm',
    args: ['run', 'dev'],
  };
}

function loadRuntimeStatus(): DashboardRuntimeState | null {
  return readJsonFile<DashboardRuntimeState>(DASHBOARD_RUNTIME_FILE);
}

function getStartupBlocker(): string | null {
  const installedChannels = getRegisteredChannelNames();
  if (installedChannels.length === 0) {
    return 'No channel integrations are installed in this fork, so the NanoClaw agent exits immediately. Add Telegram support first, then start the agent again.';
  }
  if (process.env.NANOCLAW_MODEL && !process.env.ANTHROPIC_AUTH_TOKEN) {
    return 'A model is configured, but no provider API key is loaded. Fill in OPEN-REUTER in .env, restart the dashboard, then start the agent again.';
  }
  return null;
}

function isHeartbeatFresh(runtime: DashboardRuntimeState | null): boolean {
  if (!runtime) return false;
  const ageMs = Date.now() - Date.parse(runtime.heartbeatAt);
  return Number.isFinite(ageMs) && ageMs >= 0 && ageMs <= HEARTBEAT_STALE_MS;
}

function extractFrontmatterValue(source: string, key: string): string | null {
  const match = source.match(
    new RegExp(`^${key}:\\s*["']?(.+?)["']?\\s*$`, 'm'),
  );
  return match ? match[1].trim() : null;
}

function readSkillManifest(manifestPath: string): {
  name: string | null;
  description: string | null;
} {
  try {
    const content = fs.readFileSync(manifestPath, 'utf8');
    return {
      name: extractFrontmatterValue(content, 'name'),
      description: extractFrontmatterValue(content, 'description'),
    };
  } catch {
    return { name: null, description: null };
  }
}

function listSkillManifestPaths(rootDir: string): string[] {
  if (!fs.existsSync(rootDir)) return [];
  const manifests: string[] = [];

  const walk = (dirPath: string): void => {
    for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
      const fullPath = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
        continue;
      }
      if (entry.isFile() && entry.name === 'SKILL.md') {
        manifests.push(fullPath);
      }
    }
  };

  walk(rootDir);
  return manifests.sort();
}

function collectSkillSummaries(): SkillSummary[] {
  const skills: SkillSummary[] = [];

  for (const manifestPath of listSkillManifestPaths(SYSTEM_SKILLS_DIR)) {
    const meta = readSkillManifest(manifestPath);
    const dirName = path.basename(path.dirname(manifestPath));
    skills.push({
      id: `system:${dirName}`,
      name: meta.name || dirName,
      description: meta.description || 'No description found.',
      source: 'system',
      enabled: true,
      app: null,
      plugin: null,
      manifestPath,
    });
  }

  for (const manifestPath of listSkillManifestPaths(REPO_SKILLS_DIR)) {
    const meta = readSkillManifest(manifestPath);
    const dirName = path.basename(path.dirname(manifestPath));
    skills.push({
      id: `repo:${dirName}`,
      name: meta.name || dirName,
      description: meta.description || 'No description found.',
      source: 'repo',
      enabled: true,
      app: null,
      plugin: null,
      manifestPath,
    });
  }

  if (fs.existsSync(CURATED_PLUGINS_DIR)) {
    for (const pluginName of fs.readdirSync(CURATED_PLUGINS_DIR)) {
      const pluginDir = path.join(CURATED_PLUGINS_DIR, pluginName);
      if (!fs.statSync(pluginDir).isDirectory()) continue;

      const versionDirs = fs
        .readdirSync(pluginDir)
        .map((entry) => path.join(pluginDir, entry))
        .filter((fullPath) => fs.statSync(fullPath).isDirectory())
        .sort();
      const latestVersionDir = versionDirs.at(-1);
      if (!latestVersionDir) continue;

      const skillsDir = path.join(latestVersionDir, 'skills');
      for (const manifestPath of listSkillManifestPaths(skillsDir)) {
        const meta = readSkillManifest(manifestPath);
        const dirName = path.basename(path.dirname(manifestPath));
        skills.push({
          id: `plugin:${pluginName}:${dirName}`,
          name: meta.name || dirName,
          description: meta.description || 'No description found.',
          source: 'plugin',
          enabled: true,
          app: pluginName,
          plugin: pluginName,
          manifestPath,
        });
      }
    }
  }

  return skills;
}

function collectAppSummaries(skills: SkillSummary[]): AppSummary[] {
  const apps: AppSummary[] = [];
  const pluginGroups = new Map<string, SkillSummary[]>();

  for (const skill of skills) {
    if (!skill.plugin) continue;
    const group = pluginGroups.get(skill.plugin) || [];
    group.push(skill);
    pluginGroups.set(skill.plugin, group);
  }

  for (const [plugin, pluginSkills] of [...pluginGroups.entries()].sort()) {
    apps.push({
      id: plugin,
      name: plugin.charAt(0).toUpperCase() + plugin.slice(1),
      enabled: true,
      skillCount: pluginSkills.length,
      source: 'plugin',
      note: `Provides ${pluginSkills.length} dashboard-visible skill${pluginSkills.length === 1 ? '' : 's'}.`,
    });
  }

  apps.push({
    id: 'codex-system',
    name: 'Codex System',
    enabled: true,
    skillCount: skills.filter((skill) => skill.source === 'system').length,
    source: 'system',
    note: 'Built-in local skills installed under ~/.codex/skills/.system.',
  });

  apps.push({
    id: 'nanoclaw-repo',
    name: 'NanoClaw Repo',
    enabled: true,
    skillCount: skills.filter((skill) => skill.source === 'repo').length,
    source: 'repo',
    note: 'Project-local skills installed under .claude/skills.',
  });

  return apps;
}

function startAgent(): { ok: boolean; message: string } {
  const runtime = loadRuntimeStatus();
  const blocker = getStartupBlocker();
  if (blocker) {
    managedAgentStatusMessage = blocker;
    broadcastSnapshot();
    return { ok: false, message: blocker };
  }
  if (managedAgent && managedAgent.exitCode === null) {
    return {
      ok: false,
      message: 'Agent is already running under dashboard control.',
    };
  }
  if (runtime && isHeartbeatFresh(runtime) && runtime.status !== 'stopped') {
    return {
      ok: false,
      message: `Agent already appears to be running with PID ${runtime.pid}.`,
    };
  }

  const { command, args } = getAgentCommand();
  const child = spawn(command, args, {
    cwd: process.cwd(),
    env: {
      ...process.env,
      NANOCLAW_PROCESS_ROLE: 'agent',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  managedAgent = child;
  managedAgentStartedAt = new Date().toISOString();
  managedAgentCommand = [command, ...args];
  managedAgentStatusMessage =
    'Agent process spawned. Waiting for runtime heartbeat.';
  managedAgentLastExit = null;
  managedAgentOutput = [];

  child.stdout.on('data', (chunk) => appendManagedOutput('stdout', chunk));
  child.stderr.on('data', (chunk) => appendManagedOutput('stderr', chunk));
  child.on('exit', (code, signal) => {
    managedAgentLastExit = {
      at: new Date().toISOString(),
      code,
      signal,
    };
    managedAgentStatusMessage =
      code === 0
        ? 'Agent process exited cleanly.'
        : `Agent process exited before the dashboard received a healthy heartbeat${code === null ? '' : ` (code ${code})`}${signal ? `, signal ${signal}` : ''}.`;
    managedAgent = null;
    broadcastSnapshot();
  });

  broadcastSnapshot();
  return {
    ok: true,
    message: `Started agent with ${managedAgentCommand.join(' ')}.`,
  };
}

function stopAgent(): { ok: boolean; message: string } {
  if (!managedAgent || managedAgent.exitCode !== null) {
    return { ok: false, message: 'No dashboard-managed agent is running.' };
  }
  managedAgentStatusMessage = 'Stopping dashboard-managed agent.';
  managedAgent.kill('SIGTERM');
  return { ok: true, message: 'Sent SIGTERM to the dashboard-managed agent.' };
}

function buildSnapshot(): Record<string, unknown> {
  const runtime = loadRuntimeStatus();
  const registeredGroups = getAllRegisteredGroups();
  const chats = new Map(getAllChats().map((chat) => [chat.jid, chat]));
  const tasks = getAllTasks();
  const taskLogs = getRecentTaskRunLogs(12);
  const skills = collectSkillSummaries();
  const apps = collectAppSummaries(skills);

  let lastAgentTimestamp: Record<string, string> = {};
  try {
    const raw = getRouterState('last_agent_timestamp');
    lastAgentTimestamp = raw ? (JSON.parse(raw) as Record<string, string>) : {};
  } catch {
    lastAgentTimestamp = {};
  }

  const groups = Object.entries(registeredGroups).map(([jid, group]) => {
    const chat = chats.get(jid);
    const queueState = runtime?.queue.groups[jid];
    const cursor = lastAgentTimestamp[jid] || '';
    const pendingCount = getMessagesSince(
      jid,
      cursor,
      ASSISTANT_NAME,
      50,
    ).length;

    return {
      jid,
      name: group.name,
      folder: group.folder,
      trigger: group.trigger,
      isMain: group.isMain === true,
      requiresTrigger: group.requiresTrigger !== false,
      lastChatActivity: chat?.last_message_time || null,
      lastAgentTimestamp: cursor || null,
      pendingCount,
      runtime: queueState
        ? {
            active: queueState.active,
            idleWaiting: queueState.idleWaiting,
            isTaskContainer: queueState.isTaskContainer,
            pendingMessages: queueState.pendingMessages,
            pendingTaskCount: queueState.pendingTaskCount,
            runningTaskId: queueState.runningTaskId,
            retryCount: queueState.retryCount,
          }
        : null,
    };
  });

  const fresh = isHeartbeatFresh(runtime);
  const runtimeStatus =
    runtime && fresh ? runtime.status : runtime ? 'stale' : 'offline';

  const recentEvents = readRecentEvents(MAX_LOG_EVENTS).filter((entry) =>
    runtime?.pid ? entry.pid === runtime.pid : true,
  );

  const recentMessages = groups
    .flatMap((group) =>
      getMessagesSince(group.jid, '', ASSISTANT_NAME, 8).map((message) => ({
        id: `${group.jid}:${message.id}`,
        chatJid: group.jid,
        groupName: group.name,
        senderName: message.sender_name,
        content: message.content,
        timestamp: message.timestamp,
        isFromMe: message.is_from_me === true,
        isBotMessage: message.is_bot_message === true,
      })),
    )
    .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
    .slice(0, 20);

  return {
    generatedAt: new Date().toISOString(),
    runtime: runtime
      ? {
          ...runtime,
          freshnessMs: Date.now() - Date.parse(runtime.heartbeatAt),
          health: runtimeStatus,
        }
      : null,
    dashboard: {
      pid: process.pid,
      host: HOST,
      port: PORT,
      installedChannels: getRegisteredChannelNames(),
      startupBlocker: getStartupBlocker(),
      managedAgent: managedAgent
        ? {
            pid: managedAgent.pid,
            startedAt: managedAgentStartedAt,
            command: managedAgentCommand,
            running: managedAgent.exitCode === null,
            recentOutput: managedAgentOutput,
          }
        : null,
      managedAgentStatusMessage,
      managedAgentLastExit,
    },
    summary: {
      groups: groups.length,
      tasks: tasks.length,
      activeContainers: runtime?.queue.activeCount ?? 0,
      waitingGroups: runtime?.queue.waitingGroups.length ?? 0,
      connectedChannels:
        runtime?.channels.filter((channel) => channel.connected).length ?? 0,
      skills: skills.length,
      apps: apps.length,
    },
    groups,
    skills,
    apps,
    tasks,
    taskLogs,
    recentMessages,
    recentEvents,
  };
}

function broadcastSnapshot(): void {
  const payload = `data: ${JSON.stringify(buildSnapshot())}\n\n`;
  for (const client of sseClients) {
    client.write(payload);
  }
}

const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>NanoClaw Live Dashboard</title>
  <style>
    :root {
      --bg: #0e1418;
      --panel: rgba(18, 31, 39, 0.82);
      --panel-strong: rgba(24, 43, 54, 0.92);
      --line: rgba(142, 193, 177, 0.18);
      --text: #ecf4ef;
      --muted: #9db7b0;
      --accent: #54d4a7;
      --warn: #ffb95c;
      --danger: #ff6f61;
      --shadow: 0 20px 60px rgba(0, 0, 0, 0.35);
      --radius: 20px;
      --mono: "SFMono-Regular", "SF Mono", "Cascadia Code", monospace;
      --sans: "Avenir Next", "Segoe UI", sans-serif;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: var(--sans);
      color: var(--text);
      background:
        radial-gradient(circle at top left, rgba(84, 212, 167, 0.18), transparent 30%),
        radial-gradient(circle at top right, rgba(255, 185, 92, 0.16), transparent 28%),
        linear-gradient(180deg, #071014 0%, #0f1c23 55%, #081115 100%);
      min-height: 100vh;
    }
    .shell {
      max-width: 1400px;
      margin: 0 auto;
      padding: 32px 20px 48px;
    }
    .hero {
      display: grid;
      grid-template-columns: 1.5fr 1fr;
      gap: 18px;
      align-items: stretch;
      margin-bottom: 18px;
    }
    .panel {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: var(--radius);
      box-shadow: var(--shadow);
      backdrop-filter: blur(18px);
    }
    .hero-main {
      padding: 28px;
      position: relative;
      overflow: hidden;
    }
    .hero-main::after {
      content: "";
      position: absolute;
      inset: auto -120px -120px auto;
      width: 300px;
      height: 300px;
      background: radial-gradient(circle, rgba(84, 212, 167, 0.2), transparent 70%);
      pointer-events: none;
    }
    h1, h2, h3, p { margin: 0; }
    .eyebrow {
      letter-spacing: 0.16em;
      text-transform: uppercase;
      color: var(--muted);
      font-size: 12px;
      margin-bottom: 10px;
    }
    .headline {
      font-size: clamp(32px, 5vw, 58px);
      line-height: 0.95;
      margin-bottom: 10px;
    }
    .subhead {
      color: var(--muted);
      max-width: 58ch;
      line-height: 1.5;
      margin-bottom: 24px;
    }
    .quick-stats {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 12px;
    }
    .stat {
      padding: 14px;
      border-radius: 16px;
      background: rgba(255, 255, 255, 0.03);
      border: 1px solid rgba(255, 255, 255, 0.05);
    }
    .stat strong {
      display: block;
      font-size: 26px;
      margin-bottom: 4px;
    }
    .stat span {
      color: var(--muted);
      font-size: 13px;
    }
    .hero-side {
      padding: 24px;
      display: flex;
      flex-direction: column;
      gap: 18px;
      justify-content: space-between;
    }
    .status-row {
      display: flex;
      align-items: center;
      gap: 12px;
      margin-bottom: 14px;
    }
    .status-dot {
      width: 14px;
      height: 14px;
      border-radius: 999px;
      background: var(--accent);
      box-shadow: 0 0 0 0 rgba(84, 212, 167, 0.5);
      animation: pulse 1.6s infinite;
    }
    .status-dot.warn { background: var(--warn); box-shadow: 0 0 0 0 rgba(255, 185, 92, 0.45); }
    .status-dot.danger { background: var(--danger); box-shadow: 0 0 0 0 rgba(255, 111, 97, 0.45); }
    .controls {
      display: flex;
      gap: 12px;
      flex-wrap: wrap;
    }
    button {
      appearance: none;
      border: 0;
      border-radius: 999px;
      padding: 12px 18px;
      font: inherit;
      cursor: pointer;
      transition: transform 160ms ease, opacity 160ms ease, background 160ms ease;
    }
    button:hover { transform: translateY(-1px); }
    button.primary { background: var(--accent); color: #082218; font-weight: 700; }
    button.secondary { background: rgba(255,255,255,0.08); color: var(--text); }
    .message {
      min-height: 20px;
      color: var(--muted);
      font-size: 13px;
    }
    .grid {
      display: grid;
      grid-template-columns: 1.2fr 1fr;
      gap: 18px;
      margin-top: 18px;
    }
    .stack {
      display: grid;
      gap: 18px;
    }
    .section {
      padding: 22px;
    }
    .section-head {
      display: flex;
      align-items: baseline;
      justify-content: space-between;
      margin-bottom: 16px;
    }
    .section-head p {
      color: var(--muted);
      font-size: 13px;
    }
    .cards {
      display: grid;
      gap: 12px;
    }
    .group-card, .task-card, .event-row {
      background: var(--panel-strong);
      border: 1px solid rgba(255,255,255,0.04);
      border-radius: 16px;
      padding: 16px;
      transition: transform 220ms ease, border-color 220ms ease, opacity 220ms ease;
      transform: translateY(0);
    }
    .group-card.updated, .task-card.updated, .event-row.updated {
      border-color: rgba(84, 212, 167, 0.45);
      transform: translateY(-2px);
    }
    .card-top {
      display: flex;
      justify-content: space-between;
      gap: 12px;
      align-items: flex-start;
      margin-bottom: 10px;
    }
    .card-title {
      font-size: 19px;
      margin-bottom: 4px;
    }
    .meta, .mono {
      color: var(--muted);
      font-size: 12px;
    }
    .mono {
      font-family: var(--mono);
      line-height: 1.45;
      word-break: break-word;
    }
    .pill-row {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin-top: 10px;
    }
    .pill {
      padding: 7px 10px;
      border-radius: 999px;
      font-size: 12px;
      background: rgba(255,255,255,0.06);
      color: var(--text);
    }
    .pill.good { background: rgba(84, 212, 167, 0.12); color: #9bf0ce; }
    .pill.warn { background: rgba(255, 185, 92, 0.14); color: #ffd28d; }
    .pill.danger { background: rgba(255, 111, 97, 0.14); color: #ffb5ad; }
    .event-row {
      display: grid;
      grid-template-columns: 88px 72px 1fr;
      gap: 10px;
      align-items: start;
      font-size: 13px;
    }
    .event-row .msg { line-height: 1.45; }
    .event-level {
      text-transform: uppercase;
      letter-spacing: 0.08em;
      color: var(--muted);
      font-size: 11px;
    }
    .empty {
      color: var(--muted);
      padding: 16px 0 4px;
    }
    @keyframes pulse {
      0% { box-shadow: 0 0 0 0 currentColor; }
      70% { box-shadow: 0 0 0 14px rgba(0,0,0,0); }
      100% { box-shadow: 0 0 0 0 rgba(0,0,0,0); }
    }
    @media (max-width: 1100px) {
      .hero, .grid { grid-template-columns: 1fr; }
    }
    @media (max-width: 720px) {
      .quick-stats { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .event-row { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <div class="shell">
    <section class="hero">
      <div class="panel hero-main">
        <div class="eyebrow">NanoClaw Control Surface</div>
        <h1 class="headline">Live agent status with motion, queue depth, and recent activity.</h1>
        <p class="subhead">This dashboard reads NanoClaw's runtime heartbeat and database in real time, so you can see what the agent is doing and start or stop it without opening another terminal.</p>
        <div class="quick-stats" id="quick-stats"></div>
      </div>
      <aside class="panel hero-side">
        <div>
          <div class="status-row">
            <div id="status-dot" class="status-dot"></div>
            <div>
              <div id="status-label" class="card-title">Checking runtime…</div>
              <div id="status-meta" class="meta"></div>
            </div>
          </div>
          <div class="mono" id="runtime-command"></div>
        </div>
        <div class="controls">
          <button id="start-button" class="primary">Start Agent</button>
          <button id="stop-button" class="secondary">Stop Agent</button>
        </div>
        <div id="action-message" class="message"></div>
      </aside>
    </section>

    <section class="grid">
      <div class="stack">
        <div class="panel section">
          <div class="section-head">
            <div>
              <h2>Launcher</h2>
              <p>What the dashboard tried to start, plus the last startup error.</p>
            </div>
          </div>
          <div id="launcher" class="cards"></div>
        </div>
        <div class="panel section">
          <div class="section-head">
            <div>
              <h2>Groups</h2>
              <p>Each registered group, its queue state, and whether messages are waiting.</p>
            </div>
          </div>
          <div id="groups" class="cards"></div>
        </div>
        <div class="panel section">
          <div class="section-head">
            <div>
              <h2>Activity Feed</h2>
              <p>Recent runtime events written by the agent process.</p>
            </div>
          </div>
          <div id="events" class="cards"></div>
        </div>
        <div class="panel section">
          <div class="section-head">
            <div>
              <h2>Telegram Feed</h2>
              <p>Recent chat messages seen by NanoClaw.</p>
            </div>
          </div>
          <div id="messages" class="cards"></div>
        </div>
      </div>

      <div class="stack">
        <div class="panel section">
          <div class="section-head">
            <div>
              <h2>Scheduler</h2>
              <p>Tasks, next run times, and recent task executions.</p>
            </div>
          </div>
          <div id="tasks" class="cards"></div>
          <div id="task-logs" class="cards" style="margin-top:12px;"></div>
        </div>
        <div class="panel section">
          <div class="section-head">
            <div>
              <h2>Apps & Skills</h2>
              <p>Local plugin apps, built-in skills, and what each one enables.</p>
            </div>
          </div>
          <div id="apps" class="cards"></div>
          <div id="skills" class="cards" style="margin-top:12px;"></div>
        </div>
      </div>
    </section>
  </div>
  <script>
    const state = {
      previousJson: new Map(),
    };

    function escapeHtml(value) {
      return String(value ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;');
    }

    function formatTime(value) {
      if (!value) return 'n/a';
      const date = new Date(value);
      if (Number.isNaN(date.getTime())) return value;
      return date.toLocaleString();
    }

    function formatAge(value) {
      if (!value) return 'n/a';
      const seconds = Math.max(0, Math.round((Date.now() - new Date(value).getTime()) / 1000));
      if (seconds < 60) return seconds + 's ago';
      const minutes = Math.round(seconds / 60);
      if (minutes < 60) return minutes + 'm ago';
      const hours = Math.round(minutes / 60);
      if (hours < 24) return hours + 'h ago';
      return Math.round(hours / 24) + 'd ago';
    }

    function highlightIfChanged(id, value) {
      const next = JSON.stringify(value);
      const changed = state.previousJson.get(id) !== next;
      state.previousJson.set(id, next);
      return changed ? 'updated' : '';
    }

    function renderStats(snapshot) {
      const stats = [
        ['Groups', snapshot.summary.groups],
        ['Tasks', snapshot.summary.tasks],
        ['Active Containers', snapshot.summary.activeContainers],
        ['Connected Channels', snapshot.summary.connectedChannels],
        ['Skills', snapshot.summary.skills],
        ['Apps', snapshot.summary.apps],
      ];
      document.getElementById('quick-stats').innerHTML = stats
        .map(([label, value]) => '<div class="stat"><strong>' + escapeHtml(value) + '</strong><span>' + escapeHtml(label) + '</span></div>')
        .join('');
    }

    function renderRuntime(snapshot) {
      const runtime = snapshot.runtime;
      const managed = snapshot.dashboard.managedAgent;
      const health = runtime ? runtime.health : 'offline';
      const label = runtime ? runtime.status : 'offline';
      const dot = document.getElementById('status-dot');
      dot.className = 'status-dot';
      if (health === 'stale' || label === 'starting' || label === 'shutting_down') {
        dot.classList.add('warn');
      }
      if (health === 'offline' || label === 'error') {
        dot.classList.add('danger');
      }

      document.getElementById('status-label').textContent =
        'Agent status: ' + label;
      document.getElementById('status-meta').textContent = runtime
        ? 'PID ' + runtime.pid + ' • heartbeat ' + formatAge(runtime.heartbeatAt)
        : 'No runtime heartbeat found yet';
      document.getElementById('runtime-command').textContent = managed
        ? managed.command.join(' ')
        : 'Dashboard will start the agent using the local NanoClaw entrypoint.';
    }

    function groupPills(group) {
      const pills = [];
      if (group.isMain) pills.push('<span class="pill good">main group</span>');
      if (group.runtime?.active) pills.push('<span class="pill good">' + (group.runtime.isTaskContainer ? 'task running' : 'agent active') + '</span>');
      if (group.runtime?.idleWaiting) pills.push('<span class="pill">idle wait</span>');
      if (group.runtime?.pendingMessages) pills.push('<span class="pill warn">pending message signal</span>');
      if ((group.runtime?.pendingTaskCount || 0) > 0) pills.push('<span class="pill warn">' + group.runtime.pendingTaskCount + ' queued task(s)</span>');
      if (group.pendingCount > 0) pills.push('<span class="pill warn">' + group.pendingCount + ' message(s) waiting</span>');
      if ((group.runtime?.retryCount || 0) > 0) pills.push('<span class="pill danger">retry ' + group.runtime.retryCount + '</span>');
      if (pills.length === 0) pills.push('<span class="pill">quiet</span>');
      return pills.join('');
    }

    function renderGroups(snapshot) {
      const groups = snapshot.groups;
      const root = document.getElementById('groups');
      if (!groups.length) {
        root.innerHTML = '<div class="empty">No registered groups yet.</div>';
        return;
      }
      root.innerHTML = groups.map((group) => {
        const changed = highlightIfChanged('group:' + group.jid, group);
        return '<article class="group-card ' + changed + '">' +
          '<div class="card-top">' +
            '<div>' +
              '<div class="card-title">' + escapeHtml(group.name) + '</div>' +
              '<div class="meta">' + escapeHtml(group.folder) + ' • ' + escapeHtml(group.jid) + '</div>' +
            '</div>' +
            '<div class="meta">' + (group.requiresTrigger ? 'trigger: ' + escapeHtml(group.trigger) : 'trigger disabled') + '</div>' +
          '</div>' +
          '<div class="mono">Last chat activity: ' + escapeHtml(formatTime(group.lastChatActivity)) + '<br>Last agent cursor: ' + escapeHtml(formatTime(group.lastAgentTimestamp)) + '</div>' +
          '<div class="pill-row">' + groupPills(group) + '</div>' +
        '</article>';
      }).join('');
    }

    function renderLauncher(snapshot) {
      const root = document.getElementById('launcher');
      const dashboard = snapshot.dashboard;
      const managed = dashboard.managedAgent;
      const blocker = dashboard.startupBlocker;
      const statusMessage = dashboard.managedAgentStatusMessage;
      const lastExit = dashboard.managedAgentLastExit;
      const installed = dashboard.installedChannels || [];

      const cards = [];

      cards.push(
        '<article class="task-card ' + highlightIfChanged('launcher:state', dashboard) + '">' +
          '<div class="card-top">' +
            '<div class="card-title">Installed channels</div>' +
            '<div class="pill ' + (installed.length ? 'good' : 'danger') + '">' + installed.length + '</div>' +
          '</div>' +
          '<div class="mono">' + escapeHtml(installed.length ? installed.join(', ') : 'none') + '</div>' +
          '<div class="pill-row">' +
            (blocker
              ? '<span class="pill danger">' + escapeHtml(blocker) + '</span>'
              : '<span class="pill good">startup allowed</span>') +
          '</div>' +
        '</article>'
      );

      cards.push(
        '<article class="task-card ' + highlightIfChanged('launcher:managed', managed || lastExit || statusMessage) + '">' +
          '<div class="card-top">' +
            '<div class="card-title">Managed agent</div>' +
            '<div class="pill ' + (managed ? 'good' : lastExit ? 'danger' : 'warn') + '">' + escapeHtml(managed ? 'running' : lastExit ? 'exited' : 'idle') + '</div>' +
          '</div>' +
          '<div class="mono">' +
            escapeHtml(
              managed
                ? managed.command.join(' ')
                : statusMessage || 'Dashboard has not launched an agent process yet.'
            ) +
          '</div>' +
          (lastExit
            ? '<div class="pill-row"><span class="pill danger">last exit: ' + escapeHtml(formatTime(lastExit.at)) + '</span><span class="pill danger">code: ' + escapeHtml(lastExit.code ?? 'null') + '</span><span class="pill danger">signal: ' + escapeHtml(lastExit.signal ?? 'none') + '</span></div>'
            : '') +
        '</article>'
      );

      if (managed?.recentOutput?.length) {
        cards.push(
          '<article class="task-card ' + highlightIfChanged('launcher:output', managed.recentOutput) + '">' +
            '<div class="card-top"><div class="card-title">Recent process output</div></div>' +
            '<div class="mono">' +
              managed.recentOutput
                .slice(-12)
                .map((entry) => '[' + new Date(entry.at).toLocaleTimeString() + '] ' + entry.stream + ': ' + entry.line)
                .map(escapeHtml)
                .join('<br>') +
            '</div>' +
          '</article>'
        );
      }

      root.innerHTML = cards.join('');
    }

    function renderTasks(snapshot) {
      const root = document.getElementById('tasks');
      if (!snapshot.tasks.length) {
        root.innerHTML = '<div class="empty">No scheduled tasks found.</div>';
      } else {
        root.innerHTML = snapshot.tasks.map((task) => {
          const changed = highlightIfChanged('task:' + task.id, task);
          const statusClass =
            task.status === 'active' ? 'good' : task.status === 'paused' ? 'warn' : 'danger';
          return '<article class="task-card ' + changed + '">' +
            '<div class="card-top">' +
              '<div>' +
                '<div class="card-title">' + escapeHtml(task.group_folder) + '</div>' +
                '<div class="meta">' + escapeHtml(task.schedule_type) + ' • ' + escapeHtml(task.schedule_value) + '</div>' +
              '</div>' +
              '<div class="pill ' + statusClass + '">' + escapeHtml(task.status) + '</div>' +
            '</div>' +
            '<div class="mono">' + escapeHtml(task.prompt) + '</div>' +
            '<div class="pill-row">' +
              '<span class="pill">next: ' + escapeHtml(formatTime(task.next_run)) + '</span>' +
              '<span class="pill">last: ' + escapeHtml(formatTime(task.last_run)) + '</span>' +
            '</div>' +
          '</article>';
        }).join('');
      }

      const logsRoot = document.getElementById('task-logs');
      if (!snapshot.taskLogs.length) {
        logsRoot.innerHTML = '';
        return;
      }
      logsRoot.innerHTML = snapshot.taskLogs.map((log) => {
        const changed = highlightIfChanged('task-log:' + log.task_id + ':' + log.run_at, log);
        const statusClass = log.status === 'success' ? 'good' : 'danger';
        return '<article class="task-card ' + changed + '">' +
          '<div class="card-top">' +
            '<div class="card-title">' + escapeHtml(log.task_id) + '</div>' +
            '<div class="pill ' + statusClass + '">' + escapeHtml(log.status) + '</div>' +
          '</div>' +
          '<div class="meta">' + escapeHtml(formatTime(log.run_at)) + ' • ' + escapeHtml(log.duration_ms) + ' ms</div>' +
          '<div class="mono">' + escapeHtml(log.error || log.result || 'Completed') + '</div>' +
        '</article>';
      }).join('');
    }

    function renderAppsAndSkills(snapshot) {
      const appsRoot = document.getElementById('apps');
      const skillsRoot = document.getElementById('skills');

      if (!snapshot.apps.length) {
        appsRoot.innerHTML = '<div class="empty">No plugin apps detected.</div>';
      } else {
        appsRoot.innerHTML = snapshot.apps.map((app) => {
          const changed = highlightIfChanged('app:' + app.id, app);
          return '<article class="task-card ' + changed + '">' +
            '<div class="card-top">' +
              '<div>' +
                '<div class="card-title">' + escapeHtml(app.name) + '</div>' +
                '<div class="meta">' + escapeHtml(app.source) + ' app bundle</div>' +
              '</div>' +
              '<div class="pill ' + (app.enabled ? 'good' : 'danger') + '">' + escapeHtml(app.enabled ? 'enabled' : 'disabled') + '</div>' +
            '</div>' +
            '<div class="mono">' + escapeHtml(app.note) + '</div>' +
            '<div class="pill-row">' +
              '<span class="pill">skills: ' + escapeHtml(app.skillCount) + '</span>' +
              '<span class="pill">' + escapeHtml(app.id) + '</span>' +
            '</div>' +
          '</article>';
        }).join('');
      }

      if (!snapshot.skills.length) {
        skillsRoot.innerHTML = '<div class="empty">No skills detected.</div>';
        return;
      }

      skillsRoot.innerHTML = snapshot.skills.map((skill) => {
        const changed = highlightIfChanged('skill:' + skill.id, skill);
        const appLabel = skill.app ? 'app: ' + skill.app : 'built-in';
        return '<article class="task-card ' + changed + '">' +
          '<div class="card-top">' +
            '<div>' +
              '<div class="card-title">' + escapeHtml(skill.name) + '</div>' +
              '<div class="meta">' + escapeHtml(appLabel) + ' • ' + escapeHtml(skill.source) + '</div>' +
            '</div>' +
            '<div class="pill ' + (skill.enabled ? 'good' : 'danger') + '">' + escapeHtml(skill.enabled ? 'enabled' : 'disabled') + '</div>' +
          '</div>' +
          '<div class="mono">' + escapeHtml(skill.description) + '</div>' +
          '<div class="pill-row">' +
            '<span class="pill">' + escapeHtml(skill.plugin || 'system') + '</span>' +
            '<span class="pill">' + escapeHtml(skill.manifestPath) + '</span>' +
          '</div>' +
        '</article>';
      }).join('');
    }

    function renderEvents(snapshot) {
      const root = document.getElementById('events');
      if (!snapshot.recentEvents.length) {
        root.innerHTML = '<div class="empty">No runtime events yet.</div>';
        return;
      }
      root.innerHTML = snapshot.recentEvents.slice().reverse().map((event) => {
        const changed = highlightIfChanged('event:' + event.at + ':' + event.msg, event);
        const data = event.data ? '<div class="mono">' + escapeHtml(JSON.stringify(event.data)) + '</div>' : '';
        return '<article class="event-row ' + changed + '">' +
          '<div>' + escapeHtml(new Date(event.at).toLocaleTimeString()) + '</div>' +
          '<div class="event-level">' + escapeHtml(event.level) + '</div>' +
          '<div class="msg">' + escapeHtml(event.msg) + data + '</div>' +
        '</article>';
      }).join('');
    }

    function renderMessages(snapshot) {
      const root = document.getElementById('messages');
      if (!snapshot.recentMessages.length) {
        root.innerHTML = '<div class="empty">No recent messages captured yet.</div>';
        return;
      }
      root.innerHTML = snapshot.recentMessages.map((message) => {
        const changed = highlightIfChanged('message:' + message.id + ':' + message.timestamp, message);
        const pills = [];
        if (message.isBotMessage) pills.push('<span class="pill good">bot</span>');
        if (message.isFromMe) pills.push('<span class="pill">from me</span>');
        return '<article class="task-card ' + changed + '">' +
          '<div class="card-top">' +
            '<div>' +
              '<div class="card-title">' + escapeHtml(message.senderName) + '</div>' +
              '<div class="meta">' + escapeHtml(message.groupName) + ' • ' + escapeHtml(formatTime(message.timestamp)) + '</div>' +
            '</div>' +
            '<div class="pill-row">' + pills.join('') + '</div>' +
          '</div>' +
          '<div class="mono">' + escapeHtml(message.content) + '</div>' +
        '</article>';
      }).join('');
    }

    function render(snapshot) {
      renderStats(snapshot);
      renderRuntime(snapshot);
      renderLauncher(snapshot);
      renderGroups(snapshot);
      renderTasks(snapshot);
      renderAppsAndSkills(snapshot);
      renderEvents(snapshot);
      renderMessages(snapshot);
    }

    async function callAction(path) {
      const response = await fetch(path, { method: 'POST' });
      const body = await response.json();
      document.getElementById('action-message').textContent = body.message;
    }

    document.getElementById('start-button').addEventListener('click', () => callAction('/api/agent/start'));
    document.getElementById('stop-button').addEventListener('click', () => callAction('/api/agent/stop'));

    fetch('/api/status')
      .then((response) => response.json())
      .then(render);

    const stream = new EventSource('/api/stream');
    stream.onmessage = (event) => render(JSON.parse(event.data));
    stream.onerror = () => {
      document.getElementById('action-message').textContent = 'Live stream disconnected. Retrying…';
    };
  </script>
</body>
</html>`;

function handleRequest(
  request: http.IncomingMessage,
  response: http.ServerResponse,
): void {
  const url = request.url || '/';

  if (request.method === 'GET' && url === '/') {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    response.end(html);
    return;
  }

  if (request.method === 'GET' && url === '/api/status') {
    json(response, 200, buildSnapshot());
    return;
  }

  if (request.method === 'GET' && url === '/api/stream') {
    response.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    });
    response.write(`data: ${JSON.stringify(buildSnapshot())}\n\n`);
    sseClients.add(response);
    request.on('close', () => {
      sseClients.delete(response);
    });
    return;
  }

  if (request.method === 'POST' && url === '/api/agent/start') {
    json(response, 200, startAgent());
    return;
  }

  if (request.method === 'POST' && url === '/api/agent/stop') {
    json(response, 200, stopAgent());
    return;
  }

  json(response, 404, { error: 'Not found' });
}

fs.mkdirSync(DASHBOARD_STATE_DIR, { recursive: true });
initDatabase();

const server = http.createServer(handleRequest);
server.listen(PORT, HOST, () => {
  logger.info({ host: HOST, port: PORT }, 'NanoClaw dashboard listening');
  broadcastSnapshot();
});

setInterval(broadcastSnapshot, 1000).unref();
