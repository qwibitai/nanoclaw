import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';

import { inspectCodexAuth, resolveCodexAuthFile } from '../../../codex-auth.js';
import { readEnvFileAt } from '../../../env.js';
import type {
  AgentProvider,
  PreparedSession,
  ProviderCheckResult,
  ProviderRuntimeInput,
  RuntimeInvocationContext,
} from '../../provider-types.js';

const PROVIDER_ID = 'codex';
const AUTH_CACHE_FILENAME = 'auth.json';
const AUTH_SOURCE_METADATA_KEY = 'codexAuthSourceFile';
const AUTH_SOURCE_HASH_METADATA_KEY = 'codexAuthSourceHash';

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

function getApiKeyWarning(
  env: NodeJS.ProcessEnv,
  projectRoot: string,
): string | null {
  const envFileKeys = readEnvFileAt(projectRoot, [
    'OPENAI_API_KEY',
    'CODEX_API_KEY',
  ]);
  const presentKeys = ['OPENAI_API_KEY', 'CODEX_API_KEY'].filter((key) =>
    hasConfiguredCredential(env, envFileKeys, key),
  );

  if (presentKeys.length === 0) {
    return null;
  }

  const listedKeys =
    presentKeys.length === 1
      ? presentKeys[0]
      : `${presentKeys.slice(0, -1).join(', ')} and ${presentKeys.at(-1)}`;

  return `${listedKeys} ${
    presentKeys.length === 1 ? 'is' : 'are'
  } ignored by the built-in Codex provider. Run codex logout, then codex or codex login --device-auth to use ChatGPT subscription auth instead.`;
}

function getAuthSourceFile(
  preparedSession: PreparedSession,
): string | undefined {
  const authSource = preparedSession.metadata?.[AUTH_SOURCE_METADATA_KEY];
  return typeof authSource === 'string' ? authSource : undefined;
}

function getAuthSourceHash(
  preparedSession: PreparedSession,
): string | undefined {
  const authSourceHash =
    preparedSession.metadata?.[AUTH_SOURCE_HASH_METADATA_KEY];
  return typeof authSourceHash === 'string' ? authSourceHash : undefined;
}

function fingerprintContents(contents: Buffer): string {
  return createHash('sha256').update(contents).digest('hex');
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
    validateHost(env, projectRoot) {
      const inspection = inspectCodexAuth(env, projectRoot);
      const checks: ProviderCheckResult[] = [];
      const apiKeyWarning = getApiKeyWarning(env, projectRoot);

      if (!inspection.cliAvailable) {
        checks.push({
          status: 'error',
          code: 'codex_cli_missing',
          message:
            'Codex CLI is required for the built-in Codex provider. Install codex and run codex login or codex login --device-auth.',
        });
      } else if (inspection.loginMethod === 'chatgpt') {
        if (inspection.authFileExists) {
          checks.push({
            status: 'ok',
            code: 'auth_configured',
            message: `Codex is configured with ChatGPT subscription auth via ${inspection.authFilePath}.`,
          });
        } else {
          checks.push({
            status: 'error',
            code: 'auth_cache_missing',
            message: `Codex is logged in with ChatGPT, but ${inspection.authFilePath} was not found. Switch Codex to file-backed credentials or copy auth.json into that path before running NanoClaw.`,
          });
        }
      } else if (inspection.loginMethod === 'api_key') {
        checks.push({
          status: 'error',
          code: 'auth_wrong_method',
          message: inspection.authFileExists
            ? `Codex auth cache at ${inspection.authFilePath} is logged in using an API key. Run codex logout, then codex or codex login --device-auth to switch to ChatGPT subscription auth.`
            : `Codex is logged in using an API key, but ${inspection.authFilePath} was not found. Switch Codex to file-backed ChatGPT login or set CODEX_AUTH_FILE to the correct auth.json path.`,
        });
      } else if (inspection.loginMethod === 'none') {
        checks.push({
          status: 'error',
          code: 'auth_missing',
          message: inspection.authFileExists
            ? `Codex auth cache at ${inspection.authFilePath} is not logged in. Run codex logout, then codex or codex login --device-auth to sign in with ChatGPT.`
            : `Codex requires ChatGPT login. Run codex login or codex login --device-auth in the environment where NanoClaw runs, and ensure ${inspection.authFilePath} is available.`,
        });
      } else {
        checks.push({
          status: 'error',
          code: 'auth_unverified',
          message: inspection.error
            ? `NanoClaw could not verify Codex login state: ${inspection.error}`
            : `NanoClaw could not verify Codex login state from ${inspection.authFilePath}.`,
        });
      }

      if (apiKeyWarning) {
        checks.push({
          status: 'warning',
          code: 'api_keys_ignored',
          message: apiKeyWarning,
        });
      }

      return checks;
    },
    prepareSession(ctx) {
      const providerStateDir = path.join(
        ctx.dataDir,
        'sessions',
        ctx.groupFolder,
        PROVIDER_ID,
      );
      const authSourceFile = resolveCodexAuthFile(process.env, ctx.projectRoot);
      const authTargetFile = path.join(providerStateDir, AUTH_CACHE_FILENAME);
      const files = [
        {
          sourcePath: path.join(ctx.groupDir, 'AGENT.md'),
          targetPath: path.join(ctx.groupDir, 'AGENTS.md'),
        },
      ];

      const allowedSourceRoots: string[] = [];
      const metadata: Record<string, unknown> = {};

      if (fs.existsSync(authSourceFile)) {
        const authSourceContents = fs.readFileSync(authSourceFile);
        files.push({
          sourcePath: authSourceFile,
          targetPath: authTargetFile,
        });
        allowedSourceRoots.push(path.dirname(authSourceFile));
        metadata[AUTH_SOURCE_METADATA_KEY] = authSourceFile;
        metadata[AUTH_SOURCE_HASH_METADATA_KEY] =
          fingerprintContents(authSourceContents);
      } else if (fs.existsSync(authTargetFile)) {
        fs.rmSync(authTargetFile, { force: true });
      }

      return {
        providerStateDir,
        allowedSourceRoots,
        files,
        metadata,
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
    finalizeSession(ctx) {
      const authSourceFile = getAuthSourceFile(ctx.preparedSession);
      const authSourceHash = getAuthSourceHash(ctx.preparedSession);
      if (!authSourceFile) {
        return;
      }

      const refreshedAuthFile = path.join(
        ctx.preparedSession.providerStateDir,
        AUTH_CACHE_FILENAME,
      );
      if (!fs.existsSync(refreshedAuthFile)) {
        return;
      }

      const refreshedContents = fs.readFileSync(refreshedAuthFile);
      if (!authSourceHash || !fs.existsSync(authSourceFile)) {
        return;
      }

      const existingContents = fs.readFileSync(authSourceFile);
      if (refreshedContents.equals(existingContents)) {
        return;
      }

      if (fingerprintContents(existingContents) !== authSourceHash) {
        return;
      }

      fs.mkdirSync(path.dirname(authSourceFile), { recursive: true });
      fs.copyFileSync(refreshedAuthFile, authSourceFile);
    },
    async startRemoteControl() {
      return {
        status: 'unsupported',
        message: 'Codex does not support remote control in NanoClaw v1.',
      };
    },
  };
}
