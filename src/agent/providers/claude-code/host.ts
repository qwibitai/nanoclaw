import fs from 'fs';
import path from 'path';

import { readEnvFile } from '../../../env.js';
import { startRemoteControl as startClaudeRemoteControl } from './remote-control.js';
import type {
  AgentProvider,
  PreparedSession,
  ProviderRuntimeInput,
  RuntimeInvocationContext,
} from '../../provider-types.js';

const PROVIDER_ID = 'claude-code';
const LEGACY_PROVIDER_STATE_DIR = '.claude';
const CLAUDE_SETTINGS = JSON.stringify(
  {
    env: {
      CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
      CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: '1',
      CLAUDE_CODE_DISABLE_AUTO_MEMORY: '0',
    },
  },
  null,
  2,
);

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

function directoryHasEntries(directoryPath: string): boolean {
  try {
    return fs.readdirSync(directoryPath).length > 0;
  } catch {
    return false;
  }
}

function resolveProviderStateDir(
  dataDir: string,
  groupFolder: string,
): Pick<PreparedSession, 'providerStateDir' | 'allowedStateRoots'> {
  const namespacedStateDir = path.join(
    dataDir,
    'sessions',
    groupFolder,
    PROVIDER_ID,
  );
  const legacyStateDir = path.join(
    dataDir,
    'sessions',
    groupFolder,
    LEGACY_PROVIDER_STATE_DIR,
  );

  if (
    !directoryHasEntries(namespacedStateDir) &&
    directoryHasEntries(legacyStateDir)
  ) {
    return {
      providerStateDir: legacyStateDir,
      allowedStateRoots: [legacyStateDir],
    };
  }

  return {
    providerStateDir: namespacedStateDir,
  };
}

function hasConfiguredCredential(
  env: NodeJS.ProcessEnv,
  envFileKeys: Record<string, string>,
  key: string,
): boolean {
  return Boolean(env[key]?.trim() || envFileKeys[key]?.trim());
}

export function createClaudeCodeProvider(): AgentProvider {
  return {
    id: PROVIDER_ID,
    displayName: 'Claude Code',
    capabilities: {
      persistentSessions: true,
      projectMemory: true,
      remoteControl: true,
      agentTeams: true,
      providerSkills: true,
    },
    validateHost(env) {
      const envFileKeys = readEnvFile([
        'CLAUDE_CODE_OAUTH_TOKEN',
        'ANTHROPIC_API_KEY',
      ]);
      const hasCredential =
        hasConfiguredCredential(env, envFileKeys, 'CLAUDE_CODE_OAUTH_TOKEN') ||
        hasConfiguredCredential(env, envFileKeys, 'ANTHROPIC_API_KEY');

      if (hasCredential) {
        return [
          {
            status: 'ok',
            code: 'auth_configured',
            message:
              'Claude Code credentials are configured via CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY.',
          },
        ];
      }

      return [
        {
          status: 'error',
          code: 'auth_missing',
          message:
            'Claude Code requires CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY.',
        },
      ];
    },
    prepareSession(ctx) {
      const sessionRoot = resolveProviderStateDir(ctx.dataDir, ctx.groupFolder);
      const session: PreparedSession = {
        providerStateDir: sessionRoot.providerStateDir,
        allowedStateRoots: sessionRoot.allowedStateRoots,
        files: [
          {
            sourcePath: path.join(ctx.groupDir, 'AGENT.md'),
            targetPath: path.join(ctx.groupDir, 'CLAUDE.md'),
          },
          {
            targetPath: path.join(
              sessionRoot.providerStateDir,
              'settings.json',
            ),
            content: `${CLAUDE_SETTINGS}\n`,
            onlyIfMissing: true,
          },
        ],
        directorySyncs: [
          {
            sourcePath: path.join(ctx.projectRoot, 'container', 'skills'),
            targetPath: path.join(sessionRoot.providerStateDir, 'skills'),
          },
        ],
      };

      return session;
    },
    buildContainerSpec(ctx) {
      return {
        mounts: [
          {
            hostPath: ctx.preparedSession.providerStateDir,
            containerPath: '/home/node/.claude',
            readonly: false,
          },
        ],
        env: {},
        workdir: '/workspace/group',
      };
    },
    serializeRuntimeInput(ctx) {
      return createRuntimeInput(ctx);
    },
    async startRemoteControl(ctx) {
      const result = await startClaudeRemoteControl(
        ctx.sender,
        ctx.chatJid,
        ctx.projectRoot,
        PROVIDER_ID,
      );

      if (result.ok) {
        return {
          status: 'started',
          url: result.url,
        };
      }

      return {
        status: 'error',
        message: result.error,
      };
    },
  };
}
