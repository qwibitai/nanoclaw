import fs from 'fs';
import path from 'path';

import {
  PERSISTENCE_AUTO_RESUME_ON_BOOT,
  PERSISTENCE_ENABLED,
  PERSISTENCE_INCLUDE_PERSONALITY,
  PERSISTENCE_ROOT,
} from './config.js';
import { logger } from './logger.js';

const STATE_MARKER = 'NANOCLAW_STATE';
const STATE_BLOCK_RE = /<!--\s*NANOCLAW_STATE\n([\s\S]*?)\n-->\n?/m;
const PROMPT_PROGRESS_MAX_CHARS = 12_000;
const PROMPT_PERSONALITY_MAX_CHARS = 6_000;

type PersistentStatus = 'idle' | 'in_progress' | 'resuming' | 'error';
type ExecutionSource = 'chat' | 'scheduled' | 'boot_resume';

interface ProgressMetadata {
  status: PersistentStatus;
  resume_on_boot: boolean;
  last_source: string;
  last_started_at: string;
  last_finished_at: string;
  last_updated_at: string;
  last_prompt_summary: string;
  last_result_summary: string;
}

interface ParsedStateFile {
  metadata: ProgressMetadata;
  body: string;
}

const DEFAULT_BODY = `# Task Progress

Use this file to keep durable progress notes across restarts.

## Current Checklist
- [ ] Update this checklist as work progresses

## Progress Log
`;

function nowIso(): string {
  return new Date().toISOString();
}

function sanitizeSummary(text: string, max = 280): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  if (collapsed.length <= max) return collapsed;
  return `${collapsed.slice(0, max)}...`;
}

function clipForPrompt(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const omitted = text.length - maxChars;
  return `${text.slice(0, maxChars)}\n\n...[TRUNCATED ${omitted} chars]`;
}

function defaultMetadata(): ProgressMetadata {
  return {
    status: 'idle',
    resume_on_boot: false,
    last_source: '',
    last_started_at: '',
    last_finished_at: '',
    last_updated_at: '',
    last_prompt_summary: '',
    last_result_summary: '',
  };
}

function parseBoolean(value: string | undefined): boolean {
  if (!value) return false;
  return value.trim().toLowerCase() === 'true';
}

function parseStateFile(content: string): ParsedStateFile {
  const defaults = defaultMetadata();
  const match = content.match(STATE_BLOCK_RE);
  if (!match) {
    return { metadata: defaults, body: content || DEFAULT_BODY };
  }

  const metadata = { ...defaults };
  for (const line of match[1].split('\n')) {
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    switch (key) {
      case 'status':
        if (value === 'idle' || value === 'in_progress' || value === 'resuming' || value === 'error') {
          metadata.status = value;
        }
        break;
      case 'resume_on_boot':
        metadata.resume_on_boot = parseBoolean(value);
        break;
      case 'last_source':
        metadata.last_source = value;
        break;
      case 'last_started_at':
        metadata.last_started_at = value;
        break;
      case 'last_finished_at':
        metadata.last_finished_at = value;
        break;
      case 'last_updated_at':
        metadata.last_updated_at = value;
        break;
      case 'last_prompt_summary':
        metadata.last_prompt_summary = value;
        break;
      case 'last_result_summary':
        metadata.last_result_summary = value;
        break;
      default:
        break;
    }
  }

  const body = content.replace(STATE_BLOCK_RE, '').trimStart() || DEFAULT_BODY;
  return { metadata, body };
}

function serializeStateFile(parsed: ParsedStateFile): string {
  const metadataLines = [
    `status: ${parsed.metadata.status}`,
    `resume_on_boot: ${parsed.metadata.resume_on_boot ? 'true' : 'false'}`,
    `last_source: ${parsed.metadata.last_source}`,
    `last_started_at: ${parsed.metadata.last_started_at}`,
    `last_finished_at: ${parsed.metadata.last_finished_at}`,
    `last_updated_at: ${parsed.metadata.last_updated_at}`,
    `last_prompt_summary: ${parsed.metadata.last_prompt_summary}`,
    `last_result_summary: ${parsed.metadata.last_result_summary}`,
  ];

  const header = [
    `<!-- ${STATE_MARKER}`,
    ...metadataLines,
    '-->',
    '',
  ].join('\n');

  return `${header}${parsed.body.trimStart()}\n`;
}

function appendProgressLog(body: string, title: string, details: string): string {
  const ts = nowIso();
  const entry = [
    `### ${ts} - ${title}`,
    details,
    '',
  ].join('\n');
  return `${body.trimEnd()}\n\n${entry}`;
}

function withStateFile(
  groupFolder: string,
  updater: (parsed: ParsedStateFile) => ParsedStateFile,
): void {
  if (!PERSISTENCE_ENABLED) return;
  const paths = getPersistencePaths(groupFolder);
  ensureGroupPersistenceFiles(groupFolder);

  try {
    const content = fs.readFileSync(paths.taskProgressFile, 'utf8');
    const updated = updater(parseStateFile(content));
    fs.writeFileSync(paths.taskProgressFile, serializeStateFile(updated), 'utf8');
  } catch (err) {
    logger.warn(
      { err, groupFolder, file: paths.taskProgressFile },
      'Failed to update persistence state file',
    );
  }
}

export function getPersistencePaths(groupFolder: string): {
  dir: string;
  taskProgressFile: string;
  personalityFile: string;
} {
  const dir = path.join(PERSISTENCE_ROOT, groupFolder);
  return {
    dir,
    taskProgressFile: path.join(dir, 'task-progress.md'),
    personalityFile: path.join(dir, 'personality.md'),
  };
}

export function ensureGroupPersistenceFiles(groupFolder: string): void {
  if (!PERSISTENCE_ENABLED) return;
  const paths = getPersistencePaths(groupFolder);
  fs.mkdirSync(paths.dir, { recursive: true });

  if (!fs.existsSync(paths.taskProgressFile)) {
    const initial: ParsedStateFile = {
      metadata: {
        ...defaultMetadata(),
        last_updated_at: nowIso(),
      },
      body: DEFAULT_BODY,
    };
    fs.writeFileSync(paths.taskProgressFile, serializeStateFile(initial), 'utf8');
  }
}

function readTaskProgress(groupFolder: string): string {
  const paths = getPersistencePaths(groupFolder);
  ensureGroupPersistenceFiles(groupFolder);
  return fs.readFileSync(paths.taskProgressFile, 'utf8');
}

function readPersonality(groupFolder: string): string | null {
  if (!PERSISTENCE_INCLUDE_PERSONALITY) return null;
  const paths = getPersistencePaths(groupFolder);
  if (!fs.existsSync(paths.personalityFile)) return null;
  const content = fs.readFileSync(paths.personalityFile, 'utf8').trim();
  return content || null;
}

export function buildPromptWithPersistence(
  basePrompt: string,
  groupFolder: string,
): string {
  if (!PERSISTENCE_ENABLED) return basePrompt;

  ensureGroupPersistenceFiles(groupFolder);
  const progress = clipForPrompt(
    readTaskProgress(groupFolder),
    PROMPT_PROGRESS_MAX_CHARS,
  );
  const personality = readPersonality(groupFolder);

  const sections: string[] = [
    '<persistent_context>',
    'Files mounted from host at `/workspace/persistence`:',
    '- `/workspace/persistence/task-progress.md` (persistent work log)',
    '- `/workspace/persistence/personality.md` (optional)',
    '',
    'Before executing work, review `task-progress.md` and continue from the latest checkpoint if needed.',
    'During and after work, update `task-progress.md` so progress survives restarts.',
    '',
    'Current `task-progress.md`:',
    '```md',
    progress,
    '```',
  ];

  if (personality) {
    sections.push(
      '',
      'Optional personality guidance from `personality.md`:',
      '```md',
      clipForPrompt(personality, PROMPT_PERSONALITY_MAX_CHARS),
      '```',
    );
  }

  sections.push('</persistent_context>', '', basePrompt);
  return sections.join('\n');
}

export function markTaskRunStart(
  groupFolder: string,
  prompt: string,
  source: ExecutionSource,
): void {
  if (!PERSISTENCE_ENABLED) return;
  withStateFile(groupFolder, (parsed) => {
    const ts = nowIso();
    parsed.metadata.status = 'in_progress';
    parsed.metadata.resume_on_boot = true;
    parsed.metadata.last_source = source;
    parsed.metadata.last_started_at = ts;
    parsed.metadata.last_updated_at = ts;
    parsed.metadata.last_prompt_summary = sanitizeSummary(prompt);
    parsed.body = appendProgressLog(
      parsed.body,
      `Run started (${source})`,
      `Prompt summary: ${parsed.metadata.last_prompt_summary || '(empty)'}`,
    );
    return parsed;
  });
}

export function markTaskRunEnd(
  groupFolder: string,
  status: 'success' | 'error',
  result: string | null,
  error: string | null,
): void {
  if (!PERSISTENCE_ENABLED) return;
  withStateFile(groupFolder, (parsed) => {
    const ts = nowIso();
    parsed.metadata.status = status === 'success' ? 'idle' : 'error';
    parsed.metadata.resume_on_boot = false;
    parsed.metadata.last_finished_at = ts;
    parsed.metadata.last_updated_at = ts;
    parsed.metadata.last_result_summary = sanitizeSummary(
      status === 'success' ? result || 'Completed' : error || 'Error',
    );
    parsed.body = appendProgressLog(
      parsed.body,
      `Run finished (${status})`,
      status === 'success'
        ? `Result summary: ${parsed.metadata.last_result_summary}`
        : `Error summary: ${parsed.metadata.last_result_summary}`,
    );
    return parsed;
  });
}

export function shouldQueueBootResume(groupFolder: string): boolean {
  if (!PERSISTENCE_ENABLED || !PERSISTENCE_AUTO_RESUME_ON_BOOT) return false;
  const paths = getPersistencePaths(groupFolder);
  if (!fs.existsSync(paths.taskProgressFile)) return false;
  try {
    const parsed = parseStateFile(fs.readFileSync(paths.taskProgressFile, 'utf8'));
    return parsed.metadata.status === 'in_progress' && parsed.metadata.resume_on_boot;
  } catch (err) {
    logger.warn(
      { err, groupFolder, file: paths.taskProgressFile },
      'Failed to read persistence state during boot recovery',
    );
    return false;
  }
}

export function markBootResumeQueued(groupFolder: string): void {
  if (!PERSISTENCE_ENABLED) return;
  withStateFile(groupFolder, (parsed) => {
    const ts = nowIso();
    parsed.metadata.status = 'resuming';
    parsed.metadata.resume_on_boot = false;
    parsed.metadata.last_source = 'boot_resume';
    parsed.metadata.last_updated_at = ts;
    parsed.body = appendProgressLog(
      parsed.body,
      'Boot resume queued',
      'NanoClaw queued a continuation run after restart.',
    );
    return parsed;
  });
}
