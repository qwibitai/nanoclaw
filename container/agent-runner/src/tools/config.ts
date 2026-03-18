// Bot configuration — maps bot identifiers to their infrastructure details.

export interface BotConfig {
  name: string;
  sshTarget: string; // e.g. "ubuntu@54.197.72.152" or "rog"
  container: string;
  configPaths: string[];
  githubRepo: string; // "owner/repo" format
  framework: string;
  notes: string[];
}

export const BOTS: Record<string, BotConfig> = {
  db: {
    name: 'DB',
    sshTarget: 'ubuntu@54.197.72.152',
    container: 'openclaw-openclaw-gateway-1',
    configPaths: ['/root/.openclaw/openclaw.json'],
    githubRepo: 'neuron-box/db-issues',
    framework: 'OpenClaw',
    notes: [
      'Config is root-owned — use sudo for reads/writes',
      'Clear sessions.json after config edits',
      'Workspace files must be < 10K chars',
      'Watchdog kills runaway containers',
    ],
  },
  nook: {
    name: 'Nook',
    sshTarget: 'rog',
    container: 'letta-server',
    configPaths: [
      '/home/thh3/nook/docker/.env',
      '/home/thh3/nook/docker/docker-compose.yml',
    ],
    githubRepo: 'thamam/lettabot',
    framework: 'Letta',
    notes: [
      'REST API at http://localhost:8283/v1/ — trailing slashes required',
      '1-def-0-imports tool rule',
      'Memory is global across channels',
      'docker compose down -v = DATA LOSS — never use',
      'LettaBot bridge is systemd service, not Docker',
    ],
  },
};

export function getBotConfig(bot: string): BotConfig {
  const config = BOTS[bot.toLowerCase()];
  if (!config) {
    throw new Error(
      `Unknown bot "${bot}". Valid bots: ${Object.keys(BOTS).join(', ')}`,
    );
  }
  return config;
}

export const SSH_CONNECT_TIMEOUT = 10;
export const SSH_COMMAND_TIMEOUT = 30;
export const MAX_LOG_LINES = 500;
export const MAX_SEARCH_DEPTH = 5000;
export const MAX_FILE_SIZE = 50 * 1024; // 50KB for reads
export const MAX_EDIT_FILE_SIZE = 100 * 1024; // 100KB for edits

export const ALLOWED_DOCKER_ACTIONS = ['restart', 'stop', 'start', 'exec'] as const;
export type DockerAction = (typeof ALLOWED_DOCKER_ACTIONS)[number];

export const BLOCKED_DOCKER_PATTERNS = [
  'down',
  'rm',
  'prune',
  'volume rm',
  'volume remove',
  'compose down',
] as const;
