import path from 'path';

import { readEnvFile } from '../../../env.js';
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

function hasConfiguredCredential(
  env: NodeJS.ProcessEnv,
  envFileKeys: Record<string, string>,
  key: string,
): boolean {
  return Boolean(env[key]?.trim() || envFileKeys[key]?.trim());
}

export function createCodexProvider(): AgentProvider {
  return {
    id: PROVIDER_ID,
    displayName: 'Codex',
    capabilities: {
      persistentSessions: true,
      projectMemory: true,
      remoteControl: false,
      agentTeams: false,
      providerSkills: false,
    },
    validateHost(env) {
      const envFileKeys = readEnvFile(['OPENAI_API_KEY', 'CODEX_API_KEY']);
      const hasCredential =
        hasConfiguredCredential(env, envFileKeys, 'OPENAI_API_KEY') ||
        hasConfiguredCredential(env, envFileKeys, 'CODEX_API_KEY');

      if (hasCredential) {
        return [
          {
            status: 'ok',
            code: 'auth_configured',
            message:
              'Codex credentials are configured via OPENAI_API_KEY or CODEX_API_KEY.',
          },
        ];
      }

      return [
        {
          status: 'error',
          code: 'auth_missing',
          message: 'Codex requires OPENAI_API_KEY or CODEX_API_KEY.',
        },
      ];
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
    async startRemoteControl() {
      return {
        status: 'unsupported',
        message: 'Codex does not support remote control in NanoClaw v1.',
      };
    },
  };
}
