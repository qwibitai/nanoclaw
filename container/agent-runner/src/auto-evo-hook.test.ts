import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  createAutoEvoSessionStartHook,
  getAutoEvoFilePath,
} from './auto-evo-hook.js';
import type { SessionStartHookInput } from '@anthropic-ai/claude-agent-sdk';

const signal = () => new AbortController().signal;

describe('createAutoEvoSessionStartHook', () => {
  let tmpDir: string;
  let filePath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-autoevo-'));
    filePath = path.join(tmpDir, 'AUTO_EVO.md');
    process.env.NANOCLAW_AUTO_EVO_PATH = filePath;
    fs.writeFileSync(
      filePath,
      '# Lessons\n\n- Use tool X before Y.\n',
      'utf-8',
    );
    delete process.env.NANOCLAW_AUTO_EVO_DISABLE;
  });

  afterEach(() => {
    delete process.env.NANOCLAW_AUTO_EVO_PATH;
    delete process.env.NANOCLAW_AUTO_EVO_DISABLE;
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it('injects AUTO_EVO content on SessionStart (main thread)', async () => {
    const logs: string[] = [];
    const hook = createAutoEvoSessionStartHook((m) => logs.push(m));

    const input: SessionStartHookInput = {
      hook_event_name: 'SessionStart',
      source: 'startup',
      session_id: 'sess-1',
      transcript_path: '/tmp/t.jsonl',
      cwd: '/workspace/group',
    };

    const out = await hook(input, undefined, { signal: signal() });

    expect(out.hookSpecificOutput).toBeDefined();
    expect(out.hookSpecificOutput).toMatchObject({
      hookEventName: 'SessionStart',
    });
    const ctx = (out.hookSpecificOutput as { additionalContext?: string })
      .additionalContext;
    expect(ctx).toContain('Use tool X before Y');
    expect(logs.some((l) => l.includes('injecting AUTO_EVO.md'))).toBe(true);
  });

  it('returns empty for subagent (agent_id set)', async () => {
    const hook = createAutoEvoSessionStartHook(() => {});

    const input = {
      hook_event_name: 'SessionStart' as const,
      source: 'startup' as const,
      session_id: 'sess-1',
      transcript_path: '/tmp/t.jsonl',
      cwd: '/workspace/group',
      agent_id: 'worker-1',
    };

    const out = await hook(input as SessionStartHookInput, undefined, {
      signal: signal(),
    });

    expect(out).toEqual({});
  });

  it('respects NANOCLAW_AUTO_EVO_DISABLE', async () => {
    process.env.NANOCLAW_AUTO_EVO_DISABLE = '1';
    const hook = createAutoEvoSessionStartHook(() => {});

    const input: SessionStartHookInput = {
      hook_event_name: 'SessionStart',
      source: 'resume',
      session_id: 'sess-1',
      transcript_path: '/tmp/t.jsonl',
      cwd: '/workspace/group',
    };

    const out = await hook(input, undefined, { signal: signal() });
    expect(out).toEqual({});
  });

  it('getAutoEvoFilePath defaults to container path when env unset', () => {
    delete process.env.NANOCLAW_AUTO_EVO_PATH;
    expect(getAutoEvoFilePath()).toBe('/workspace/group/AUTO_EVO.md');
  });
});
