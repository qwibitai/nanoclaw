import { ChildProcess } from 'child_process';

import { ClaudeHostInput, runClaudeHostAgent } from '../claude-host-runner.js';
import { CodexHostInput, runCodexHostAgent } from '../codex-host-runner.js';
import {
  ContainerInput,
  ContainerOutput,
  runContainerAgent,
} from '../container-runner.js';
import {
  cleanupOrphans,
  ensureContainerRuntimeRunning,
} from '../container-runtime.js';
import { runHostAgent, type HostAgentCli } from '../host-runner.js';
import { logger } from '../logger.js';
import { RegisteredGroup } from '../types.js';

export interface AgentRuntime {
  kind: 'container' | 'host';
  supportsSteering: boolean;
  run(input: AgentRuntimeRunInput): Promise<AgentRunResult>;
}

export interface AgentRuntimeRunInput
  extends ContainerInput, ClaudeHostInput, CodexHostInput {
  group: RegisteredGroup;
  onProcess?: (
    proc: ChildProcess,
    containerName: string,
    groupFolder: string,
  ) => void;
  onOutput?: (output: AgentRunResult) => Promise<void>;
}

export type AgentRunResult = ContainerOutput;

let containerRuntimePrepared = false;

function normalizeLegacyAgentType(agentCli?: string): string {
  switch (agentCli) {
    case 'gemini':
    case 'copilot':
    case 'codex':
      return agentCli;
    default:
      return 'claude-code';
  }
}

export function getAgentType(group: RegisteredGroup): string {
  return (
    group.agentType ?? normalizeLegacyAgentType(group.containerConfig?.agentCli)
  );
}

export function isHostAgentType(
  agentType: string,
): agentType is HostAgentCli | 'claude-code' {
  return (
    agentType === 'claude-code' ||
    agentType === 'gemini' ||
    agentType === 'copilot' ||
    agentType === 'codex'
  );
}

function isCliHostAgentType(agentType: string): agentType is HostAgentCli {
  return agentType === 'gemini' || agentType === 'copilot';
}

export function requiresContainerRuntime(group: RegisteredGroup): boolean {
  return !isHostAgentType(getAgentType(group));
}

export function serviceNeedsContainerRuntime(
  groups: Record<string, RegisteredGroup>,
): boolean {
  return Object.values(groups).some((group) => requiresContainerRuntime(group));
}

export function ensureContainerRuntimeReady(): void {
  if (containerRuntimePrepared) return;
  ensureContainerRuntimeRunning();
  cleanupOrphans();
  containerRuntimePrepared = true;
}

export function ensureRequiredRuntimes(
  groups: Record<string, RegisteredGroup>,
): void {
  if (serviceNeedsContainerRuntime(groups)) {
    ensureContainerRuntimeReady();
    return;
  }

  logger.info(
    'Skipping container runtime startup; no registered groups require it',
  );
}

export function resolveAgentRuntime(group: RegisteredGroup): AgentRuntime {
  const agentType = getAgentType(group);
  if (agentType === 'claude-code') {
    return {
      kind: 'host',
      supportsSteering: true,
      run: async ({ group, onOutput, onProcess, ...input }) =>
        runClaudeHostAgent(
          group,
          input,
          (proc, processName) =>
            onProcess?.(proc, processName, input.groupFolder),
          onOutput,
        ),
    };
  }

  if (agentType === 'codex') {
    return {
      kind: 'host',
      supportsSteering: true,
      run: async ({ group, onOutput, onProcess, ...input }) =>
        runCodexHostAgent(
          group,
          input,
          (proc, processName) =>
            onProcess?.(proc, processName, input.groupFolder),
          onOutput,
        ),
    };
  }

  if (isCliHostAgentType(agentType)) {
    return {
      kind: 'host',
      supportsSteering: false,
      run: async ({ group, prompt, groupFolder, onOutput, sessionId }) =>
        runHostAgent(agentType, prompt, groupFolder, {
          resumeSessionId: sessionId,
          modelOverride: group.containerConfig?.model,
          reasoningEffortOverride: group.containerConfig?.reasoningEffort,
          onOutput,
        }),
    };
  }

  return {
    kind: 'container',
    supportsSteering: true,
    run: async ({ group, onOutput, onProcess, ...input }) => {
      ensureContainerRuntimeReady();
      return runContainerAgent(
        group,
        input,
        (proc, containerName) =>
          onProcess?.(proc, containerName, input.groupFolder),
        onOutput,
      );
    },
  };
}

export function _resetRuntimeStateForTests(): void {
  containerRuntimePrepared = false;
}
