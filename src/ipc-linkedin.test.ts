import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';

// Hoist mocks before any imports
const fsMocks = vi.hoisted(() => ({
  existsSync: vi.fn<(s: string) => boolean>(),
  mkdirSync: vi.fn(),
  writeFileSync: vi.fn(),
  renameSync: vi.fn(),
}));

const spawnMock = vi.hoisted(() => vi.fn());

vi.mock('fs', () => ({ default: fsMocks }));
vi.mock('child_process', () => ({ spawn: spawnMock }));

import { handleLinkedInIpc } from './ipc-linkedin.js';

// ── Helpers ────────────────────────────────────────────────────────────────

type FakeProc = EventEmitter & {
  stdin: { write: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> };
  stdout: EventEmitter;
  stderr: EventEmitter;
  kill: ReturnType<typeof vi.fn>;
};

function makeFakeProc(stdout = '', stderr = '', exitCode = 0): FakeProc {
  const proc = Object.assign(new EventEmitter(), {
    stdin: { write: vi.fn(), end: vi.fn() },
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    kill: vi.fn(),
  }) as FakeProc;
  setImmediate(() => {
    if (stdout) proc.stdout.emit('data', Buffer.from(stdout));
    if (stderr) proc.stderr.emit('data', Buffer.from(stderr));
    proc.emit('close', exitCode);
  });
  return proc;
}

/** Wait one event-loop turn so setImmediate callbacks inside the handler run */
const flush = () => new Promise<void>((r) => setImmediate(r));

function writtenResult(): unknown {
  const call = fsMocks.writeFileSync.mock.calls[0];
  return JSON.parse(call[1] as string);
}

// ── Setup ──────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  fsMocks.existsSync.mockReturnValue(true);
  spawnMock.mockImplementation(() =>
    makeFakeProc('{"success":true,"message":"ok"}'),
  );
});

// ── isMain guard ───────────────────────────────────────────────────────────

describe('isMain guard', () => {
  it('returns true and writes error result when isMain is false', async () => {
    const result = await handleLinkedInIpc(
      { type: 'li_connect', requestId: 'req-guard' },
      'other-group',
      false,
      '/data',
    );
    expect(result).toBe(true);
    expect(fsMocks.writeFileSync).toHaveBeenCalled();
    const written = writtenResult() as { success: boolean; message: string };
    expect(written.success).toBe(false);
    expect(written.message).toMatch(/main group/i);
    expect(spawnMock).not.toHaveBeenCalled();
  });
});

// ── Task type routing ──────────────────────────────────────────────────────

describe('task type routing', () => {
  it('returns false for an unknown task type', async () => {
    const result = await handleLinkedInIpc(
      { type: 'foo_bar' },
      'main',
      true,
      '/data',
    );
    expect(result).toBe(false);
  });

  it('returns true for li_connect', async () => {
    const result = await handleLinkedInIpc(
      { type: 'li_connect' },
      'main',
      true,
      '/data',
    );
    expect(result).toBe(true);
  });

  it('returns true for li_scrape_search', async () => {
    const result = await handleLinkedInIpc(
      { type: 'li_scrape_search' },
      'main',
      true,
      '/data',
    );
    expect(result).toBe(true);
  });

  it('returns true for li_get_campaign_stats', async () => {
    const result = await handleLinkedInIpc(
      { type: 'li_get_campaign_stats' },
      'main',
      true,
      '/data',
    );
    expect(result).toBe(true);
  });

  it('returns true for all 17 known li_* types', async () => {
    const types = [
      'li_visit_profile',
      'li_connect',
      'li_withdraw_request',
      'li_message',
      'li_follow',
      'li_unfollow',
      'li_like_post',
      'li_react_post',
      'li_comment_post',
      'li_share_post',
      'li_endorse_skill',
      'li_scrape_search',
      'li_scrape_profile',
      'li_scrape_post_engagers',
      'li_run_campaign',
      'li_bulk_message',
      'li_get_campaign_stats',
    ];
    for (const type of types) {
      const result = await handleLinkedInIpc({ type }, 'main', true, '/data');
      expect(result, `expected true for ${type}`).toBe(true);
    }
    // Drain all setImmediate callbacks spawned above so they don't leak into the next test
    await flush();
  });
});

// ── Request ID ─────────────────────────────────────────────────────────────

describe('request ID', () => {
  it('uses provided requestId in the result filename', async () => {
    await handleLinkedInIpc(
      { type: 'li_connect', requestId: 'custom-id-123' },
      'main',
      true,
      '/data',
    );
    await flush();
    const renameTarget = fsMocks.renameSync.mock.calls[0][1] as string;
    expect(renameTarget).toContain('custom-id-123');
  });

  it('auto-generates requestId starting with "li-" when absent', async () => {
    await handleLinkedInIpc({ type: 'li_connect' }, 'main', true, '/data');
    await flush();
    const renameTarget = fsMocks.renameSync.mock.calls[0][1] as string;
    expect(renameTarget).toMatch(/li-\d+\.json$/);
  });
});

// ── Results directory path (regression for fixed bug) ─────────────────────

describe('results directory path', () => {
  it('includes sourceGroup in the path: dataDir/ipc/sourceGroup/li_results', async () => {
    await handleLinkedInIpc(
      { type: 'li_connect' },
      'telegram_main',
      true,
      '/mydata',
    );
    await flush();
    const mkdirPath = fsMocks.mkdirSync.mock.calls[0][0] as string;
    expect(mkdirPath).toMatch(/\/mydata\/ipc\/telegram_main\/li_results$/);
  });

  it('does NOT write to flat dataDir/ipc/li_results (old buggy path)', async () => {
    await handleLinkedInIpc(
      { type: 'li_connect' },
      'telegram_main',
      true,
      '/mydata',
    );
    await flush();
    const mkdirPath = fsMocks.mkdirSync.mock.calls[0][0] as string;
    expect(mkdirPath).not.toMatch(/\/ipc\/li_results/);
  });

  it('uses the correct sourceGroup in path across different groups', async () => {
    await handleLinkedInIpc(
      { type: 'li_connect' },
      'whatsapp_main',
      true,
      '/data',
    );
    await flush();
    const mkdirPath = fsMocks.mkdirSync.mock.calls[0][0] as string;
    expect(mkdirPath).toContain('/ipc/whatsapp_main/li_results');
  });
});

// ── Script resolution ──────────────────────────────────────────────────────

describe('script resolution', () => {
  it('writes { success:false } with "Script not found" when script file missing', async () => {
    fsMocks.existsSync.mockReturnValue(false);
    await handleLinkedInIpc(
      { type: 'li_connect', requestId: 'req-1' },
      'main',
      true,
      '/data',
    );
    await flush();
    const result = writtenResult() as { success: boolean; message: string };
    expect(result.success).toBe(false);
    expect(result.message).toMatch(/Script not found/i);
  });

  it('writes { success:false } with "Failed to spawn" when spawn emits error', async () => {
    const errorProc = Object.assign(new EventEmitter(), {
      stdin: { write: vi.fn(), end: vi.fn() },
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      kill: vi.fn(),
    });
    setImmediate(() =>
      errorProc.emit('error', new Error('ENOENT: npx not found')),
    );
    spawnMock.mockImplementation(() => errorProc);

    await handleLinkedInIpc(
      { type: 'li_connect', requestId: 'req-2' },
      'main',
      true,
      '/data',
    );
    await flush();
    const result = writtenResult() as { success: boolean; message: string };
    expect(result.success).toBe(false);
    expect(result.message).toMatch(/Failed to spawn/i);
  });
});

// ── Subprocess output handling ─────────────────────────────────────────────

describe('subprocess output handling', () => {
  it('parses stdout JSON and writes it verbatim', async () => {
    spawnMock.mockImplementation(() =>
      makeFakeProc(
        '{"success":true,"message":"scraped 5 leads","data":{"count":5}}',
      ),
    );
    await handleLinkedInIpc(
      { type: 'li_scrape_search' },
      'main',
      true,
      '/data',
    );
    await flush();
    const result = writtenResult() as {
      success: boolean;
      message: string;
      data: { count: number };
    };
    expect(result).toMatchObject({
      success: true,
      message: 'scraped 5 leads',
      data: { count: 5 },
    });
  });

  it('writes { success:true } when subprocess exits 0 with no stdout', async () => {
    spawnMock.mockImplementation(() => makeFakeProc('', '', 0));
    await handleLinkedInIpc({ type: 'li_connect' }, 'main', true, '/data');
    await flush();
    const result = writtenResult() as { success: boolean };
    expect(result.success).toBe(true);
  });

  it('writes { success:false } with stderr content when subprocess exits non-zero', async () => {
    spawnMock.mockImplementation(() =>
      makeFakeProc('', 'Chrome launch failed: no display', 1),
    );
    await handleLinkedInIpc({ type: 'li_connect' }, 'main', true, '/data');
    await flush();
    const result = writtenResult() as { success: boolean; message: string };
    expect(result.success).toBe(false);
    expect(result.message).toContain('Chrome launch failed');
  });

  it('falls back to exit-code message when stderr is empty and exit non-zero', async () => {
    spawnMock.mockImplementation(() => makeFakeProc('', '', 137));
    await handleLinkedInIpc({ type: 'li_connect' }, 'main', true, '/data');
    await flush();
    const result = writtenResult() as { success: boolean; message: string };
    expect(result.success).toBe(false);
    expect(result.message).toMatch(/137/);
  });
});

// ── Payload stripping ──────────────────────────────────────────────────────

describe('payload sent to subprocess', () => {
  it('does not include "type" or "requestId" in stdin payload', async () => {
    spawnMock.mockImplementation(() => makeFakeProc());
    await handleLinkedInIpc(
      {
        type: 'li_connect',
        requestId: 'req-9',
        profile_url: 'https://linkedin.com/in/test',
        note: 'Hi',
      },
      'main',
      true,
      '/data',
    );
    await flush();
    const proc = spawnMock.mock.results[0].value as FakeProc;
    const stdinData = JSON.parse(proc.stdin.write.mock.calls[0][0] as string);
    expect(stdinData).not.toHaveProperty('type');
    expect(stdinData).not.toHaveProperty('requestId');
    expect(stdinData).toHaveProperty(
      'profile_url',
      'https://linkedin.com/in/test',
    );
    expect(stdinData).toHaveProperty('note', 'Hi');
  });
});
