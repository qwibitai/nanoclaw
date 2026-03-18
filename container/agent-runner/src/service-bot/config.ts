// Bot configuration — maps bot identifiers to their infrastructure details.

export interface BotConfig {
  name: string;
  sshTarget: string; // e.g. "ubuntu@54.197.72.152" or "rog"
  container: string;
  configPaths: string[];
  githubIssuesRepo: string; // "owner/repo" — where the bot opens/tracks issues
  githubSourceRepo: string; // "owner/repo" — deployment code & config
  localProjectDir: string; // Mac directory with CLAUDE.md, guidelines, memory
  framework: string;
  notes: string[];
  telemetryBotId: string; // UUID used by the UTI telemetry service
}

export const BOTS: Record<string, BotConfig> = {
  db: {
    name: 'DB',
    sshTarget: 'ubuntu@54.197.72.152',
    container: 'openclaw-openclaw-gateway-1',
    configPaths: ['/root/.openclaw/openclaw.json'],
    githubIssuesRepo: 'neuron-box/db-issues',
    githubSourceRepo: 'neuron-box/db-ec2',
    localProjectDir: '~/personal/projects/claw/DB_EC2',
    framework: 'OpenClaw',
    notes: [
      'Config is root-owned — use sudo for reads/writes',
      'Clear sessions.json after config edits',
      'Workspace files must be < 10K chars',
      'Watchdog kills runaway containers',
    ],
    telemetryBotId: '90162a8a-70eb-4d53-ab7a-359380ac34f2',
  },
  nook: {
    name: 'Nook',
    sshTarget: 'rog',
    container: 'letta-server',
    configPaths: [
      '/home/thh3/letta/docker/.env',
      '/home/thh3/letta/docker/docker-compose.yml',
    ],
    githubIssuesRepo: 'thamam/nook',
    githubSourceRepo: 'thamam/nook',
    localProjectDir: '~/personal/projects/nook',
    framework: 'Letta',
    notes: [
      'REST API at http://localhost:8283/v1/ — trailing slashes required',
      '1-def-0-imports tool rule',
      'Memory is global across channels',
      'docker compose down -v = DATA LOSS — never use',
      'LettaBot bridge is systemd service, not Docker',
    ],
    telemetryBotId: 'ee088199-6990-4818-ae58-a1be1cc8d4bb',
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
