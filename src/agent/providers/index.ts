import path from 'path';

import type {
  AgentProvider,
  PrepareSessionContext,
  PreparedSession,
  ProviderCapabilities,
  ProviderRuntimeInput,
  RuntimeInvocationContext,
} from '../provider-types.js';

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

function createPreparedSession(
  providerId: string,
  ctx: PrepareSessionContext,
  fallbackProviderStateDirNames: string[] = [],
): PreparedSession {
  return {
    providerStateDir: path.join(
      ctx.dataDir,
      'sessions',
      ctx.groupFolder,
      providerId,
    ),
    files: [],
    fallbackProviderStateDirs: fallbackProviderStateDirNames.map((dirName) =>
      path.join(ctx.dataDir, 'sessions', ctx.groupFolder, dirName),
    ),
  };
}

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

function createClaudeProvider(): AgentProvider {
  const id = 'claude-code';

  return {
    id,
    displayName: 'Claude Code',
    capabilities: {
      persistentSessions: true,
      projectMemory: true,
      remoteControl: true,
      agentTeams: true,
      providerSkills: true,
    },
    validateHost() {
      return [];
    },
    prepareSession(ctx) {
      const session = createPreparedSession(id, ctx, ['.claude']);
      const canonicalMemoryPath = path.join(ctx.groupDir, 'AGENT.md');
      const compatibilityPath = path.join(ctx.groupDir, 'CLAUDE.md');

      session.files.push({
        sourcePath: canonicalMemoryPath,
        targetPath: compatibilityPath,
      });
      session.files.push({
        targetPath: path.join(session.providerStateDir, 'settings.json'),
        content: `${CLAUDE_SETTINGS}\n`,
      });
      session.directorySyncs = [
        {
          sourcePath: path.join(ctx.projectRoot, 'container', 'skills'),
          targetPath: path.join(session.providerStateDir, 'skills'),
        },
      ];

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
  };
}

function createCodexProvider(): AgentProvider {
  const id = 'codex';

  return {
    id,
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
      const session = createPreparedSession(id, ctx);

      session.files.push({
        sourcePath: path.join(ctx.groupDir, 'AGENT.md'),
        targetPath: path.join(ctx.groupDir, 'AGENTS.md'),
      });
      session.directorySyncs = [
        {
          sourcePath: path.join(ctx.projectRoot, 'container', 'skills'),
          targetPath: path.join(session.providerStateDir, 'skills'),
        },
      ];

      return session;
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

export const builtInProviders: readonly AgentProvider[] = [
  createClaudeProvider(),
  createCodexProvider(),
];
