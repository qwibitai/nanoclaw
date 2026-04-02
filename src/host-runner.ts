/**
 * Host process runner for non-Claude AI agents (Gemini CLI, Copilot CLI, Codex CLI).
 * Spawns the CLI directly on the host instead of inside a container,
 * avoiding container auth complexity for third-party CLIs.
 *
 * Features:
 * - API key rotation: on quota errors (429/RESOURCE_EXHAUSTED), retries with
 *   next key from GEMINI_API_KEY, GEMINI_API_KEY_2, GEMINI_API_KEY_3, …
 * - Session continuity: pass resumeSessionId to resume a prior conversation.
 *   After a successful run, newSessionId is set in the returned ContainerOutput.
 * - Dynamic model selection: simple chat uses lighter models, complex queries
 *   upgrade automatically.
 */
import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';

import { readEnvFile } from './env.js';
import { resolveGroupFolderPath } from './group-folder.js';
import {
  buildCopilotAdditionalMcpConfig,
  prepareCopilotWorkspace,
  prepareGeminiWorkspace,
} from './host-agent-assets.js';
import { logger } from './logger.js';
import { ContainerOutput } from './container-runner.js';
const GEMINI_BIN = process.env.GEMINI_BIN || '/opt/homebrew/bin/gemini';
const COPILOT_BIN = '/opt/homebrew/bin/copilot';
const CODEX_BIN = process.env.CODEX_BIN || '/opt/homebrew/bin/codex';
const DEFAULT_CODEX_MODEL = process.env.CODEX_MODEL || 'gpt-5.4';
const DEFAULT_CODEX_EFFORT = process.env.CODEX_EFFORT || 'high';

export type HostAgentCli = 'gemini' | 'copilot' | 'codex';

// Complex query keywords (Korean + English) that warrant a stronger model
const COMPLEX_KEYWORDS = [
  '분석',
  '설명해',
  '왜',
  '어떻게',
  '비교',
  '차이',
  '정리해',
  '요약',
  '코드',
  '버그',
  '구현',
  '설계',
  '아키텍처',
  'analyze',
  'explain',
  'compare',
  'difference',
  'implement',
  'design',
  'architecture',
  'debug',
];

function isComplexPrompt(prompt: string): boolean {
  const lower = prompt.toLowerCase();
  return (
    prompt.length > 300 || COMPLEX_KEYWORDS.some((kw) => lower.includes(kw))
  );
}

/**
 * Always use gemini-2.5-flash for quality.
 * flash-lite is too weak for conversational quality in Discord.
 */
function pickGeminiModel(_prompt: string): string {
  return 'gemini-2.5-flash';
}

function extractImagePaths(text: string): {
  cleanText: string;
  imagePaths: string[];
} {
  const imagePattern = /\[Image:\s*(\/[^\]]+)\]/g;
  const imagePaths: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = imagePattern.exec(text)) !== null) {
    imagePaths.push(match[1].trim());
  }
  return {
    cleanText: text.replace(imagePattern, '').trim(),
    imagePaths,
  };
}

function getCodexModel(): string {
  return process.env.CODEX_MODEL || DEFAULT_CODEX_MODEL;
}

function getCodexEffort(): string {
  return process.env.CODEX_EFFORT || DEFAULT_CODEX_EFFORT;
}

/** Returns true if the stderr/output indicates a quota exhaustion error. */
function isQuotaError(stderr: string, stdout: string): boolean {
  const combined = (stderr + stdout).toLowerCase();
  return (
    combined.includes('429') ||
    combined.includes('resource_exhausted') ||
    combined.includes('quota exceeded') ||
    combined.includes('rate limit') ||
    combined.includes('ratelimitexceeded')
  );
}

/** Reads all GEMINI_API_KEY, GEMINI_API_KEY_2, … from .env */
function loadGeminiKeys(): string[] {
  const allKeys = readEnvFile([
    'GEMINI_API_KEY',
    'GEMINI_API_KEY_2',
    'GEMINI_API_KEY_3',
    'GEMINI_API_KEY_4',
    'GEMINI_API_KEY_5',
  ]);
  return [
    allKeys['GEMINI_API_KEY'],
    allKeys['GEMINI_API_KEY_2'],
    allKeys['GEMINI_API_KEY_3'],
    allKeys['GEMINI_API_KEY_4'],
    allKeys['GEMINI_API_KEY_5'],
  ].filter(Boolean) as string[];
}

function spawnOnce(
  command: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const chunks: string[] = [];
    let stderrOutput = '';
    const currentPath = env.PATH || process.env.PATH || '';
    const normalizedEnv: NodeJS.ProcessEnv = {
      ...env,
      PATH: currentPath.includes('/opt/homebrew/bin')
        ? currentPath
        : `/opt/homebrew/bin:${currentPath || '/usr/local/bin:/usr/bin:/bin'}`,
    };
    const proc = spawn(command, args, {
      cwd,
      env: normalizedEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    proc.stdout.on('data', (data: Buffer) => chunks.push(data.toString()));
    proc.stderr.on('data', (data: Buffer) => {
      stderrOutput += data.toString();
    });
    proc.on('close', (code) =>
      resolve({ code, stdout: chunks.join('').trim(), stderr: stderrOutput }),
    );
    proc.on('error', (err) =>
      resolve({ code: -1, stdout: '', stderr: err.message }),
    );
  });
}

/**
 * After a successful gemini run, fetch the latest session UUID from the cwd.
 * Returns undefined if no sessions exist yet.
 */
async function captureGeminiSessionId(
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<string | undefined> {
  const { stdout } = await spawnOnce(GEMINI_BIN, ['--list-sessions'], cwd, env);
  const match = stdout.match(
    /\[([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})\]/,
  );
  return match?.[1];
}

export interface HostAgentOptions {
  /** Session ID to resume (gemini UUID or 'active' for copilot). */
  resumeSessionId?: string;
  modelOverride?: string;
  reasoningEffortOverride?: string;
  onOutput?: (output: ContainerOutput) => Promise<void>;
}

function resolveGeminiModel(prompt: string, modelOverride?: string): string {
  return modelOverride || pickGeminiModel(prompt);
}

function supportsCopilotReasoningEffort(model: string): boolean {
  return /^(gpt-5|o1|o3|o4)/.test(model);
}

function resolveCopilotArgs(
  prompt: string,
  modelOverride?: string,
  reasoningEffortOverride?: string,
): string[] {
  const model =
    modelOverride || (isComplexPrompt(prompt) ? 'gpt-4.1' : 'gpt-5-mini');
  const args = ['--allow-all-tools', '--model', model];
  const effort =
    reasoningEffortOverride || (model === 'gpt-5-mini' ? 'xhigh' : undefined);
  if (effort && supportsCopilotReasoningEffort(model)) {
    args.push('--reasoning-effort', effort);
  }
  return args;
}

function resolveCodexModel(modelOverride?: string): string {
  return modelOverride || getCodexModel();
}

function resolveCodexEffort(reasoningEffortOverride?: string): string {
  return reasoningEffortOverride || getCodexEffort();
}

export async function runHostAgent(
  agentCli: HostAgentCli,
  prompt: string,
  groupFolder: string,
  opts: HostAgentOptions = {},
): Promise<ContainerOutput> {
  const { resumeSessionId, modelOverride, reasoningEffortOverride, onOutput } =
    opts;
  const groupDir = resolveGroupFolderPath(groupFolder);

  // Prepend agent-specific SYSTEM-{agentCli}.md if present, else shared SYSTEM.md
  const agentSystemMdPath = path.join(groupDir, `SYSTEM-${agentCli}.md`);
  const sharedSystemMdPath = path.join(groupDir, 'SYSTEM.md');
  const systemMdPath = fs.existsSync(agentSystemMdPath)
    ? agentSystemMdPath
    : fs.existsSync(sharedSystemMdPath)
      ? sharedSystemMdPath
      : null;
  const fullPrompt = systemMdPath
    ? `${fs.readFileSync(systemMdPath, 'utf-8').trim()}\n\n---\n\n${prompt}`
    : prompt;

  // Build base args per CLI
  const buildArgs = (): {
    command: string;
    args: string[];
    resultFile?: string;
  } => {
    if (agentCli === 'gemini') {
      prepareGeminiWorkspace(groupDir);
      const resumeArgs = resumeSessionId ? ['--resume', resumeSessionId] : [];
      return {
        command: GEMINI_BIN,
        args: [
          '--model',
          resolveGeminiModel(fullPrompt, modelOverride),
          ...resumeArgs,
          '--prompt',
          fullPrompt,
          '--yolo',
          '--output-format=text',
        ],
      };
    } else if (agentCli === 'copilot') {
      prepareCopilotWorkspace(groupDir);
      // copilot: use --continue if a prior session exists in this cwd
      const resumeArgs = resumeSessionId ? ['--continue'] : [];
      const mcpArgs: string[] = [];
      const mcpConfig = buildCopilotAdditionalMcpConfig(groupDir);
      if (mcpConfig) {
        mcpArgs.push('--additional-mcp-config', mcpConfig);
      }
      return {
        command: COPILOT_BIN,
        args: [
          '-p',
          fullPrompt,
          ...resumeArgs,
          ...resolveCopilotArgs(
            fullPrompt,
            modelOverride,
            reasoningEffortOverride,
          ),
          ...mcpArgs,
        ],
      };
    }

    const { cleanText, imagePaths } = extractImagePaths(fullPrompt);
    const resultFile = path.join(groupDir, '.codex-last-message.txt');
    const imageArgs = imagePaths.flatMap((imgPath) => ['--image', imgPath]);
    const sharedOptionArgs = [
      '--skip-git-repo-check',
      '--full-auto',
      '--output-last-message',
      resultFile,
      '--model',
      resolveCodexModel(modelOverride),
      '-c',
      `model_reasoning_effort="${resolveCodexEffort(reasoningEffortOverride)}"`,
      ...imageArgs,
    ];
    const freshExecOnlyArgs = ['--color', 'never'];
    if (resumeSessionId && resumeSessionId !== 'active') {
      return {
        command: CODEX_BIN,
        args: [
          'exec',
          'resume',
          ...sharedOptionArgs,
          resumeSessionId,
          cleanText || '-',
        ],
        resultFile,
      };
    }
    if (resumeSessionId) {
      return {
        command: CODEX_BIN,
        args: [
          'exec',
          'resume',
          '--last',
          ...sharedOptionArgs,
          cleanText || '-',
        ],
        resultFile,
      };
    }
    return {
      command: CODEX_BIN,
      args: [
        'exec',
        cleanText || '-',
        ...freshExecOnlyArgs,
        ...sharedOptionArgs,
      ],
      resultFile,
    };
  };

  // For Gemini: try each key in the pool; fall back on quota errors.
  const geminiKeys = agentCli === 'gemini' ? loadGeminiKeys() : [];
  const attempts = agentCli === 'gemini' ? Math.max(geminiKeys.length, 1) : 1;

  for (let i = 0; i < attempts; i++) {
    const env: NodeJS.ProcessEnv = { ...process.env };
    if (agentCli === 'gemini' && geminiKeys[i]) {
      env.GEMINI_API_KEY = geminiKeys[i];
    }

    const { command, args, resultFile } = buildArgs();
    if (resultFile && fs.existsSync(resultFile)) {
      fs.unlinkSync(resultFile);
    }
    const model =
      agentCli === 'gemini'
        ? resolveGeminiModel(fullPrompt, modelOverride)
        : agentCli === 'copilot'
          ? (() => {
              const args = resolveCopilotArgs(
                fullPrompt,
                modelOverride,
                reasoningEffortOverride,
              );
              const modelIndex = args.indexOf('--model');
              const effortIndex = args.indexOf('--reasoning-effort');
              const resolvedModel =
                modelIndex >= 0 ? args[modelIndex + 1] : 'unknown';
              const resolvedEffort =
                effortIndex >= 0 ? args[effortIndex + 1] : 'default';
              return `${resolvedModel}(effort:${resolvedEffort})`;
            })()
          : `${resolveCodexModel(modelOverride)}(effort:${resolveCodexEffort(reasoningEffortOverride)})`;
    const keyLabel = agentCli === 'gemini' ? `key #${i + 1}/${attempts}` : '';
    logger.info(
      { agentCli, groupFolder, model, keyLabel, resuming: !!resumeSessionId },
      'Spawning host agent',
    );

    const { code, stdout, stderr } = await spawnOnce(
      command,
      args,
      groupDir,
      env,
    );
    let resultText = stdout;
    if (agentCli === 'codex' && resultFile && fs.existsSync(resultFile)) {
      resultText = fs.readFileSync(resultFile, 'utf-8').trim();
    }
    logger.info(
      { agentCli, groupFolder, code, resultLen: resultText.length },
      'Host agent finished',
    );

    if (isQuotaError(stderr, stdout)) {
      logger.warn(
        { agentCli, keyIndex: i + 1 },
        'Quota error detected, trying next key',
      );
      continue;
    }

    if (code !== 0 && !resultText) {
      const output: ContainerOutput = {
        status: 'error',
        result: null,
        error: stderr || `${agentCli} exited with code ${code}`,
      };
      await onOutput?.(output);
      return output;
    }

    // Capture new session ID for continuity on next run
    let newSessionId: string | undefined;
    if (agentCli === 'gemini') {
      newSessionId = await captureGeminiSessionId(groupDir, env);
    } else {
      // copilot/codex: mark session as active (use cwd-local resume on next run)
      newSessionId = 'active';
    }

    const output: ContainerOutput = {
      status: 'success',
      result: resultText || null,
      newSessionId,
    };
    await onOutput?.(output);
    return output;
  }

  // All keys exhausted
  logger.error({ agentCli }, 'All API keys quota-exhausted');
  const output: ContainerOutput = {
    status: 'error',
    result: null,
    error: `${agentCli}: all API keys quota-exhausted`,
  };
  await onOutput?.(output);
  return output;
}
