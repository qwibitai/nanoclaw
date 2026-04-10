/**
 * Agent runner for NanoClaw.
 * Supports container execution (default) and optional host execution.
 */
import fs from 'fs';
import path from 'path';

import {
  AGENT_RUNTIME,
  DATA_DIR,
  TIMEZONE,
  getEffectiveModelConfig,
} from '../core/config.js';
import { logger } from '../core/logger.js';
import { RegisteredGroup } from '../core/types.js';
import { resolveGroupFolderPath } from '../platform/group-folder.js';
import { CONTAINER_RUNTIME_BIN } from './container-runtime.js';
import {
  getHostRuntimeCredentialEnv,
  normalizeHostRuntimeEnv,
  prepareHostRuntimeContext,
} from './container-runner-host.js';
import { getPromptProfileService } from './prompt-profile.js';
import {
  buildContainerArgs,
  buildVolumeMounts,
} from './container-runner-mounts.js';
import { executeRunnerProcess } from './container-runner-process.js';
import {
  ContainerInput,
  ContainerOutput,
  RunContainerAgentOptions,
  VolumeMount,
} from './container-runner-types.js';

export {
  writeGroupsSnapshot,
  writeTasksSnapshot,
} from './container-runner-snapshots.js';
export type {
  AvailableGroup,
  ContainerInput,
  ContainerOutput,
} from './container-runner-types.js';

/** @internal - for tests only */
export function _normalizeHostRuntimeEnvForTests(
  input: Record<string, string>,
): Record<string, string> {
  return normalizeHostRuntimeEnv(input);
}

export async function runContainerAgent(
  group: RegisteredGroup,
  input: ContainerInput,
  onProcess: (
    proc: import('child_process').ChildProcess,
    containerName: string,
  ) => void,
  onOutput?: (output: ContainerOutput) => Promise<void>,
  options?: RunContainerAgentOptions,
): Promise<ContainerOutput> {
  const startTime = Date.now();

  const groupDir = resolveGroupFolderPath(group.folder);
  fs.mkdirSync(groupDir, { recursive: true });

  const safeName = group.folder.replace(/[^a-zA-Z0-9-]/g, '-');
  const processName = `nanoclaw-${safeName}-${Date.now()}`;
  const modelConfig = getEffectiveModelConfig(group.containerConfig?.model);
  const runtime = AGENT_RUNTIME;
  const promptProfileService = getPromptProfileService();
  const runnerLabel = runtime === 'host' ? 'Host agent' : 'Container';
  const agentIdentifier = input.isMain
    ? undefined
    : group.folder.toLowerCase().replace(/_/g, '-');

  const mounts: VolumeMount[] = [];
  let command = CONTAINER_RUNTIME_BIN;
  let args: string[] = [];
  let env: NodeJS.ProcessEnv | undefined;
  let runtimeDetails: string[] = [];
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

  const runnerInput: ContainerInput = {
    ...input,
    compiledSystemPrompt,
  };

  if (runtime === 'host') {
    const hostRuntime = prepareHostRuntimeContext(group);
    const hostCredentials = await getHostRuntimeCredentialEnv(agentIdentifier);
    const agentRunnerDir = path.join(
      process.cwd(),
      'container',
      'agent-runner',
      'dist',
    );
    const hostRunnerPath = path.join(agentRunnerDir, 'index.js');
    const mcpServerPath = path.join(agentRunnerDir, 'ipc-mcp-stdio.js');
    if (!fs.existsSync(hostRunnerPath) || !fs.existsSync(mcpServerPath)) {
      return {
        status: 'error',
        result: null,
        error:
          'Host runtime is missing built agent-runner files. Run "npm --prefix container/agent-runner run build".',
      };
    }

    command = process.execPath;
    args = [hostRunnerPath];
    env = {
      ...process.env,
      ...hostCredentials.env,
      TZ: TIMEZONE,
      HOME: hostRuntime.groupSessionRoot,
      NANOCLAW_WORKSPACE_GROUP_DIR: hostRuntime.groupDir,
      NANOCLAW_WORKSPACE_GLOBAL_DIR: hostRuntime.globalDir || '',
      NANOCLAW_WORKSPACE_EXTRA_DIR: path.join(
        DATA_DIR,
        'sessions',
        group.folder,
        'extra',
      ),
      NANOCLAW_IPC_INPUT_DIR: path.join(hostRuntime.groupIpcDir, 'input'),
    };
    if (modelConfig.model) {
      env.ANTHROPIC_MODEL = modelConfig.model;
      env.CLAUDE_MODEL = modelConfig.model;
    }

    runtimeDetails = [
      `groupDir=${hostRuntime.groupDir}`,
      `globalDir=${hostRuntime.globalDir || '(none)'}`,
      `home=${hostRuntime.groupSessionRoot}`,
      `ipcInput=${path.join(hostRuntime.groupIpcDir, 'input')}`,
      `onecliApplied=${hostCredentials.onecliApplied}`,
      `onecliCaPath=${hostCredentials.onecliCaPath || '(none)'}`,
      `runner=${hostRunnerPath}`,
    ];
  } else {
    mounts.push(...buildVolumeMounts(group, input.isMain));
    // Main group uses the default OneCLI agent; others use their own agent.
    args = await buildContainerArgs(
      mounts,
      processName,
      modelConfig.model,
      agentIdentifier,
    );
    runtimeDetails = mounts.map(
      (m) => `${m.hostPath} -> ${m.containerPath}${m.readonly ? ' (ro)' : ''}`,
    );
  }

  logger.debug(
    {
      group: group.name,
      runtime,
      processName,
      command,
      args: args.join(' '),
      runtimeDetails,
    },
    `${runnerLabel} runtime configuration`,
  );

  logger.info(
    {
      group: group.name,
      runtime,
      processName,
      model: modelConfig.model ?? null,
      modelSource: modelConfig.source,
      mountCount: mounts.length,
      isMain: input.isMain,
      systemPromptChars: compiledSystemPrompt.length,
    },
    `Spawning ${runnerLabel.toLowerCase()}`,
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
    runtime,
    runnerLabel,
    processName,
    startTime,
    logsDir,
    runtimeDetails,
    mounts,
  });
}
