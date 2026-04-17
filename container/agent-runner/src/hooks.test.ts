import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let sandbox: string;

vi.mock('./workspace.js', () => ({
  get WORKSPACE_IPC() {
    return path.join(sandbox, 'ipc');
  },
  get WORKSPACE_GROUP() {
    return path.join(sandbox, 'group');
  },
  get WORKSPACE_GLOBAL() {
    return path.join(sandbox, 'global');
  },
  get WORKSPACE_EXTRA() {
    return path.join(sandbox, 'extra');
  },
  IPC_INPUT_DIR: '',
  IPC_INPUT_CLOSE_SENTINEL: '',
  IPC_POLL_MS: 100,
}));

// `log` writes to stderr; stub to avoid test noise.
vi.mock('./io.js', () => ({
  log: vi.fn(),
}));

import { createPreCompactHook, createSessionStartHook } from './hooks.js';

beforeEach(() => {
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'hooks-'));
  fs.mkdirSync(path.join(sandbox, 'group'), { recursive: true });
  fs.mkdirSync(path.join(sandbox, 'global'), { recursive: true });
});

afterEach(() => {
  fs.rmSync(sandbox, { recursive: true, force: true });
});

describe('createPreCompactHook', () => {
  it('returns {} and logs when the transcript path is missing', async () => {
    const hook = createPreCompactHook('Andy');
    const result = await hook(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { transcript_path: '', session_id: 'sess-1' } as any,
      undefined,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      {} as any,
    );
    expect(result).toEqual({});
  });

  it('returns {} and logs when the transcript file has no messages', async () => {
    const tp = path.join(sandbox, 'empty.jsonl');
    fs.writeFileSync(tp, '');
    const hook = createPreCompactHook('Andy');
    const result = await hook(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { transcript_path: tp, session_id: 'sess-2' } as any,
      undefined,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      {} as any,
    );
    expect(result).toEqual({});
  });

  it('archives a valid transcript into <group>/conversations/', async () => {
    const tp = path.join(sandbox, 'ok.jsonl');
    fs.writeFileSync(
      tp,
      JSON.stringify({
        type: 'user',
        message: { content: 'Hello' },
      }) +
        '\n' +
        JSON.stringify({
          type: 'assistant',
          message: { content: [{ type: 'text', text: 'Hi' }] },
        }) +
        '\n',
    );
    const hook = createPreCompactHook('Andy');
    await hook(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { transcript_path: tp, session_id: 'sess-3' } as any,
      undefined,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      {} as any,
    );
    const convoDir = path.join(sandbox, 'group', 'conversations');
    expect(fs.existsSync(convoDir)).toBe(true);
    const files = fs.readdirSync(convoDir);
    expect(files.length).toBe(1);
    expect(files[0].endsWith('.md')).toBe(true);
  });

  it('does not throw when the transcript is malformed JSON', async () => {
    const tp = path.join(sandbox, 'broken.jsonl');
    fs.writeFileSync(tp, 'not-json\n');
    const hook = createPreCompactHook();
    await expect(
      hook(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        { transcript_path: tp, session_id: 'sess-4' } as any,
        undefined,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        {} as any,
      ),
    ).resolves.toEqual({});
  });
});

describe('createSessionStartHook', () => {
  it('ignores sources other than compact/clear', async () => {
    const hook = createSessionStartHook(false);
    const result = await hook(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { source: 'startup' } as any,
      undefined,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      {} as any,
    );
    expect(result).toEqual({});
  });

  it('returns {} when neither group nor global CLAUDE.md exists', async () => {
    const hook = createSessionStartHook(false);
    const result = await hook(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { source: 'compact' } as any,
      undefined,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      {} as any,
    );
    expect(result).toEqual({});
  });

  it('injects group CLAUDE.md for main groups on compact', async () => {
    fs.writeFileSync(
      path.join(sandbox, 'group', 'CLAUDE.md'),
      'group instructions\n',
    );
    const hook = createSessionStartHook(true);
    const result = await hook(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { source: 'compact' } as any,
      undefined,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      {} as any,
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const out = result as any;
    expect(out.hookSpecificOutput.additionalContext).toContain(
      'group instructions',
    );
  });

  it('injects group AND global CLAUDE.md for non-main groups on clear', async () => {
    fs.writeFileSync(
      path.join(sandbox, 'group', 'CLAUDE.md'),
      'group-md\n',
    );
    fs.writeFileSync(
      path.join(sandbox, 'global', 'CLAUDE.md'),
      'global-md\n',
    );
    const hook = createSessionStartHook(false);
    const result = await hook(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { source: 'clear' } as any,
      undefined,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      {} as any,
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const out = result as any;
    expect(out.hookSpecificOutput.additionalContext).toContain('group-md');
    expect(out.hookSpecificOutput.additionalContext).toContain('global-md');
  });

  it('skips global CLAUDE.md for main groups', async () => {
    fs.writeFileSync(
      path.join(sandbox, 'global', 'CLAUDE.md'),
      'global-only\n',
    );
    const hook = createSessionStartHook(true);
    const result = await hook(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { source: 'compact' } as any,
      undefined,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      {} as any,
    );
    expect(result).toEqual({});
  });
});
