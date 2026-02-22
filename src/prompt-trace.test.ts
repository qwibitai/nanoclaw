import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  _resetPromptTraceCacheForTests,
  tracePromptEvent,
} from './prompt-trace.js';

const TRACKED_ENV_KEYS = [
  'PROMPT_TRACE_ENABLED',
  'PROMPT_TRACE_REDACT',
  'PROMPT_TRACE_INCLUDE_INTERNAL',
  'PROMPT_TRACE_MAX_CHARS',
  'PROMPT_TRACE_DIR',
  'ANTHROPIC_API_KEY',
] as const;

function restoreEnv(snapshot: Partial<Record<(typeof TRACKED_ENV_KEYS)[number], string | undefined>>): void {
  for (const key of TRACKED_ENV_KEYS) {
    const value = snapshot[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

describe('prompt trace logger', () => {
  const envSnapshot: Partial<Record<(typeof TRACKED_ENV_KEYS)[number], string | undefined>> = {};
  let tempDir = '';

  afterEach(() => {
    restoreEnv(envSnapshot);
    if (tempDir) {
      fs.rmSync(tempDir, { recursive: true, force: true });
      tempDir = '';
    }
    _resetPromptTraceCacheForTests();
  });

  it('does not write files when disabled', () => {
    for (const key of TRACKED_ENV_KEYS) {
      envSnapshot[key] = process.env[key];
    }

    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-trace-'));
    process.env.PROMPT_TRACE_ENABLED = 'false';
    process.env.PROMPT_TRACE_DIR = tempDir;

    _resetPromptTraceCacheForTests();
    tracePromptEvent({
      event: 'disabled-check',
      direction: 'external',
      payload: 'hello world',
    });

    expect(fs.readdirSync(tempDir)).toEqual([]);
  });

  it('writes redacted and truncated payload when enabled', () => {
    for (const key of TRACKED_ENV_KEYS) {
      envSnapshot[key] = process.env[key];
    }

    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-trace-'));
    process.env.PROMPT_TRACE_ENABLED = 'true';
    process.env.PROMPT_TRACE_REDACT = 'true';
    process.env.PROMPT_TRACE_MAX_CHARS = '24';
    process.env.PROMPT_TRACE_DIR = tempDir;
    process.env.ANTHROPIC_API_KEY = 'sk-ant-super-secret-value';

    _resetPromptTraceCacheForTests();
    tracePromptEvent({
      event: 'redaction-check',
      direction: 'external',
      groupFolder: 'main',
      chatJid: 'tg:123',
      payload: 'Token sk-ant-super-secret-value and extra content for truncation',
    });

    const filePath = path.join(tempDir, `${new Date().toISOString().slice(0, 10)}.jsonl`);
    const content = fs.readFileSync(filePath, 'utf8').trim();
    const record = JSON.parse(content) as { payload: string; truncated: boolean; payloadLength: number };

    expect(record.payload).toContain('[REDACTED]');
    expect(record.truncated).toBe(true);
    expect(record.payloadLength).toBeGreaterThan(24);
    expect(record.payload).toContain('[TRUNCATED');
  });

  it('skips internal events when internal tracing is disabled', () => {
    for (const key of TRACKED_ENV_KEYS) {
      envSnapshot[key] = process.env[key];
    }

    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-trace-'));
    process.env.PROMPT_TRACE_ENABLED = 'true';
    process.env.PROMPT_TRACE_INCLUDE_INTERNAL = 'false';
    process.env.PROMPT_TRACE_DIR = tempDir;

    _resetPromptTraceCacheForTests();
    tracePromptEvent({
      event: 'internal-should-skip',
      direction: 'internal',
      payload: 'internal text',
    });
    tracePromptEvent({
      event: 'external-should-write',
      direction: 'external',
      payload: 'external text',
    });

    const filePath = path.join(tempDir, `${new Date().toISOString().slice(0, 10)}.jsonl`);
    const lines = fs.readFileSync(filePath, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(1);
    const record = JSON.parse(lines[0]) as { event: string };
    expect(record.event).toBe('external-should-write');
  });
});
