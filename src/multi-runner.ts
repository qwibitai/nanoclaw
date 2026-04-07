/**
 * Multi-agent discussion runner.
 * Orchestrates a round-based conversation between Gemini and Copilot,
 * following EJClaw paired-room conventions (DONE / DONE_WITH_CONCERNS / BLOCKED / NEEDS_CONTEXT).
 * Stops when any agent signals it needs human input or after max rounds.
 */
import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';

import { readEnvFile } from './env.js';
import { resolveGroupFolderPath } from './group-folder.js';
import { logger } from './logger.js';
import { ContainerOutput } from './container-runner.js';

const GEMINI_SCRIPT =
  '/opt/homebrew/Cellar/gemini-cli/0.34.0/libexec/lib/node_modules/@google/gemini-cli/dist/index.js';
const NODE_BIN = '/opt/homebrew/bin/node';
const COPILOT_BIN = '/opt/homebrew/bin/copilot';

const MAX_ROUNDS = 3;

// Status codes agents use to signal state
const STATUS_PATTERN =
  /\[(DONE|DONE_WITH_CONCERNS|BLOCKED|NEEDS_CONTEXT)(?::\s*([\s\S]*?))?\]/;

type AgentStatus =
  | 'DONE'
  | 'DONE_WITH_CONCERNS'
  | 'BLOCKED'
  | 'NEEDS_CONTEXT'
  | null;

function extractStatus(text: string): {
  status: AgentStatus;
  detail: string | null;
} {
  const match = STATUS_PATTERN.exec(text);
  if (!match) return { status: null, detail: null };
  return {
    status: match[1] as AgentStatus,
    detail: match[2]?.trim() || null,
  };
}

function stripStatus(text: string): string {
  return text.replace(STATUS_PATTERN, '').trim();
}

function runCli(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  cwd: string,
): Promise<string | null> {
  return new Promise((resolve) => {
    const chunks: string[] = [];
    const proc = spawn(command, args, {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    proc.stdout.on('data', (d: Buffer) => chunks.push(d.toString()));
    proc.on('close', (code) => {
      const result = chunks.join('').trim();
      resolve(code === 0 && result ? result : null);
    });
    proc.on('error', () => resolve(null));
  });
}

async function askGemini(
  prompt: string,
  env: NodeJS.ProcessEnv,
  cwd: string,
): Promise<string | null> {
  return runCli(
    NODE_BIN,
    [
      '--no-warnings=DEP0040',
      GEMINI_SCRIPT,
      '--prompt',
      prompt,
      '--yolo',
      '--output-format=text',
    ],
    env,
    cwd,
  );
}

async function askCopilot(prompt: string, cwd: string): Promise<string | null> {
  return runCli(
    COPILOT_BIN,
    ['-p', prompt, '--allow-all-tools'],
    process.env as NodeJS.ProcessEnv,
    cwd,
  );
}

export async function runMultiAgentDiscussion(
  userPrompt: string,
  groupFolder: string,
  onOutput?: (output: ContainerOutput) => Promise<void>,
): Promise<ContainerOutput> {
  const groupDir = resolveGroupFolderPath(groupFolder);
  const secrets = readEnvFile(['GEMINI_API_KEY']);
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (secrets.GEMINI_API_KEY) env.GEMINI_API_KEY = secrets.GEMINI_API_KEY;

  // Load shared room system prompt
  const systemMdPath = path.join(groupDir, 'SYSTEM.md');
  const systemPrompt = fs.existsSync(systemMdPath)
    ? fs.readFileSync(systemMdPath, 'utf-8').trim()
    : '';

  logger.info({ groupFolder }, 'Starting multi-agent discussion');

  interface Turn {
    agent: string;
    text: string;
    status: AgentStatus;
    detail: string | null;
  }

  const turns: Turn[] = [];
  let stopped = false;
  let stopReason: string | null = null;

  function buildContext(): string {
    if (turns.length === 0) return '';
    return (
      '\n\n**Conversation so far:**\n' +
      turns.map((t) => `[${t.agent}]: ${t.text}`).join('\n\n')
    );
  }

  function buildPrompt(agentName: string, agentInstructions: string): string {
    const base = systemPrompt ? `${systemPrompt}\n\n---\n\n` : '';
    const context = buildContext();
    return (
      `${base}${agentInstructions}\n\n` +
      `**User message:** ${userPrompt}` +
      context +
      '\n\n' +
      `Respond as ${agentName}. End your response with one of:\n` +
      `- [DONE] if the question is fully resolved\n` +
      `- [DONE_WITH_CONCERNS: <concern>] if resolved but something should be flagged\n` +
      `- [BLOCKED: <what's blocking you>] if you cannot proceed\n` +
      `- [NEEDS_CONTEXT: <what you need from the user>] if human input is required\n` +
      `If none apply yet (mid-discussion), omit the status tag.`
    );
  }

  // Round loop: Gemini → Copilot → Gemini → ... up to MAX_ROUNDS total turns
  const agentSchedule: {
    name: string;
    call: (prompt: string) => Promise<string | null>;
  }[] = [];
  for (let i = 0; i < MAX_ROUNDS; i++) {
    if (i % 2 === 0) {
      agentSchedule.push({
        name: 'Gemini',
        call: (p) => askGemini(p, env, groupDir),
      });
    } else {
      agentSchedule.push({
        name: 'Copilot',
        call: (p) => askCopilot(p, groupDir),
      });
    }
  }

  for (const { name, call } of agentSchedule) {
    if (stopped) break;

    const instructions =
      name === 'Gemini'
        ? 'You are Gemini. Review the problem critically. Challenge assumptions.'
        : "You are GitHub Copilot. Review Gemini's position critically. Add or challenge.";

    const prompt = buildPrompt(name, instructions);
    logger.info({ agent: name, groupFolder }, 'Calling agent');

    const raw = await call(prompt);

    if (!raw) {
      logger.warn({ agent: name }, 'Agent returned no response, skipping');
      continue;
    }

    const { status, detail } = extractStatus(raw);
    const text = stripStatus(raw);

    turns.push({ agent: name, text, status, detail });
    logger.info({ agent: name, status }, 'Agent responded');

    if (status === 'DONE' || status === 'DONE_WITH_CONCERNS') {
      stopped = true;
    } else if (status === 'BLOCKED' || status === 'NEEDS_CONTEXT') {
      stopped = true;
      stopReason = detail;
    }
  }

  // Format output for Discord
  if (turns.length === 0) {
    const output: ContainerOutput = {
      status: 'error',
      result: null,
      error: 'All agents failed to respond',
    };
    await onOutput?.(output);
    return output;
  }

  const lines: string[] = [];

  for (const turn of turns) {
    lines.push(`**[${turn.agent}]**\n${turn.text}`);

    if (turn.status === 'DONE_WITH_CONCERNS' && turn.detail) {
      lines.push(`⚠️ **Concern flagged by ${turn.agent}:** ${turn.detail}`);
    }
  }

  // Final status block
  const lastTurn = turns[turns.length - 1];
  if (lastTurn.status === 'DONE' || lastTurn.status === 'DONE_WITH_CONCERNS') {
    lines.push(`✅ **Resolved**`);
  } else if (lastTurn.status === 'BLOCKED') {
    lines.push(`🚫 **${lastTurn.agent} is blocked**\n${stopReason ?? ''}`);
    lines.push(`⏸ Waiting for your input.`);
  } else if (lastTurn.status === 'NEEDS_CONTEXT') {
    lines.push(
      `⏸ **${lastTurn.agent} needs your input:**\n${stopReason ?? ''}`,
    );
  } else {
    // Reached max rounds without resolution
    lines.push(
      `⏸ **Max discussion rounds reached.** Review above and let agents know how to proceed.`,
    );
  }

  const result = lines.join('\n\n---\n\n');
  const output: ContainerOutput = { status: 'success', result };
  await onOutput?.(output);
  return output;
}
