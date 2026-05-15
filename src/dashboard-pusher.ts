/**
 * Dashboard pusher: collects NanoClaw state and posts snapshots to the
 * dashboard server's ingest endpoints.
 */
import fs from 'fs';
import http from 'http';
import path from 'path';

import Database from 'better-sqlite3';

import { getActiveAdapters, getRegisteredChannelNames } from './channels/channel-registry.js';
import { ASSISTANT_NAME, DATA_DIR } from './config.js';
import { getAllAgentGroups, getAgentGroup } from './db/agent-groups.js';
import { getDb } from './db/connection.js';
import { getAllMessagingGroups, getMessagingGroupAgents } from './db/messaging-groups.js';
import { getSessionsByAgentGroup } from './db/sessions.js';
import { log } from './log.js';
import { getDestinations } from './modules/agent-to-agent/db/agent-destinations.js';
import { getMembers } from './modules/permissions/db/agent-group-members.js';
import { getUserDmsForUser } from './modules/permissions/db/user-dms.js';
import { getAdminsOfAgentGroup, getUserRoles } from './modules/permissions/db/user-roles.js';
import { getAllUsers, getUser } from './modules/permissions/db/users.js';

interface PusherConfig {
  port: number;
  secret: string;
  intervalMs?: number;
}

interface TokenEntry {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

interface TokenTotals {
  requests: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

interface SessionMessages {
  agentGroupId: string;
  sessionId: string;
  inbound: unknown[];
  outbound: unknown[];
}

type SkillKind = 'capability' | 'operational';

interface SkillCatalogEntry {
  id: string;
  name: string;
  description: string;
  title: string;
  path: string;
  kind: SkillKind;
  commandExamples: string[];
  sections: Array<{ title: string; lines: string[] }>;
  howToAsk: string[];
}

const OPERATIONAL_SKILL_IDS = new Set<string>([
  'welcome',
  'self-customize',
  'slack-formatting',
  'agent-browser',
  'vercel-cli',
]);

function classifySkill(id: string): SkillKind {
  return OPERATIONAL_SKILL_IDS.has(id) ? 'operational' : 'capability';
}

const STANDARD_CONTEXT_WINDOW_TOKENS = 200_000;
const EXTENDED_CONTEXT_WINDOW_TOKENS = 1_000_000;

let timer: ReturnType<typeof setInterval> | null = null;
let logTimer: ReturnType<typeof setInterval> | null = null;
let logOffset = 0;

export function startDashboardPusher(config: PusherConfig): void {
  stopDashboardPusher();

  const interval = config.intervalMs || 60000;

  push(config).catch((err) => log.error('Dashboard push failed', { err }));
  timer = setInterval(() => {
    push(config).catch((err) => log.error('Dashboard push failed', { err }));
  }, interval);

  startLogTail(config);

  log.info('Dashboard pusher started', { intervalMs: interval });
}

export function stopDashboardPusher(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  if (logTimer) {
    clearInterval(logTimer);
    logTimer = null;
  }
}

function postJson(config: PusherConfig, urlPath: string, data: unknown): void {
  const body = JSON.stringify(data);
  const req = http.request(
    {
      hostname: '127.0.0.1',
      port: config.port,
      path: urlPath,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        Authorization: `Bearer ${config.secret}`,
      },
    },
    (res) => {
      res.resume();
    },
  );

  req.on('error', (err) => {
    log.debug('Dashboard post failed', { path: urlPath, err });
  });
  req.write(body);
  req.end();
}

const ANSI_RE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');

function cleanLogLine(line: string): string {
  return line.replace(ANSI_RE, '');
}

function startLogTail(config: PusherConfig): void {
  const logFile = path.resolve(process.cwd(), 'logs', 'nanoclaw.log');

  backfillLogs(config, logFile);

  logTimer = setInterval(() => {
    tailLogs(config, logFile);
  }, 2000);
}

function backfillLogs(config: PusherConfig, logFile: string): void {
  if (!fs.existsSync(logFile)) return;

  try {
    const allLines = fs
      .readFileSync(logFile, 'utf-8')
      .split('\n')
      .filter((line) => line.trim())
      .map(cleanLogLine);
    logOffset = fs.statSync(logFile).size;
    const tail = allLines.slice(-200);
    if (tail.length > 0) postJson(config, '/api/logs/push', { lines: tail });
  } catch (err) {
    log.debug('Dashboard log backfill failed', { err });
  }
}

function tailLogs(config: PusherConfig, logFile: string): void {
  if (!fs.existsSync(logFile)) return;

  try {
    const stat = fs.statSync(logFile);
    if (stat.size < logOffset) {
      logOffset = 0;
    }
    if (stat.size === logOffset) return;

    const fd = fs.openSync(logFile, 'r');
    try {
      const buf = Buffer.alloc(stat.size - logOffset);
      fs.readSync(fd, buf, 0, buf.length, logOffset);
      logOffset = stat.size;
      const lines = buf
        .toString()
        .split('\n')
        .filter((line) => line.trim())
        .map(cleanLogLine);
      if (lines.length > 0) postJson(config, '/api/logs/push', { lines });
    } finally {
      fs.closeSync(fd);
    }
  } catch (err) {
    log.debug('Dashboard log tail failed', { err });
  }
}

async function push(config: PusherConfig): Promise<void> {
  const snapshot = collectSnapshot();
  postJson(config, '/api/ingest', snapshot);
  log.debug('Dashboard snapshot pushed');
}

function collectSnapshot(): Record<string, unknown> {
  return {
    timestamp: new Date().toISOString(),
    assistant_name: ASSISTANT_NAME,
    uptime: Math.floor(process.uptime()),
    agent_groups: collectAgentGroups(),
    sessions: collectSessions(),
    channels: collectChannels(),
    users: collectUsers(),
    tokens: collectTokens(),
    context_windows: collectContextWindows(),
    activity: collectActivity(),
    messages: collectMessages(),
    capabilities: collectCapabilities(),
  };
}

function readContainerConfig(folder: string): Record<string, unknown> | null {
  const configPath = path.resolve(process.cwd(), 'groups', folder, 'container.json');
  if (!fs.existsSync(configPath)) return null;

  try {
    return JSON.parse(fs.readFileSync(configPath, 'utf-8')) as Record<string, unknown>;
  } catch (err) {
    log.debug('Failed to read group container config for dashboard', { folder, err });
    return null;
  }
}

function collectAgentGroups(): Array<Record<string, unknown>> {
  return getAllAgentGroups().map((group) => {
    const sessions = getSessionsByAgentGroup(group.id);
    const running = sessions.filter(
      (session) => session.container_status === 'running' || session.container_status === 'idle',
    );
    const destinations = getDestinations(group.id);
    const members = getMembers(group.id).map((member) => {
      const user = getUser(member.user_id);
      return { ...member, display_name: user?.display_name ?? null };
    });
    const admins = getAdminsOfAgentGroup(group.id).map((admin) => {
      const user = getUser(admin.user_id);
      return { ...admin, display_name: user?.display_name ?? null };
    });

    const wirings = getDb()
      .prepare(
        `SELECT mga.*, mg.channel_type, mg.platform_id, mg.name as mg_name, mg.is_group, mg.unknown_sender_policy
           FROM messaging_group_agents mga
           JOIN messaging_groups mg ON mg.id = mga.messaging_group_id
          WHERE mga.agent_group_id = ?`,
      )
      .all(group.id) as Array<Record<string, unknown>>;

    return {
      id: group.id,
      name: group.name,
      folder: group.folder,
      agent_provider: group.agent_provider,
      container_config: readContainerConfig(group.folder),
      sessionCount: sessions.length,
      runningSessions: running.length,
      wirings,
      destinations,
      members,
      admins,
      created_at: group.created_at,
    };
  });
}

function collectCapabilities(): Record<string, unknown> {
  const skills = collectSkillCatalog();
  const skillMap = new Map(skills.map((skill) => [skill.id, skill]));
  const agents = getAllAgentGroups().map((group) => {
    const containerConfig = readContainerConfig(group.folder);
    const enabledSkillIds = readStringArray(containerConfig?.skills);
    const localInstructions = readGroupLocalInstructions(group.folder);
    const sessions = getSessionsByAgentGroup(group.id);
    const runningSessions = sessions.filter(
      (session) => session.container_status === 'running' || session.container_status === 'idle',
    ).length;

    const enabledSkills = enabledSkillIds.map((skillId) => {
      const skill = skillMap.get(skillId);
      const kind = skill?.kind ?? classifySkill(skillId);
      return {
        id: skillId,
        name: skill?.name ?? skillId,
        description: skill?.description ?? 'No local SKILL.md description found.',
        path: skill?.path ?? `container/skills/${skillId}/SKILL.md`,
        kind,
        commandExamples: skill?.commandExamples ?? [],
        howToAsk: skill?.howToAsk ?? fallbackHowToAsk(skillId),
      };
    });

    const capabilitySkills = enabledSkills.filter((skill) => skill.kind === 'capability');

    return {
      id: group.id,
      name: group.name,
      folder: group.folder,
      provider: group.agent_provider,
      purpose: localInstructions.purpose,
      primaryInterface: localInstructions.primaryInterface,
      botIdentity: localInstructions.botIdentity,
      instructionHighlights: localInstructions.highlights,
      sessionCount: sessions.length,
      runningSessions,
      skills: enabledSkills,
      howToAsk: capabilitySkills
        .flatMap((skill) => skill.howToAsk.map((ask) => ({ skill: skill.id, ask })))
        .slice(0, 12),
      commands: capabilitySkills
        .flatMap((skill) => skill.commandExamples.map((command) => ({ skill: skill.id, command })))
        .slice(0, 18),
      mounts: normalizeMounts(containerConfig?.additionalMounts),
      envPassThrough: readStringArray(containerConfig?.envPassThrough),
      packages: normalizePackages(containerConfig?.packages),
      mcpServers: isRecord(containerConfig?.mcpServers) ? Object.keys(containerConfig.mcpServers) : [],
    };
  });

  let capabilityLinks = 0;
  let operationalLinks = 0;
  let totalSessions = 0;
  for (const agent of agents) {
    totalSessions += toFiniteNumber(agent.sessionCount);
    for (const skill of readArrayOfRecords(agent.skills)) {
      if (skill.kind === 'operational') operationalLinks += 1;
      else capabilityLinks += 1;
    }
  }

  return {
    generated_at: new Date().toISOString(),
    totals: {
      agents: agents.length,
      localSkills: skills.length,
      capabilityLinks,
      operationalLinks,
      totalSessions,
    },
    agents,
    skills: skills.map((skill) => ({
      ...skill,
      usedBy: agents
        .filter((agent) => readArrayOfRecords(agent.skills).some((enabledSkill) => enabledSkill.id === skill.id))
        .map((agent) => ({ id: agent.id, name: agent.name, folder: agent.folder })),
    })),
  };
}

function toFiniteNumber(value: unknown): number {
  const num = Number(value ?? 0);
  return Number.isFinite(num) ? num : 0;
}

function collectSkillCatalog(): SkillCatalogEntry[] {
  const skillsDir = path.resolve(process.cwd(), 'container', 'skills');
  if (!fs.existsSync(skillsDir)) return [];

  return fs
    .readdirSync(skillsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => readSkillCatalogEntry(path.join(skillsDir, entry.name), entry.name))
    .filter((entry): entry is SkillCatalogEntry => entry !== null)
    .sort((a, b) => a.name.localeCompare(b.name));
}

function readSkillCatalogEntry(skillDir: string, fallbackId: string): SkillCatalogEntry | null {
  const skillPath = path.join(skillDir, 'SKILL.md');
  if (!fs.existsSync(skillPath)) return null;

  try {
    const markdown = fs.readFileSync(skillPath, 'utf-8');
    const frontmatter = parseFrontmatter(markdown);
    const id = frontmatter.name || fallbackId;
    const title = firstMarkdownHeading(markdown) || frontmatter.name || fallbackId;
    const description = frontmatter.description || firstParagraph(markdown) || 'No description supplied.';
    return {
      id,
      name: frontmatter.name || fallbackId,
      description,
      title,
      path: path.relative(process.cwd(), skillPath),
      kind: classifySkill(id),
      commandExamples: extractCommandExamples(markdown),
      sections: extractUsefulSections(markdown),
      howToAsk: suggestedPrompts(id, description),
    };
  } catch (err) {
    log.debug('Dashboard skipped unreadable skill catalog entry', { skillPath, err });
    return null;
  }
}

function parseFrontmatter(markdown: string): Record<string, string> {
  const match = markdown.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return {};

  const result: Record<string, string> = {};
  for (const line of match[1].split('\n')) {
    const field = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!field) continue;
    result[field[1]] = field[2].replace(/^["']|["']$/g, '').trim();
  }
  return result;
}

function firstMarkdownHeading(markdown: string): string | null {
  const match = markdown.match(/^#\s+(.+)$/m);
  return match?.[1].trim() ?? null;
}

function firstParagraph(markdown: string): string | null {
  const body = markdown.replace(/^---\n[\s\S]*?\n---/, '').trim();
  for (const block of body.split(/\n\s*\n/)) {
    const cleaned = block
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#') && !line.startsWith('```'))
      .join(' ');
    if (cleaned) return cleaned;
  }
  return null;
}

function extractCommandExamples(markdown: string): string[] {
  const commands: string[] = [];
  const fenceRe = /```(?:bash|sh|shell|zsh)?\n([\s\S]*?)```/gi;
  let match: RegExpExecArray | null;
  while ((match = fenceRe.exec(markdown)) !== null) {
    for (const rawLine of match[1].split('\n')) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      if (looksLikeCommand(line)) commands.push(line);
      if (commands.length >= 12) return commands;
    }
  }
  return commands;
}

function looksLikeCommand(line: string): boolean {
  return (
    line.startsWith('NODE_NO_WARNINGS=') ||
    line.startsWith('node ') ||
    line.startsWith('bun ') ||
    line.startsWith('npm ') ||
    line.startsWith('pnpm ') ||
    line.startsWith('npx ') ||
    line.startsWith('curl ') ||
    line.startsWith('/workspace/') ||
    line.startsWith('agent-browser ')
  );
}

function extractUsefulSections(markdown: string): Array<{ title: string; lines: string[] }> {
  const usefulTitles = new Set([
    'Main Command',
    'Workflow',
    'Utilities',
    'Safety Rules',
    'Market Data Toolkit',
    'Trade Idea Workflow',
    'Portfolio / Risk Workflow',
    'Prediction Market Workflow',
    'Safe Remotion Video Renders',
  ]);
  const sections: Array<{ title: string; lines: string[] }> = [];
  const sectionRe = /^##\s+(.+)$/gm;
  const headings: Array<{ title: string; index: number; end: number }> = [];
  let match: RegExpExecArray | null;
  while ((match = sectionRe.exec(markdown)) !== null) {
    headings.push({ title: match[1].trim(), index: match.index, end: sectionRe.lastIndex });
  }

  for (let i = 0; i < headings.length; i++) {
    const heading = headings[i];
    if (!usefulTitles.has(heading.title)) continue;
    const next = headings[i + 1]?.index ?? markdown.length;
    const lines = markdown.slice(heading.end, next).split('\n').map(cleanMarkdownLine).filter(Boolean).slice(0, 8);
    if (lines.length > 0) sections.push({ title: heading.title, lines });
    if (sections.length >= 4) break;
  }

  return sections;
}

function cleanMarkdownLine(line: string): string {
  return line
    .trim()
    .replace(/^[-*]\s+/, '')
    .replace(/^\d+\.\s+/, '')
    .replace(/^#+\s+/, '')
    .replace(/`{3,}.*/, '')
    .trim();
}

function readGroupLocalInstructions(folder: string): {
  purpose: string[];
  primaryInterface: string | null;
  botIdentity: string | null;
  highlights: Array<{ title: string; lines: string[] }>;
} {
  const filePath = path.resolve(process.cwd(), 'groups', folder, 'CLAUDE.local.md');
  if (!fs.existsSync(filePath)) {
    return { purpose: [], primaryInterface: null, botIdentity: null, highlights: [] };
  }

  try {
    const markdown = fs.readFileSync(filePath, 'utf-8');
    const purpose = extractInstructionLines(extractSection(markdown, 'Purpose')).slice(0, 8);
    const primaryInterface = markdown.match(/Primary interface:\s*(.+)$/m)?.[1]?.trim() ?? null;
    const botIdentity = markdown.match(/Bot identity:\s*(.+)$/m)?.[1]?.trim() ?? null;
    const highlights = [
      "Skills you'll use",
      'Finance Desk Mandate',
      'Cross-Agent Connections',
      'Safe Remotion Video Renders',
    ]
      .map((title) => ({ title, lines: extractInstructionLines(extractSection(markdown, title)).slice(0, 8) }))
      .filter((section) => section.lines.length > 0);
    return { purpose, primaryInterface, botIdentity, highlights };
  } catch (err) {
    log.debug('Dashboard skipped unreadable local instructions', { folder, err });
    return { purpose: [], primaryInterface: null, botIdentity: null, highlights: [] };
  }
}

function extractSection(markdown: string, title: string): string {
  const lines = markdown.split('\n');
  const wanted = title.toLowerCase();
  const startIndex = lines.findIndex((line) => {
    const match = line.match(/^##\s+(.+?)\s*$/);
    return match ? match[1].trim().toLowerCase() === wanted : false;
  });
  if (startIndex === -1) return '';

  const sectionLines: string[] = [];
  for (let i = startIndex + 1; i < lines.length; i++) {
    if (/^##\s+/.test(lines[i])) break;
    sectionLines.push(lines[i]);
  }
  return sectionLines.join('\n');
}

function extractInstructionLines(section: string): string[] {
  return section
    .split('\n')
    .map(cleanMarkdownLine)
    .filter((line) => line && !line.startsWith('```'))
    .slice(0, 12);
}

function suggestedPrompts(skillId: string, description: string): string[] {
  const known: Record<string, string[]> = {
    'finance-analyst': [
      'Ask Analyst: pressure-test this trade idea with live tape and invalidation.',
      'Ask Analyst: run portfolio risk on NVDA=40%, MSFT=30%, TSLA=30%.',
      'Ask Builder: use finance-analyst before turning this market idea into a dashboard or video.',
    ],
    'risk-committee': [
      'Ask Analyst: run a risk committee on idea <idea-id> and give pass/watch/reject.',
      'Ask Analyst: pressure-test long copper with kill criteria and portfolio fit.',
    ],
    'trade-video-director': [
      'Ask Builder: make a narrated trade idea video for idea <idea-id> and render it.',
      'Ask Builder: make a cheap draft video on long NVDA with no TTS first.',
    ],
    'extract-trade-ideas': [
      "Ask Analyst: extract trade ideas from today's podcast transcripts.",
      'Ask Analyst: catch up trade ideas from the last 24 hours and save the digest.',
    ],
    'agent-browser': [
      'Ask the agent: inspect this local page in the browser and tell me what is broken.',
      'Ask the agent: screenshot this dashboard and check the layout.',
    ],
    'self-customize': [
      'Ask the agent: add this package or mount to your own container safely.',
      'Ask the agent: check whether your container has the tooling needed for this task.',
    ],
    welcome: ['Ask the agent: show me what you can do and how to start.'],
  };

  return known[skillId] ?? fallbackHowToAsk(skillId, description);
}

function fallbackHowToAsk(skillId: string, description = ''): string[] {
  const plainDescription = description.replace(/\s+/g, ' ').trim();
  if (plainDescription) return [`Ask the agent: use ${skillId} for ${plainDescription}`];
  return [`Ask the agent: use ${skillId} for this task.`];
}

function normalizeMounts(value: unknown): Array<Record<string, unknown>> {
  return readArrayOfRecords(value).map((mount) => ({
    hostPath: typeof mount.hostPath === 'string' ? mount.hostPath : '',
    containerPath: typeof mount.containerPath === 'string' ? mount.containerPath : '',
    readonly: mount.readonly === true,
  }));
}

function normalizePackages(value: unknown): Record<string, string[]> {
  if (!isRecord(value)) return {};
  const result: Record<string, string[]> = {};
  for (const [manager, packages] of Object.entries(value)) {
    result[manager] = readStringArray(packages);
  }
  return result;
}

function collectSessions(): Array<Record<string, unknown>> {
  return getDb()
    .prepare(
      `SELECT s.*, ag.name as agent_group_name, ag.folder as agent_group_folder,
              mg.channel_type, mg.platform_id, mg.name as messaging_group_name
         FROM sessions s
         LEFT JOIN agent_groups ag ON ag.id = s.agent_group_id
         LEFT JOIN messaging_groups mg ON mg.id = s.messaging_group_id
        ORDER BY s.last_active DESC NULLS LAST`,
    )
    .all() as Array<Record<string, unknown>>;
}

function collectChannels(): Array<Record<string, unknown>> {
  const messagingGroups = getAllMessagingGroups();
  const liveAdapters = getActiveAdapters().map((adapter) => adapter.channelType);
  const registeredChannels = getRegisteredChannelNames();

  const byType: Record<
    string,
    {
      channelType: string;
      isLive: boolean;
      isRegistered: boolean;
      groups: unknown[];
    }
  > = {};

  for (const messagingGroup of messagingGroups) {
    if (!byType[messagingGroup.channel_type]) {
      byType[messagingGroup.channel_type] = {
        channelType: messagingGroup.channel_type,
        isLive: liveAdapters.includes(messagingGroup.channel_type),
        isRegistered: registeredChannels.includes(messagingGroup.channel_type),
        groups: [],
      };
    }

    const agents = getMessagingGroupAgents(messagingGroup.id).map((agent) => {
      const group = getAgentGroup(agent.agent_group_id);
      return {
        agent_group_id: agent.agent_group_id,
        agent_group_name: group?.name ?? null,
        priority: agent.priority,
      };
    });

    byType[messagingGroup.channel_type].groups.push({
      messagingGroup: {
        id: messagingGroup.id,
        platform_id: messagingGroup.platform_id,
        name: messagingGroup.name,
        is_group: messagingGroup.is_group,
        unknown_sender_policy: messagingGroup.unknown_sender_policy ?? 'strict',
      },
      agents,
    });
  }

  for (const channelType of liveAdapters) {
    if (!byType[channelType]) {
      byType[channelType] = {
        channelType,
        isLive: true,
        isRegistered: true,
        groups: [],
      };
    }
  }

  return Object.values(byType).sort((a, b) => a.channelType.localeCompare(b.channelType));
}

function collectUsers(): Array<Record<string, unknown>> {
  return getAllUsers().map((user) => {
    const roles = getUserRoles(user.id);
    const dms = getUserDmsForUser(user.id);

    const memberships = getDb()
      .prepare(
        `SELECT agm.agent_group_id, ag.name as agent_group_name
           FROM agent_group_members agm
           JOIN agent_groups ag ON ag.id = agm.agent_group_id
          WHERE agm.user_id = ?`,
      )
      .all(user.id) as Array<Record<string, unknown>>;

    let privilege = 'none';
    if (roles.some((role) => role.role === 'owner')) privilege = 'owner';
    else if (roles.some((role) => role.role === 'admin' && !role.agent_group_id)) privilege = 'global_admin';
    else if (roles.some((role) => role.role === 'admin')) privilege = 'admin';
    else if (memberships.length > 0) privilege = 'member';

    return {
      id: user.id,
      kind: user.kind,
      display_name: user.display_name,
      privilege,
      roles,
      memberships,
      dmChannels: dms.map((dm) => ({ channel_type: dm.channel_type })),
      created_at: user.created_at,
    };
  });
}

function collectTokens(): Record<string, unknown> {
  const sessionsDir = path.join(DATA_DIR, 'v2-sessions');
  const allEntries: Array<TokenEntry & { agentGroupId: string }> = [];
  const agentGroups = getAllAgentGroups();
  const nameMap = new Map(agentGroups.map((group) => [group.id, group.name]));

  if (fs.existsSync(sessionsDir)) {
    for (const agentGroupDir of fs.readdirSync(sessionsDir).filter((entry) => entry.startsWith('ag-'))) {
      const entries = scanJsonlTokens(path.join(sessionsDir, agentGroupDir));
      allEntries.push(...entries.map((entry) => ({ ...entry, agentGroupId: agentGroupDir })));
    }
  }

  const byModel: Record<string, TokenTotals> = {};
  const byGroup: Record<string, TokenTotals & { name: string }> = {};
  const totals = emptyTokenTotals();

  for (const entry of allEntries) {
    byModel[entry.model] ??= emptyTokenTotals();
    byModel[entry.model].requests += 1;
    byModel[entry.model].inputTokens += entry.inputTokens;
    byModel[entry.model].outputTokens += entry.outputTokens;
    byModel[entry.model].cacheReadTokens += entry.cacheReadTokens;
    byModel[entry.model].cacheCreationTokens += entry.cacheCreationTokens;

    byGroup[entry.agentGroupId] ??= {
      ...emptyTokenTotals(),
      name: nameMap.get(entry.agentGroupId) || entry.agentGroupId,
    };
    byGroup[entry.agentGroupId].requests += 1;
    byGroup[entry.agentGroupId].inputTokens += entry.inputTokens;
    byGroup[entry.agentGroupId].outputTokens += entry.outputTokens;
    byGroup[entry.agentGroupId].cacheReadTokens += entry.cacheReadTokens;
    byGroup[entry.agentGroupId].cacheCreationTokens += entry.cacheCreationTokens;

    totals.requests += 1;
    totals.inputTokens += entry.inputTokens;
    totals.outputTokens += entry.outputTokens;
    totals.cacheReadTokens += entry.cacheReadTokens;
    totals.cacheCreationTokens += entry.cacheCreationTokens;
  }

  return { totals, byModel, byGroup };
}

function emptyTokenTotals(): TokenTotals {
  return {
    requests: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
  };
}

function scanJsonlTokens(agentDir: string): TokenEntry[] {
  const claudeDir = path.join(agentDir, '.claude-shared', 'projects');
  if (!fs.existsSync(claudeDir)) return [];

  const entries: TokenEntry[] = [];

  walkFiles(claudeDir, (filePath) => {
    if (!filePath.endsWith('.jsonl')) return;
    try {
      for (const line of fs.readFileSync(filePath, 'utf-8').split('\n')) {
        if (!line.trim()) continue;
        const record = tryParseJson(line);
        if (!isRecord(record)) continue;
        const message = record.message;
        if (record.type !== 'assistant' || !isRecord(message) || !isRecord(message.usage)) continue;
        entries.push({
          model: typeof message.model === 'string' ? message.model : 'unknown',
          inputTokens: readNumber(message.usage.input_tokens),
          outputTokens: readNumber(message.usage.output_tokens),
          cacheReadTokens: readNumber(message.usage.cache_read_input_tokens),
          cacheCreationTokens: readNumber(message.usage.cache_creation_input_tokens),
        });
      }
    } catch (err) {
      log.debug('Dashboard token scan skipped unreadable file', { filePath, err });
    }
  });

  return entries;
}

function collectContextWindows(): Array<Record<string, unknown>> {
  const sessionsDir = path.join(DATA_DIR, 'v2-sessions');
  if (!fs.existsSync(sessionsDir)) return [];

  const results: Array<Record<string, unknown>> = [];
  const agentGroups = getAllAgentGroups();
  const nameMap = new Map(agentGroups.map((group) => [group.id, group.name]));

  for (const agentGroupDir of fs.readdirSync(sessionsDir).filter((entry) => entry.startsWith('ag-'))) {
    const claudeDir = path.join(sessionsDir, agentGroupDir, '.claude-shared', 'projects');
    if (!fs.existsSync(claudeDir)) continue;

    const jsonlFiles: string[] = [];
    walkFiles(claudeDir, (filePath) => {
      if (filePath.endsWith('.jsonl')) jsonlFiles.push(filePath);
    });
    if (jsonlFiles.length === 0) continue;

    jsonlFiles.sort((a, b) => fileMtimeMs(b) - fileMtimeMs(a));
    const latest = jsonlFiles[0];
    if (!latest) continue;

    try {
      const lines = fs.readFileSync(latest, 'utf-8').split('\n');
      for (let i = lines.length - 1; i >= 0; i--) {
        if (!lines[i].trim()) continue;
        const record = tryParseJson(lines[i]);
        if (!isRecord(record)) continue;
        const message = record.message;
        if (record.type !== 'assistant' || !isRecord(message) || !isRecord(message.usage)) continue;

        const usage = message.usage;
        const contextTokens =
          readNumber(usage.input_tokens) +
          readNumber(usage.cache_read_input_tokens) +
          readNumber(usage.cache_creation_input_tokens);
        const model = typeof message.model === 'string' ? message.model : 'unknown';
        const maxContext = contextWindowForModel(model);

        results.push({
          agentGroupId: agentGroupDir,
          agentGroupName: nameMap.get(agentGroupDir),
          sessionId: path.basename(latest, '.jsonl'),
          model,
          contextTokens,
          outputTokens: readNumber(usage.output_tokens),
          cacheReadTokens: readNumber(usage.cache_read_input_tokens),
          cacheCreationTokens: readNumber(usage.cache_creation_input_tokens),
          maxContext,
          usagePercent: Math.round((contextTokens / maxContext) * 100),
          timestamp: typeof record.timestamp === 'string' ? record.timestamp : '',
        });
        break;
      }
    } catch (err) {
      log.debug('Dashboard context scan skipped unreadable file', { filePath: latest, err });
    }
  }

  return results;
}

function contextWindowForModel(model: string): number {
  const normalized = model.toLowerCase();
  if (
    normalized.includes('[1m]') ||
    normalized.includes('claude-opus-4-7') ||
    normalized.includes('claude-opus-4-6') ||
    normalized.includes('claude-sonnet-4-6') ||
    normalized.includes('claude-mythos')
  ) {
    return EXTENDED_CONTEXT_WINDOW_TOKENS;
  }
  return STANDARD_CONTEXT_WINDOW_TOKENS;
}

function collectActivity(): Array<Record<string, unknown>> {
  const now = Date.now();
  const buckets: Record<string, { inbound: number; outbound: number }> = {};

  for (let i = 0; i < 24; i++) {
    const key = new Date(now - i * 3600000).toISOString().slice(0, 13);
    buckets[key] = { inbound: 0, outbound: 0 };
  }

  const sessionsDir = path.join(DATA_DIR, 'v2-sessions');
  if (!fs.existsSync(sessionsDir)) return toBucketArray(buckets);

  const cutoff = new Date(now - 86400000).toISOString();

  try {
    for (const agentGroupDir of fs.readdirSync(sessionsDir).filter((entry) => entry.startsWith('ag-'))) {
      const agentGroupPath = path.join(sessionsDir, agentGroupDir);
      for (const sessionDir of fs.readdirSync(agentGroupPath).filter((entry) => entry.startsWith('sess-'))) {
        for (const [dbName, direction] of [
          ['outbound.db', 'outbound'],
          ['inbound.db', 'inbound'],
        ] as const) {
          const dbPath = path.join(agentGroupPath, sessionDir, dbName);
          if (!fs.existsSync(dbPath)) continue;
          readMessageActivity(dbPath, direction, cutoff, buckets);
        }
      }
    }
  } catch (err) {
    log.debug('Dashboard activity scan failed', { err });
  }

  return toBucketArray(buckets);
}

function readMessageActivity(
  dbPath: string,
  direction: 'inbound' | 'outbound',
  cutoff: string,
  buckets: Record<string, { inbound: number; outbound: number }>,
): void {
  const db = new Database(dbPath, { readonly: true });
  try {
    const table = direction === 'outbound' ? 'messages_out' : 'messages_in';
    const rows = db.prepare(`SELECT timestamp FROM ${table} WHERE timestamp > ?`).all(cutoff) as Array<{
      timestamp: string;
    }>;
    for (const row of rows) {
      const key = row.timestamp.slice(0, 13);
      if (buckets[key]) buckets[key][direction] += 1;
    }
  } catch (err) {
    log.debug('Dashboard activity DB scan failed', { dbPath, err });
  } finally {
    db.close();
  }
}

function toBucketArray(buckets: Record<string, { inbound: number; outbound: number }>): Array<Record<string, unknown>> {
  return Object.entries(buckets)
    .map(([hour, counts]) => ({ hour, ...counts }))
    .sort((a, b) => a.hour.localeCompare(b.hour));
}

function collectMessages(): SessionMessages[] {
  const sessionsDir = path.join(DATA_DIR, 'v2-sessions');
  if (!fs.existsSync(sessionsDir)) return [];

  const results: SessionMessages[] = [];
  const limit = 50;

  try {
    for (const agentGroupDir of fs.readdirSync(sessionsDir).filter((entry) => entry.startsWith('ag-'))) {
      const agentGroupPath = path.join(sessionsDir, agentGroupDir);
      for (const sessionDir of fs.readdirSync(agentGroupPath).filter((entry) => entry.startsWith('sess-'))) {
        const inbound = readRecentMessages(path.join(agentGroupPath, sessionDir, 'inbound.db'), 'messages_in', limit);
        const outbound = readRecentMessages(
          path.join(agentGroupPath, sessionDir, 'outbound.db'),
          'messages_out',
          limit,
        );

        if (inbound.length > 0 || outbound.length > 0) {
          results.push({ agentGroupId: agentGroupDir, sessionId: sessionDir, inbound, outbound });
        }
      }
    }
  } catch (err) {
    log.debug('Dashboard message scan failed', { err });
  }

  return results;
}

function readRecentMessages(dbPath: string, table: 'messages_in' | 'messages_out', limit: number): unknown[] {
  if (!fs.existsSync(dbPath)) return [];

  const db = new Database(dbPath, { readonly: true });
  try {
    return (db.prepare(`SELECT * FROM ${table} ORDER BY seq DESC LIMIT ?`).all(limit) as unknown[]).reverse();
  } catch (err) {
    log.debug('Dashboard recent message DB scan failed', { dbPath, table, err });
    return [];
  } finally {
    db.close();
  }
}

function walkFiles(dir: string, onFile: (filePath: string) => void): void {
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walkFiles(fullPath, onFile);
      } else {
        onFile(fullPath);
      }
    }
  } catch (err) {
    log.debug('Dashboard skipped unreadable directory', { dir, err });
  }
}

function fileMtimeMs(filePath: string): number {
  try {
    return fs.statSync(filePath).mtimeMs;
  } catch {
    return 0;
  }
}

function tryParseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function readNumber(value: unknown): number {
  return typeof value === 'number' ? value : 0;
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
}

function readArrayOfRecords(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value) ? value.filter((entry): entry is Record<string, unknown> => isRecord(entry)) : [];
}
