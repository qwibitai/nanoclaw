import path from 'path';

import type {
  AgentProvider,
  ProviderRuntimeInput,
  RuntimeInvocationContext,
} from '../../provider-types.js';

const PROVIDER_ID = 'codex';

function createRuntimeInput(
  ctx: RuntimeInvocationContext,
): ProviderRuntimeInput {
  return {
    prompt: ctx.prompt,
    sessionId: ctx.sessionId,
    groupFolder: ctx.groupFolder,
    chatJid: ctx.chatJid,
    isMain: ctx.isMain,
    isScheduledTask: ctx.isScheduledTask ?? false,
    assistantName: ctx.assistantName,
    script: ctx.script,
    providerData: ctx.providerOptions,
  };
}

export function createCodexProvider(): AgentProvider {
  return {
    id: PROVIDER_ID,
    displayName: 'Codex',
    capabilities: {
      persistentSessions: true,
      projectMemory: true,
      remoteControl: false,
      agentTeams: true,
      providerSkills: true,
    },
    validateHost() {
      return [];
    },
    prepareSession(ctx) {
      const providerStateDir = path.join(
        ctx.dataDir,
        'sessions',
        ctx.groupFolder,
        PROVIDER_ID,
      );

      return {
        providerStateDir,
        files: [
          {
            sourcePath: path.join(ctx.groupDir, 'AGENT.md'),
            targetPath: path.join(ctx.groupDir, 'AGENTS.md'),
          },
        ],
        directorySyncs: [
          {
            sourcePath: path.join(ctx.projectRoot, 'container', 'skills'),
            targetPath: path.join(providerStateDir, 'skills'),
          },
        ],
      };
    },
    buildContainerSpec(ctx) {
      return {
        mounts: [
          {
            hostPath: ctx.preparedSession.providerStateDir,
            containerPath: '/home/node/.codex',
            readonly: false,
          },
        ],
        env: {
          CODEX_HOME: '/home/node/.codex',
        },
        workdir: '/workspace/group',
      };
    },
    serializeRuntimeInput(ctx) {
      return createRuntimeInput(ctx);
    },
  };
}
