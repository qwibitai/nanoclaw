import fs from 'fs';
import path from 'path';

import { DATA_DIR } from '../core/config.js';

const CLAUDE_SESSION_SETTINGS = {
  env: {
    // Enable agent swarms (subagent orchestration)
    // https://code.claude.com/docs/en/agent-teams#orchestrate-teams-of-claude-code-sessions
    CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
    // Prompt bootstrap is assembled by NanoClaw; keep implicit directory loading off.
    CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: '0',
    // Enable Claude's memory feature (persists user preferences between sessions)
    // https://code.claude.com/docs/en/memory#manage-auto-memory
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: '0',
  },
};

export function ensureGroupSessionSettings(groupSessionsDir: string): void {
  fs.mkdirSync(groupSessionsDir, { recursive: true });
  const settingsFile = path.join(groupSessionsDir, 'settings.json');
  let existingSettings: unknown = {};
  if (fs.existsSync(settingsFile)) {
    try {
      existingSettings = JSON.parse(fs.readFileSync(settingsFile, 'utf-8'));
    } catch {
      existingSettings = {};
    }
  }

  const current =
    existingSettings && typeof existingSettings === 'object'
      ? (existingSettings as Record<string, unknown>)
      : {};
  const existingEnv =
    current.env && typeof current.env === 'object'
      ? (current.env as Record<string, unknown>)
      : {};
  const merged = {
    ...current,
    env: {
      ...existingEnv,
      ...CLAUDE_SESSION_SETTINGS.env,
    },
  };

  fs.writeFileSync(settingsFile, JSON.stringify(merged, null, 2) + '\n');
}

export function syncGroupSkills(groupSessionsDir: string): void {
  const skillsSrc = path.join(process.cwd(), 'container', 'skills');
  const skillsDst = path.join(groupSessionsDir, 'skills');
  if (!fs.existsSync(skillsSrc)) return;

  for (const skillDir of fs.readdirSync(skillsSrc)) {
    const srcDir = path.join(skillsSrc, skillDir);
    if (!fs.statSync(srcDir).isDirectory()) continue;
    const dstDir = path.join(skillsDst, skillDir);
    fs.cpSync(srcDir, dstDir, { recursive: true });
  }
}

export function ensureGroupIpcLayout(groupIpcDir: string): void {
  fs.mkdirSync(path.join(groupIpcDir, 'messages'), { recursive: true });
  fs.mkdirSync(path.join(groupIpcDir, 'tasks'), { recursive: true });
  fs.mkdirSync(path.join(groupIpcDir, 'input'), { recursive: true });
  fs.mkdirSync(path.join(groupIpcDir, 'memory-requests'), { recursive: true });
  fs.mkdirSync(path.join(groupIpcDir, 'memory-responses'), { recursive: true });
}

export function syncGroupAgentRunnerSource(groupFolder: string): string {
  const projectRoot = process.cwd();
  const agentRunnerSrc = path.join(
    projectRoot,
    'container',
    'agent-runner',
    'src',
  );
  const groupAgentRunnerDir = path.join(
    DATA_DIR,
    'sessions',
    groupFolder,
    'agent-runner-src',
  );

  if (!fs.existsSync(agentRunnerSrc)) {
    return groupAgentRunnerDir;
  }

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

  return groupAgentRunnerDir;
}
