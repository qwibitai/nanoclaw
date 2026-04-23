import fs from 'fs';
import path from 'path';

import type { AgentBackendType } from './backend.js';

export interface AgentBackendHomeSpec {
  type: AgentBackendType;
  homeDirName: string;
  containerHomePath: string;
  initialize(homeDir: string): void;
}

function initializeClaudeHome(homeDir: string): void {
  fs.mkdirSync(homeDir, { recursive: true });

  const settingsFile = path.join(homeDir, 'settings.json');
  if (fs.existsSync(settingsFile)) return;

  fs.writeFileSync(
    settingsFile,
    JSON.stringify(
      {
        env: {
          CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
          CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: '1',
          CLAUDE_CODE_DISABLE_AUTO_MEMORY: '0',
        },
      },
      null,
      2,
    ) + '\n',
  );
}

function initializeCodexHome(homeDir: string): void {
  fs.mkdirSync(homeDir, { recursive: true });
}

export const AGENT_BACKEND_HOME_SPECS: Record<
  AgentBackendType,
  AgentBackendHomeSpec
> = {
  claudeCode: {
    type: 'claudeCode',
    homeDirName: '.claude',
    containerHomePath: '/home/node/.claude',
    initialize: initializeClaudeHome,
  },
  codex: {
    type: 'codex',
    homeDirName: '.codex',
    containerHomePath: '/home/node/.codex',
    initialize: initializeCodexHome,
  },
};

export const AGENT_BACKEND_HOME_LIST = Object.values(AGENT_BACKEND_HOME_SPECS);

export const CONTAINER_CUSTOM_MCP_DIR = `${AGENT_BACKEND_HOME_SPECS.claudeCode.containerHomePath}/mcp`;

export function resolveAgentBackendHomeDir(
  backendRootDir: string,
  backendType: AgentBackendType,
): string {
  return path.join(
    backendRootDir,
    AGENT_BACKEND_HOME_SPECS[backendType].homeDirName,
  );
}
