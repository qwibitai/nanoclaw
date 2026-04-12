import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

import { AGENT_ROOT, ONECLI_URL } from '../core/config.js';
import { readEnvFile } from '../core/env.js';
import {
  getRepoAgentRunnerRoot,
  getRuntimeAgentRunnerRoot,
  syncHostAgentRunnerRuntime,
} from './agent-spawn-layout.js';

export interface RuntimeDiagnosticDetails {
  runtimeBinary: string;
  runtimeBinaryReady: boolean;
  hostRunnerPath: string;
  hostMcpPath: string;
  hostArtifactsPresent: boolean;
  runtimeConfigRoot: string;
  hostBuildAttempted: boolean;
  hostBuildSucceeded: boolean;
  onecliUrlConfigured: boolean;
  credentialPathStatus: 'onecli+env' | 'onecli-only' | 'env-only' | 'missing';
}

export interface RuntimeDiagnostics {
  ok: boolean;
  errors: string[];
  warnings: string[];
  fixes: string[];
  checkedAt: string;
  details: RuntimeDiagnosticDetails;
}

export interface RuntimeDiagnosticsOptions {
  autoBuildHostRunner?: boolean;
}

function summarizeExecError(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  return err.message.replace(/\s+/g, ' ').trim();
}

function readCredentialPathStatus():
  | 'onecli+env'
  | 'onecli-only'
  | 'env-only'
  | 'missing' {
  const envKeys = readEnvFile([
    'CLAUDE_CODE_OAUTH_TOKEN',
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_AUTH_TOKEN',
  ]);
  const hasEnvCredentials = Object.values(envKeys).some((v) => Boolean(v));
  const onecliConfigured = Boolean(ONECLI_URL?.trim());
  if (onecliConfigured && hasEnvCredentials) return 'onecli+env';
  if (onecliConfigured) return 'onecli-only';
  if (hasEnvCredentials) return 'env-only';
  return 'missing';
}

function buildHostArtifacts(
  repoRunnerRoot: string,
  hostRunnerPath: string,
  hostMcpPath: string,
  errors: string[],
  fixes: string[],
): { attempted: boolean; succeeded: boolean } {
  const attempted = true;
  if (!fs.existsSync(path.join(repoRunnerRoot, 'package.json'))) {
    errors.push(`Host runner source not found: ${repoRunnerRoot}`);
    fixes.push(
      `Restore \`${repoRunnerRoot}\` or provide prebuilt runner assets under \`${getRuntimeAgentRunnerRoot()}\`.`,
    );
    return { attempted, succeeded: false };
  }
  try {
    execSync('npm --prefix agent-runner run build', {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 300_000,
    });
    syncHostAgentRunnerRuntime();
  } catch (err) {
    errors.push(`Host runner build failed: ${summarizeExecError(err)}`);
    fixes.push(
      'Run `npm --prefix agent-runner run build` and resolve build errors.',
    );
    return { attempted, succeeded: false };
  }

  if (!fs.existsSync(hostRunnerPath) || !fs.existsSync(hostMcpPath)) {
    errors.push(
      'Host runner build completed but required artifacts are still missing.',
    );
    fixes.push(`Verify \`${hostRunnerPath}\` and \`${hostMcpPath}\` exist.`);
    return { attempted, succeeded: false };
  }
  return { attempted, succeeded: true };
}

export async function collectRuntimeDiagnostics(
  options: RuntimeDiagnosticsOptions = {},
): Promise<RuntimeDiagnostics> {
  const errors: string[] = [];
  const warnings: string[] = [];
  const fixes: string[] = [];

  const repoRunnerRoot = getRepoAgentRunnerRoot();
  const runtimeRunnerRoot = getRuntimeAgentRunnerRoot();
  syncHostAgentRunnerRuntime();
  const hostRunnerPath = path.join(runtimeRunnerRoot, 'dist', 'index.js');
  const hostMcpPath = path.join(runtimeRunnerRoot, 'dist', 'ipc-mcp-stdio.js');

  const runtimeBinaryReady = fs.existsSync(process.execPath);
  if (!runtimeBinaryReady) {
    errors.push(`Host runtime binary not found: ${process.execPath}`);
    fixes.push(
      'Install Node.js 20+ and ensure `node` is available on this host.',
    );
  }

  let hostArtifactsPresent =
    fs.existsSync(hostRunnerPath) && fs.existsSync(hostMcpPath);
  let hostBuildAttempted = false;
  let hostBuildSucceeded = false;

  if (options.autoBuildHostRunner) {
    const build = buildHostArtifacts(
      repoRunnerRoot,
      hostRunnerPath,
      hostMcpPath,
      errors,
      fixes,
    );
    hostBuildAttempted = build.attempted;
    hostBuildSucceeded = build.succeeded;
    hostArtifactsPresent =
      build.succeeded &&
      fs.existsSync(hostRunnerPath) &&
      fs.existsSync(hostMcpPath);
  }
  if (!hostArtifactsPresent) {
    errors.push(
      `Host runtime requires runner artifacts under \`${runtimeRunnerRoot}/dist\`.`,
    );
    fixes.push('Run `npm --prefix agent-runner run build`.');
  }

  const credentialPathStatus = readCredentialPathStatus();
  if (credentialPathStatus === 'missing') {
    warnings.push(
      'No credentials detected in `.env` and no OneCLI URL configured.',
    );
    fixes.push(
      'Configure `ONECLI_URL` or set `CLAUDE_CODE_OAUTH_TOKEN` / `ANTHROPIC_API_KEY`.',
    );
  }

  const diagnostics: RuntimeDiagnostics = {
    ok: errors.length === 0,
    errors,
    warnings,
    fixes: [...new Set(fixes)],
    checkedAt: new Date().toISOString(),
    details: {
      runtimeBinary: process.execPath,
      runtimeBinaryReady,
      hostRunnerPath,
      hostMcpPath,
      hostArtifactsPresent,
      runtimeConfigRoot: AGENT_ROOT,
      hostBuildAttempted,
      hostBuildSucceeded,
      onecliUrlConfigured: Boolean(ONECLI_URL?.trim()),
      credentialPathStatus,
    },
  };

  return diagnostics;
}

export function formatRuntimeDiagnosticsMessage(
  diagnostics: RuntimeDiagnostics,
): string {
  const lines: string[] = [];
  lines.push(`Runtime mode: host`);
  lines.push(`Health: ${diagnostics.ok ? 'healthy' : 'unhealthy'}`);
  lines.push(`Checked at: ${diagnostics.checkedAt}`);
  lines.push(
    `Runtime binary: ${diagnostics.details.runtimeBinary} (${diagnostics.details.runtimeBinaryReady ? 'ready' : 'not ready'})`,
  );
  lines.push(`Credential path: ${diagnostics.details.credentialPathStatus}`);
  lines.push(
    `OneCLI configured: ${diagnostics.details.onecliUrlConfigured ? 'yes' : 'no'}`,
  );
  lines.push(
    `Host artifacts: ${diagnostics.details.hostArtifactsPresent ? 'present' : 'missing'}`,
  );
  if (diagnostics.details.hostBuildAttempted) {
    lines.push(
      `Host auto-build: ${diagnostics.details.hostBuildSucceeded ? 'succeeded' : 'failed'}`,
    );
  }
  if (diagnostics.errors.length > 0) {
    lines.push('');
    lines.push('Errors:');
    for (const error of diagnostics.errors) {
      lines.push(`- ${error}`);
    }
  }
  if (diagnostics.warnings.length > 0) {
    lines.push('');
    lines.push('Warnings:');
    for (const warning of diagnostics.warnings) {
      lines.push(`- ${warning}`);
    }
  }
  if (diagnostics.fixes.length > 0) {
    lines.push('');
    lines.push('Fixes:');
    for (const fix of diagnostics.fixes) {
      lines.push(`- ${fix}`);
    }
  }
  return lines.join('\n');
}

function formatRuntimeFailureMessage(diagnostics: RuntimeDiagnostics): string {
  return [
    'Runtime preflight failed.',
    formatRuntimeDiagnosticsMessage(diagnostics),
  ].join('\n\n');
}

export async function runRuntimeStartupPreflight(): Promise<RuntimeDiagnostics> {
  const diagnostics = await collectRuntimeDiagnostics({
    autoBuildHostRunner: true,
  });
  if (!diagnostics.ok) {
    throw new Error(formatRuntimeFailureMessage(diagnostics));
  }
  return diagnostics;
}
