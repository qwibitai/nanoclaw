/**
 * Agent runner for NanoClaw — host-only execution.
 */
import fs from 'fs';
import path from 'path';

import {
  AGENT_MEMORY_ROOT,
  DATA_DIR,
  AGENT_ROOT,
  PERMISSION_APPROVAL_TIMEOUT_MS,
  TIMEZONE,
  getEffectiveModelConfig,
} from '../core/config.js';
import { logger } from '../core/logger.js';
import { RegisteredGroup } from '../core/types.js';
import { resolveGroupFolderPath } from '../platform/group-folder.js';
import {
  getHostRuntimeCredentialEnv,
  prepareHostRuntimeContext,
} from './agent-spawn-host.js';
import { computeIpcAuthToken } from './ipc-auth.js';
import { getPromptProfileService } from './prompt-profile.js';
import { executeRunnerProcess } from './agent-spawn-process.js';
import {
  AgentInput,
  AgentOutput,
  RunAgentOptions,
} from './agent-spawn-types.js';

export {
  writeJobRunsSnapshot,
  writeJobsSnapshot,
  writeGroupsSnapshot,
} from './agent-spawn-snapshots.js';
export type {
  AvailableGroup,
  AgentInput,
  AgentOutput,
} from './agent-spawn-types.js';

const SAFE_HOST_ENV_KEYS = [
  'PATH',
  'TMPDIR',
  'TMP',
  'TEMP',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TERM',
  'COLORTERM',
  'NO_COLOR',
  'FORCE_COLOR',
  'SSL_CERT_FILE',
  'NODE_EXTRA_CA_CERTS',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
] as const;

function pickSafeHostEnv(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of SAFE_HOST_ENV_KEYS) {
    const value = source[key];
    if (typeof value === 'string' && value.length > 0) {
      env[key] = value;
    }
  }
  return env;
}

export async function spawnAgent(
  group: RegisteredGroup,
  input: AgentInput,
  onProcess: (
    proc: import('child_process').ChildProcess,
    containerName: string,
  ) => void,
  onOutput?: (output: AgentOutput) => Promise<void>,
  options?: RunAgentOptions,
): Promise<AgentOutput> {
  const startTime = Date.now();

  const groupDir = resolveGroupFolderPath(group.folder);
  fs.mkdirSync(groupDir, { recursive: true });

  const safeName = group.folder.replace(/[^a-zA-Z0-9-]/g, '-');
  const processName = `myclaw-${safeName}-${Date.now()}`;
  const modelConfig = getEffectiveModelConfig(group.agentConfig?.model);
  const promptProfileService = getPromptProfileService();
  const agentIdentifier = input.isMain
    ? undefined
    : group.folder.toLowerCase().replace(/_/g, '-');

  let compiledSystemPrompt = '';

  try {
    compiledSystemPrompt = promptProfileService.compileSystemPrompt({
      groupFolder: group.folder,
    });
  } catch (err) {
    logger.warn(
      { err, groupFolder: group.folder },
      'Failed to compile prompt profile; continuing without custom system prompt',
    );
  }

  const runnerInput: AgentInput = {
    ...input,
    compiledSystemPrompt,
  };

  const hostRuntime = prepareHostRuntimeContext(group);
  const hostCredentials = await getHostRuntimeCredentialEnv(agentIdentifier);
  const agentRunnerDir = path.join(hostRuntime.runnerRoot, 'dist');
  const hostRunnerPath = path.join(agentRunnerDir, 'index.js');
  const mcpServerPath = path.join(agentRunnerDir, 'ipc-mcp-stdio.js');
  if (!fs.existsSync(hostRunnerPath) || !fs.existsSync(mcpServerPath)) {
    return {
      status: 'error',
      result: null,
      error:
        'Host runtime is missing built agent-runner files. Run "npm --prefix agent-runner run build".',
    };
  }

  const command = process.execPath;
  const args = [hostRunnerPath];
  const env: NodeJS.ProcessEnv = {
    ...pickSafeHostEnv(process.env),
    ...hostCredentials.env,
    TZ: TIMEZONE,
    HOME: AGENT_ROOT,
    GH_CONFIG_DIR: path.join(AGENT_ROOT, '..', 'gh'),
    NANOCLAW_WORKSPACE_GROUP_DIR: hostRuntime.groupDir,
    NANOCLAW_WORKSPACE_GLOBAL_DIR: hostRuntime.globalDir || '',
    NANOCLAW_WORKSPACE_EXTRA_DIR: path.join(
      DATA_DIR,
      'sessions',
      group.folder,
      'extra',
    ),
    NANOCLAW_IPC_DIR: hostRuntime.groupIpcDir,
    NANOCLAW_IPC_INPUT_DIR: path.join(hostRuntime.groupIpcDir, 'input'),
    NANOCLAW_IPC_AUTH_TOKEN: computeIpcAuthToken(group.folder),
    NANOCLAW_PERMISSION_TIMEOUT_MS: String(PERMISSION_APPROVAL_TIMEOUT_MS),
    ...((AGENT_MEMORY_ROOT || '').trim()
      ? { AGENT_MEMORY_ROOT: (AGENT_MEMORY_ROOT || '').trim() }
      : {}),
  };
  if (modelConfig.model) {
    env.ANTHROPIC_MODEL = modelConfig.model;
    env.CLAUDE_MODEL = modelConfig.model;
  }

  const runtimeDetails = [
    `groupDir=${hostRuntime.groupDir}`,
    `globalDir=${hostRuntime.globalDir || '(none)'}`,
    `home=${AGENT_ROOT}`,
    `ipcInput=${path.join(hostRuntime.groupIpcDir, 'input')}`,
    `onecliApplied=${hostCredentials.onecliApplied}`,
    `onecliCaPath=${hostCredentials.onecliCaPath || '(none)'}`,
    `runner=${hostRunnerPath}`,
  ];

  logger.debug(
    {
      group: group.name,
      processName,
      command,
      args: args.join(' '),
      runtimeDetails,
    },
    'Host agent runtime configuration',
  );

  logger.info(
    {
      group: group.name,
      processName,
      model: modelConfig.model ?? null,
      modelSource: modelConfig.source,
      isMain: input.isMain,
      systemPromptChars: compiledSystemPrompt.length,
    },
    'Spawning host agent',
  );

  const logsDir = path.join(groupDir, 'logs');
  fs.mkdirSync(logsDir, { recursive: true });

  return executeRunnerProcess({
    group,
    input: runnerInput,
    command,
    args,
    env,
    onProcess,
    onOutput,
    options,
    runnerLabel: 'Host agent',
    processName,
    startTime,
    logsDir,
    runtimeDetails,
  });
}
