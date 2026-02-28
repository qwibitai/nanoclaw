import { spawnSync } from 'child_process';

import { ASSISTANT_NAME } from './config.js';

export type FarmCommandResult = {
  handled: boolean;
  response?: string;
};

function usage(): string {
  return (
    `Usage:\n` +
    `@${ASSISTANT_NAME} farm plan {"repo":"scout"}\n` +
    `@${ASSISTANT_NAME} farm run {"repo":"scout","task":"feat-x","desc":"...","agent":"codex"}\n` +
    `@${ASSISTANT_NAME} farm create {"title":"...","desc":"...","labels":["model/codex"]}`
  );
}

function parseFarmCommand(text: string): { cmd: string; payload: Record<string, unknown> } | null {
  const pattern = new RegExp(`^@${ASSISTANT_NAME}\\s+farm\\s+(\\w+)\\s+(.+)$`, 'i');
  const match = text.trim().match(pattern);
  if (!match) return null;

  const cmd = match[1]?.toLowerCase();
  const raw = match[2];
  if (!cmd || !raw) return null;

  try {
    const payload = JSON.parse(raw);
    if (!payload || typeof payload !== 'object') return null;
    return { cmd, payload: payload as Record<string, unknown> };
  } catch {
    return null;
  }
}

function buildArgs(cmd: string, payload: Record<string, unknown>): string[] | null {
  if (cmd === 'plan') {
    const repo = payload.repo as string | undefined;
    if (!repo) return null;
    return ['plan', '--repo', repo];
  }

  if (cmd === 'run') {
    const repo = payload.repo as string | undefined;
    const task = payload.task as string | undefined;
    const desc = payload.desc as string | undefined;
    const agent = (payload.agent as string | undefined) || 'codex';
    if (!repo || !task || !desc) return null;
    return ['run', '--repo', repo, '--task', task, '--desc', desc, '--agent', agent];
  }

  if (cmd === 'create') {
    const title = payload.title as string | undefined;
    const desc = payload.desc as string | undefined;
    const labels = payload.labels as string[] | undefined;
    if (!title || !desc) return null;
    const args = ['create', '--title', title, '--desc', desc];
    if (labels && labels.length > 0) {
      args.push('--labels', labels.join(','));
    }
    return args;
  }

  return null;
}

export function handleFarmCommand(text: string): FarmCommandResult {
  const parsed = parseFarmCommand(text);
  if (!parsed) return { handled: false };

  const args = buildArgs(parsed.cmd, parsed.payload);
  if (!args) {
    return { handled: true, response: usage() };
  }

  const farmBin = process.env.FARM_BIN || 'farm';
  const result = spawnSync(farmBin, args, { encoding: 'utf8' });

  if (result.error) {
    return {
      handled: true,
      response: `Farm error: ${result.error.message}`,
    };
  }

  if (result.status !== 0) {
    const stderr = result.stderr?.trim();
    return {
      handled: true,
      response: `Farm failed (exit ${result.status}). ${stderr || ''}`.trim(),
    };
  }

  const output = (result.stdout || '').trim();
  return { handled: true, response: output || 'Farm command completed.' };
}
