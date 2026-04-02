import { spawn } from 'child_process';
import { execFileSync } from 'child_process';
import fs from 'fs';
import http from 'http';
import path from 'path';

import { getRecentMessages } from './db.js';
import { resolveGroupFolderPath } from './group-folder.js';
import { logger } from './logger.js';
import type { RegisteredGroup } from './types.js';

const OLLAMA_BIN = process.env.OLLAMA_BIN || '/opt/homebrew/bin/ollama';
const OLLAMA_HOST = '127.0.0.1';
const OLLAMA_PORT = 11434;
const HANDOFF_DIR = 'handoffs';
const HANDOFF_FILE = 'current.md';

function truncateLine(text: string, max = 240): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, max - 1).trimEnd()}…`;
}

function requestOllamaTags(): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get(
      {
        host: OLLAMA_HOST,
        port: OLLAMA_PORT,
        path: '/api/tags',
        timeout: 1500,
      },
      (res) => {
        res.resume();
        resolve((res.statusCode || 0) >= 200 && (res.statusCode || 0) < 500);
      },
    );
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
  });
}

export async function ensureOllamaServerRunning(): Promise<{
  ok: boolean;
  started: boolean;
  error?: string;
}> {
  if (await requestOllamaTags()) {
    return { ok: true, started: false };
  }

  try {
    const proc = spawn(OLLAMA_BIN, ['serve'], {
      detached: true,
      stdio: 'ignore',
      env: {
        ...process.env,
        PATH: process.env.PATH?.includes('/opt/homebrew/bin')
          ? process.env.PATH
          : `/opt/homebrew/bin:${process.env.PATH || '/usr/local/bin:/usr/bin:/bin'}`,
      },
    });
    proc.unref();
  } catch (err) {
    return {
      ok: false,
      started: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }

  for (let i = 0; i < 16; i++) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    if (await requestOllamaTags()) {
      logger.info('Ollama server auto-started for model switch');
      return { ok: true, started: true };
    }
  }

  return {
    ok: false,
    started: true,
    error: 'Ollama server did not become ready on http://127.0.0.1:11434',
  };
}

export function resolvePreferredOllamaModel(): string | undefined {
  const configured =
    process.env.CLAUDE_OLLAMA_MODEL ||
    process.env.OLLAMA_MODEL ||
    process.env.DEFAULT_OLLAMA_MODEL;
  if (configured?.trim()) return configured.trim();

  const preferredModels = [
    'qwen3.5:35b-a3b-coding-nvfp4',
    'qwen3.5:27b-nvfp4',
    'qwen3.5:9b-nvfp4',
  ];

  try {
    const raw = execFileSync(OLLAMA_BIN, ['list'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      env: {
        ...process.env,
        PATH: process.env.PATH?.includes('/opt/homebrew/bin')
          ? process.env.PATH
          : `/opt/homebrew/bin:${process.env.PATH || '/usr/local/bin:/usr/bin:/bin'}`,
      },
    });
    const lines = raw
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    const models = lines
      .slice(1)
      .map((line) => line.split(/\s{2,}/)[0]?.trim())
      .filter((value): value is string => Boolean(value));
    if (models.length === 0) return undefined;

    const preferred = preferredModels.find((name) => models.includes(name));
    if (preferred) return preferred;

    const latest = models.find((name) => name.endsWith(':latest'));
    return latest || models[0];
  } catch {
    return undefined;
  }
}

export function getModelHandoffPath(groupFolder: string): string {
  const groupDir = resolveGroupFolderPath(groupFolder);
  return path.join(groupDir, HANDOFF_DIR, HANDOFF_FILE);
}

export function writeModelSwitchHandoff(args: {
  chatJid: string;
  group: RegisteredGroup;
  previousRuntime: string;
  nextRuntime: string;
  requestedBy?: string;
}): string {
  const handoffPath = getModelHandoffPath(args.group.folder);
  fs.mkdirSync(path.dirname(handoffPath), { recursive: true });

  const recentMessages = getRecentMessages(args.chatJid, 10);
  const latestUserMessage = [...recentMessages]
    .reverse()
    .find((msg) => !msg.is_bot_message);

  const lines = [
    '# Model Switch Handoff',
    '',
    `- Updated: ${new Date().toISOString()}`,
    `- Channel: ${args.chatJid}`,
    `- Folder: ${args.group.folder}`,
    `- From: ${args.previousRuntime}`,
    `- To: ${args.nextRuntime}`,
  ];
  if (args.requestedBy) {
    lines.push(`- Requested by: ${args.requestedBy}`);
  }

  lines.push('', '## Current Focus');
  if (latestUserMessage) {
    lines.push(
      `- Latest user request: ${truncateLine(latestUserMessage.content, 400)}`,
    );
  } else {
    lines.push('- No recent user message found.');
  }

  lines.push('', '## Recent Conversation');
  if (recentMessages.length === 0) {
    lines.push('- No recent messages stored.');
  } else {
    for (const msg of recentMessages) {
      lines.push(
        `- [${msg.timestamp}] ${msg.sender_name}: ${truncateLine(msg.content)}`,
      );
    }
  }

  lines.push(
    '',
    '## Next Model Instructions',
    '- Continue from the latest user intent without re-asking for already-known context unless necessary.',
    '- Use the recent conversation summary above as a handoff, then rely on the normal chat history and group memory.',
  );

  fs.writeFileSync(handoffPath, `${lines.join('\n')}\n`);
  return handoffPath;
}

export function readModelSwitchHandoff(groupFolder: string): string | null {
  const handoffPath = getModelHandoffPath(groupFolder);
  if (!fs.existsSync(handoffPath)) return null;
  const text = fs.readFileSync(handoffPath, 'utf-8').trim();
  return text || null;
}
