import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { runStartupOllamaCheck, setStatusFilePathForTest } from './host-ollama-status.js';

vi.mock('./log.js', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

describe('runStartupOllamaCheck', () => {
  let tmpDir: string;
  let statusPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ollama-test-'));
    statusPath = path.join(tmpDir, 'test-status.json');
    setStatusFilePathForTest(statusPath);
  });

  afterEach(() => {
    setStatusFilePathForTest(null);
    vi.restoreAllMocks();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('test_ok_when_ollama_responds', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(new Response(JSON.stringify({ models: [] }), { status: 200 }));

    const result = await runStartupOllamaCheck();
    expect(result.ok).toBe(true);
    expect(result.checkedAt).toBeTruthy();

    const written = JSON.parse(fs.readFileSync(statusPath, 'utf8')) as { ok: boolean };
    expect(written.ok).toBe(true);
  });

  it('test_failure_when_ollama_unreachable', async () => {
    vi.spyOn(global, 'fetch').mockRejectedValue(Object.assign(new Error('ECONNREFUSED'), { code: 'ECONNREFUSED' }));

    const result = await runStartupOllamaCheck();
    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();

    const written = JSON.parse(fs.readFileSync(statusPath, 'utf8')) as { ok: boolean };
    expect(written.ok).toBe(false);
  });

  it('test_timeout_writes_failure', async () => {
    vi.spyOn(global, 'fetch').mockImplementation((_url, opts) => {
      const signal = (opts as RequestInit | undefined)?.signal;
      return new Promise((_, reject) => {
        const timer = setTimeout(() => reject(new Error('aborted')), 2000);
        signal?.addEventListener('abort', () => {
          clearTimeout(timer);
          reject(new Error('aborted'));
        });
      });
    });

    const start = Date.now();
    const result = await runStartupOllamaCheck();
    const elapsed = Date.now() - start;

    expect(result.ok).toBe(false);
    // Should abort within ~1.5s (1s timeout + overhead), not wait 2s.
    expect(elapsed).toBeLessThan(1500);

    const written = JSON.parse(fs.readFileSync(statusPath, 'utf8')) as { ok: boolean };
    expect(written.ok).toBe(false);
  });

  it('test_does_not_throw_on_filesystem_error', async () => {
    setStatusFilePathForTest('/nonexistent-dir/foo.json');
    vi.spyOn(global, 'fetch').mockResolvedValue(new Response(JSON.stringify({ models: [] }), { status: 200 }));

    // Should not throw even when file write fails.
    await expect(runStartupOllamaCheck()).resolves.toBeDefined();
  });
});
