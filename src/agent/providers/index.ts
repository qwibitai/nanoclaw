import path from 'path';

import type {
  AgentProvider,
  PrepareSessionContext,
  ProviderCapabilities,
  RuntimeInvocationContext,
} from '../provider-types.js';

function createPreparedSession(
  providerStateDirName: string,
  ctx: PrepareSessionContext,
) {
  return {
    providerStateDir: path.join(
      ctx.dataDir,
      'sessions',
      ctx.groupFolder,
      providerStateDirName,
    ),
    memoryFiles: [],
  };
}

function createRuntimeInput(
  providerId: string,
  ctx: RuntimeInvocationContext,
) {
  return {
    providerId,
    sessionId: ctx.sessionId,
    payload: {
      prompt: ctx.prompt,
      groupFolder: ctx.groupFolder,
      chatJid: ctx.chatJid,
      isMain: ctx.isMain,
      isScheduledTask: ctx.isScheduledTask ?? false,
      assistantName: ctx.assistantName,
      script: ctx.script,
      options: ctx.providerOptions,
    },
  };
}

function createBuiltInProvider(
  id: 'claude-code' | 'codex',
  displayName: string,
  capabilities: ProviderCapabilities,
): AgentProvider {
  return {
    id,
    displayName,
    capabilities,
    validateHost() {
      return [];
    },
    prepareSession(ctx) {
      return createPreparedSession(id, ctx);
    },
    buildContainerSpec() {
      return {
        mounts: [],
        env: {},
      };
    },
    serializeRuntimeInput(ctx) {
      return createRuntimeInput(id, ctx);
    },
  };
}

export const builtInProviders: readonly AgentProvider[] = [
  createBuiltInProvider('claude-code', 'Claude Code', {
    persistentSessions: true,
    projectMemory: true,
    remoteControl: true,
    agentTeams: true,
    providerSkills: true,
  }),
  createBuiltInProvider('codex', 'Codex', {
    persistentSessions: true,
    projectMemory: true,
    remoteControl: false,
    agentTeams: true,
    providerSkills: true,
  }),
];
