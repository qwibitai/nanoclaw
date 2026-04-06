import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { readEnvFileAt } from './env.js';

const CHATGPT_LOGIN_STATUS = 'Logged in using ChatGPT';
const API_KEY_LOGIN_STATUS = 'Logged in using an API key';
const NOT_LOGGED_IN_STATUS = 'Not logged in';
const TEMP_CONFIG = 'cli_auth_credentials_store = "file"\n';

export type CodexLoginMethod = 'chatgpt' | 'api_key' | 'none' | 'unknown';
export type CodexLoginSource = 'file' | 'external';

export interface CodexAuthInspection {
  authFilePath: string;
  authFileExists: boolean;
  cliAvailable: boolean;
  loginMethod: CodexLoginMethod;
  loginSource: CodexLoginSource;
  statusText?: string;
  error?: string;
}

export function resolveCodexAuthFile(
  env: NodeJS.ProcessEnv,
  projectRoot: string,
): string {
  const envFileKeys = readEnvFileAt(projectRoot, [
    'CODEX_AUTH_FILE',
    'CODEX_HOME',
  ]);
  const configuredPath =
    env.CODEX_AUTH_FILE?.trim() || envFileKeys.CODEX_AUTH_FILE?.trim();
  const configuredHome =
    env.CODEX_HOME?.trim() || envFileKeys.CODEX_HOME?.trim();
  const codexHome = configuredHome
    ? path.isAbsolute(configuredHome)
      ? configuredHome
      : path.resolve(projectRoot, configuredHome)
    : path.join(env.HOME || os.homedir(), '.codex');
  const defaultPath = path.join(codexHome, 'auth.json');
  const authFilePath = configuredPath || defaultPath;

  return path.isAbsolute(authFilePath)
    ? authFilePath
    : path.resolve(projectRoot, authFilePath);
}

export function inspectCodexAuth(
  env: NodeJS.ProcessEnv,
  projectRoot: string,
): CodexAuthInspection {
  const authFilePath = resolveCodexAuthFile(env, projectRoot);

  if (fs.existsSync(authFilePath)) {
    return inspectCodexAuthFile(env, authFilePath);
  }

  return inspectAmbientCodexAuth(env, authFilePath);
}

export function inspectCodexAuthFile(
  env: NodeJS.ProcessEnv,
  authFilePath: string,
): CodexAuthInspection {
  return inspectFileBackedCodexAuth(env, authFilePath);
}

function inspectFileBackedCodexAuth(
  env: NodeJS.ProcessEnv,
  authFilePath: string,
): CodexAuthInspection {
  const tempDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'nanoclaw-codex-auth-'),
  );
  const tempAuthFile = path.join(tempDir, 'auth.json');
  const tempConfigFile = path.join(tempDir, 'config.toml');

  try {
    fs.copyFileSync(authFilePath, tempAuthFile);
    fs.writeFileSync(tempConfigFile, TEMP_CONFIG);

    const statusText = runCodexLoginStatus({
      ...env,
      CODEX_HOME: tempDir,
    });

    return {
      authFilePath,
      authFileExists: true,
      cliAvailable: true,
      loginMethod: parseCodexLoginMethod(statusText),
      loginSource: 'file',
      statusText,
    };
  } catch (error) {
    return buildInspectionError(authFilePath, true, 'file', error);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function inspectAmbientCodexAuth(
  env: NodeJS.ProcessEnv,
  authFilePath: string,
): CodexAuthInspection {
  try {
    const statusText = runCodexLoginStatus(env);

    return {
      authFilePath,
      authFileExists: false,
      cliAvailable: true,
      loginMethod: parseCodexLoginMethod(statusText),
      loginSource: 'external',
      statusText,
    };
  } catch (error) {
    return buildInspectionError(authFilePath, false, 'external', error);
  }
}

function buildInspectionError(
  authFilePath: string,
  authFileExists: boolean,
  loginSource: CodexLoginSource,
  error: unknown,
): CodexAuthInspection {
  const message = error instanceof Error ? error.message : String(error);
  const lowered = message.toLowerCase();

  return {
    authFilePath,
    authFileExists,
    cliAvailable:
      !lowered.includes('enoent') &&
      !lowered.includes('not found') &&
      !lowered.includes('spawn codex'),
    loginMethod: 'unknown',
    loginSource,
    error: message,
  };
}

function runCodexLoginStatus(env: NodeJS.ProcessEnv): string {
  const result = spawnSync('codex', ['login', 'status'], {
    env,
    encoding: 'utf8',
  });
  if (result.error) {
    throw result.error;
  }

  const statusText = [result.stdout, result.stderr]
    .filter((chunk): chunk is string => Boolean(chunk))
    .join('\n')
    .trim();

  if (result.status === 0) {
    return statusText;
  }

  if (result.status === 1 && statusText.length > 0) {
    return statusText;
  }

  throw new Error(
    statusText || `codex login status exited with code ${result.status ?? -1}`,
  );
}

function parseCodexLoginMethod(statusText: string): CodexLoginMethod {
  if (statusText.includes(CHATGPT_LOGIN_STATUS)) {
    return 'chatgpt';
  }

  if (statusText.includes(API_KEY_LOGIN_STATUS)) {
    return 'api_key';
  }

  if (statusText.includes(NOT_LOGGED_IN_STATUS)) {
    return 'none';
  }

  return 'unknown';
}
