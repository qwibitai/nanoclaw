import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { writeOutput, createPreCompactHook } from './output.js';

function mkTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'index-test-'));
}

function rmDir(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

// writeOutput

describe('writeOutput', () => {
  /**
   * INVARIANT: writeOutput wraps output in start/end markers that the host
   * uses to parse container results. If markers are wrong, the host can't
   * parse any results.
   */
  it('wraps output with correct markers', () => {
    const logs: string[] = [];
    const mockLog = (msg: string) => logs.push(msg);

    writeOutput(
      { status: 'success', result: 'test result', newSessionId: 'sess-1' },
      mockLog,
    );

    expect(logs[0]).toBe('---NANOCLAW_OUTPUT_START---');
    expect(logs[2]).toBe('---NANOCLAW_OUTPUT_END---');
  });

  it('outputs valid JSON between markers', () => {
    const logs: string[] = [];
    const mockLog = (msg: string) => logs.push(msg);

    const output = {
      status: 'success' as const,
      result: 'test',
      newSessionId: 'sess-1',
    };
    writeOutput(output, mockLog);

    const parsed = JSON.parse(logs[1]);
    expect(parsed.status).toBe('success');
    expect(parsed.result).toBe('test');
    expect(parsed.newSessionId).toBe('sess-1');
  });

  it('handles error output', () => {
    const logs: string[] = [];
    const mockLog = (msg: string) => logs.push(msg);

    writeOutput(
      { status: 'error', result: null, error: 'something failed' },
      mockLog,
    );

    const parsed = JSON.parse(logs[1]);
    expect(parsed.status).toBe('error');
    expect(parsed.error).toBe('something failed');
  });
});

// createPreCompactHook

describe('createPreCompactHook', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkTmpDir();
  });

  afterEach(() => {
    rmDir(tmpDir);
  });

  /**
   * INVARIANT: createPreCompactHook archives the transcript as a markdown
   * file in the conversations directory before compaction occurs.
   */
  it('archives transcript to conversations directory', async () => {
    // Create a fake transcript file
    const transcriptPath = path.join(tmpDir, 'transcript.jsonl');
    const transcript = [
      JSON.stringify({
        type: 'user',
        message: { content: 'Hello' },
        uuid: '1',
      }),
      JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'Hi there!' }] },
        uuid: '2',
      }),
    ].join('\n');
    fs.writeFileSync(transcriptPath, transcript);

    const conversationsDir = path.join(tmpDir, 'conversations');
    const hook = createPreCompactHook(conversationsDir, 'TestBot');

    const input = {
      transcript_path: transcriptPath,
      session_id: 'test-session',
    };

    await hook(input, undefined, undefined);

    // Should have created a file in conversations dir
    expect(fs.existsSync(conversationsDir)).toBe(true);
    const files = fs.readdirSync(conversationsDir);
    expect(files.length).toBe(1);
    expect(files[0]).toMatch(/\.md$/);
  });

  it('returns empty object on missing transcript', async () => {
    const conversationsDir = path.join(tmpDir, 'conversations');
    const hook = createPreCompactHook(conversationsDir);

    const input = {
      transcript_path: '/nonexistent/transcript.jsonl',
      session_id: 'test-session',
    };

    const result = await hook(input, undefined, undefined);
    expect(result).toEqual({});
    expect(fs.existsSync(conversationsDir)).toBe(false);
  });

  it('handles errors gracefully without crashing', async () => {
    const conversationsDir = path.join(tmpDir, 'conversations');
    const hook = createPreCompactHook(conversationsDir);

    // Pass invalid input
    const input = { transcript_path: '', session_id: '' };

    const result = await hook(input, undefined, undefined);
    expect(result).toEqual({});
  });
});
