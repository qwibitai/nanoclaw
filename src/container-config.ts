import fs from 'fs';
import os from 'os';
import path from 'path';

import { getAgentBackendConfig } from './agent-backend.js';
import {
  CONTAINER_HOST_GATEWAY,
  hostGatewayArgs,
  readonlyMountArgs,
} from './container-runtime.js';
import {
  CONTAINER_IMAGE,
  CREDENTIAL_PROXY_PORT,
  DATA_DIR,
  GROUPS_DIR,
  TIMEZONE,
} from './config.js';
import { readEnvFile } from './env.js';
import { resolveGroupFolderPath, resolveGroupIpcPath } from './group-folder.js';
import { validateAdditionalMounts } from './mount-security.js';
import { isPersonalFolder } from './rc-auto-register.js';
import { RegisteredGroup } from './types.js';

export interface VolumeMount {
  hostPath: string;
  containerPath: string;
  readonly: boolean;
}

const SESSION_SETTINGS = {
  env: {
    CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
    CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: '1',
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: '0',
  },
};

function ensureGroupSessionsDir(group: RegisteredGroup): string {
  const groupSessionsRoot = path.join(DATA_DIR, 'sessions', group.folder);
  const groupSessionsDir = path.join(groupSessionsRoot, '.claude');
  fs.mkdirSync(groupSessionsDir, { recursive: true });
  fs.mkdirSync(path.join(groupSessionsRoot, '.nanoclaw'), { recursive: true });

  const settingsFile = path.join(groupSessionsDir, 'settings.json');
  if (!fs.existsSync(settingsFile)) {
    fs.writeFileSync(
      settingsFile,
      `${JSON.stringify(SESSION_SETTINGS, null, 2)}\n`,
    );
  }

  return groupSessionsDir;
}

function syncContainerSkills(groupSessionsDir: string): void {
  const skillsSrc = path.join(process.cwd(), 'container', 'skills');
  const skillsDst = path.join(groupSessionsDir, 'skills');
  if (!fs.existsSync(skillsSrc)) return;

  for (const skillDir of fs.readdirSync(skillsSrc)) {
    const srcDir = path.join(skillsSrc, skillDir);
    if (!fs.statSync(srcDir).isDirectory()) continue;
    fs.cpSync(srcDir, path.join(skillsDst, skillDir), { recursive: true });
  }
}

function ensureGroupIpcDir(group: RegisteredGroup): string {
  const groupIpcDir = resolveGroupIpcPath(group.folder);
  fs.mkdirSync(path.join(groupIpcDir, 'messages'), { recursive: true });
  fs.mkdirSync(path.join(groupIpcDir, 'tasks'), { recursive: true });
  fs.mkdirSync(path.join(groupIpcDir, 'input'), { recursive: true });
  return groupIpcDir;
}

function addPersonalMounts(mounts: VolumeMount[], personalMode: boolean): void {
  if (personalMode && fs.existsSync(path.join(os.homedir(), '.gmail-mcp'))) {
    mounts.push({
      hostPath: path.join(os.homedir(), '.gmail-mcp'),
      containerPath: '/home/node/.gmail-mcp',
      readonly: false,
    });
  }

  const outlookTokenFile = path.join(os.homedir(), '.outlook-mcp-tokens.json');
  if (personalMode && fs.existsSync(outlookTokenFile)) {
    mounts.push({
      hostPath: outlookTokenFile,
      containerPath: '/home/node/.outlook-mcp-tokens.json',
      readonly: false,
    });
  }

  const figmaMcpDir = path.join(
    os.homedir(),
    'Projects',
    'figmainhousemcp',
    'dist',
  );
  if (fs.existsSync(figmaMcpDir)) {
    mounts.push({
      hostPath: figmaMcpDir,
      containerPath: '/workspace/figma-mcp',
      readonly: true,
    });
  }
}

export function buildVolumeMounts(
  group: RegisteredGroup,
  isMain: boolean,
): VolumeMount[] {
  const mounts: VolumeMount[] = [];
  const projectRoot = process.cwd();
  const groupDir = resolveGroupFolderPath(group.folder);

  if (isMain) {
    mounts.push({
      hostPath: projectRoot,
      containerPath: '/workspace/project',
      readonly: true,
    });

    const envFile = path.join(projectRoot, '.env');
    if (fs.existsSync(envFile)) {
      mounts.push({
        hostPath: '/dev/null',
        containerPath: '/workspace/project/.env',
        readonly: true,
      });
    }
  }

  mounts.push({
    hostPath: groupDir,
    containerPath: '/workspace/group',
    readonly: false,
  });

  const globalDir = path.join(GROUPS_DIR, 'global');
  if (fs.existsSync(globalDir)) {
    mounts.push({
      hostPath: globalDir,
      containerPath: '/workspace/global',
      readonly: true,
    });
  }

  const groupSessionsDir = ensureGroupSessionsDir(group);
  syncContainerSkills(groupSessionsDir);
  mounts.push({
    hostPath: groupSessionsDir,
    containerPath: '/home/node/.claude',
    readonly: false,
  });
  mounts.push({
    hostPath: path.join(path.dirname(groupSessionsDir), '.nanoclaw'),
    containerPath: '/home/node/.nanoclaw',
    readonly: false,
  });

  const groupIpcDir = ensureGroupIpcDir(group);
  mounts.push({
    hostPath: groupIpcDir,
    containerPath: '/workspace/ipc',
    readonly: false,
  });

  const personalMode = isMain || isPersonalFolder(group.folder, GROUPS_DIR);
  addPersonalMounts(mounts, personalMode);

  if (group.containerConfig?.additionalMounts) {
    mounts.push(
      ...validateAdditionalMounts(
        group.containerConfig.additionalMounts,
        group.name,
        personalMode,
      ),
    );
  }

  return mounts;
}

export function buildContainerArgs(
  mounts: VolumeMount[],
  containerName: string,
  personalMode = false,
): string[] {
  const args: string[] = ['run', '-i', '--rm', '--name', containerName];
  const backendConfig = getAgentBackendConfig();
  const containerEnv = readEnvFile([
    'WEB_FETCH_INSECURE_TLS',
    'WEB_FETCH_CA_BUNDLE',
  ]);

  args.push('-e', `TZ=${TIMEZONE}`);
  args.push('-e', `NANOCLAW_AGENT_BACKEND=${backendConfig.backend}`);
  if (backendConfig.model) {
    args.push('-e', `AGENT_MODEL=${backendConfig.model}`);
  }
  args.push(
    '-e',
    `${backendConfig.containerBaseUrlEnvVar}=http://${CONTAINER_HOST_GATEWAY}:${CREDENTIAL_PROXY_PORT}`,
  );
  args.push('-e', `${backendConfig.containerCredentialEnvVar}=placeholder`);
  for (const [key, value] of Object.entries(containerEnv)) {
    if (value) args.push('-e', `${key}=${value}`);
  }

  args.push(...hostGatewayArgs());

  if (personalMode) {
    const thirdPartyEnv = readEnvFile([
      'JIRA_TOKEN',
      'CONFLUENCE_READ_TOKEN',
      'GITLAB_PERSONAL_ACCESS_TOKEN',
      'RC_CLIENT_ID',
      'RC_CLIENT_SECRET',
      'RC_JWT',
      'RC_SERVER',
      'OUTLOOK_CLIENT_ID',
      'OUTLOOK_CLIENT_SECRET',
      'MS_TENANT_ID',
      'JENKINS_URL',
      'JENKINS_USER',
      'JENKINS_TOKEN',
    ]);
    for (const [key, value] of Object.entries(thirdPartyEnv)) {
      if (value) args.push('-e', `${key}=${value}`);
    }
  }

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
