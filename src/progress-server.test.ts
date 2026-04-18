import { describe, it, expect, vi } from 'vitest';

// ---- mocks ----

vi.mock('./config.js', () => ({
  STORE_DIR: '/tmp/nanoclaw-test-store',
}));

vi.mock('./logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import {
  upsertSession,
  completeSession,
  deleteSession,
  getProgressUrl,
  getLanIp,
  PROGRESS_SERVER_PORT,
  _getSessionForTest,
} from './progress-server.js';

// ---- session CRUD ----

describe('session CRUD', () => {
  const id = () =>
    `test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  it('upsertSession 创建新 session 且状态可读', () => {
    const sid = id();
    upsertSession(sid, [{ title: '步骤 1' }], Date.now());
    const s = _getSessionForTest(sid);
    expect(s).not.toBeNull();
    expect(s!.steps).toHaveLength(1);
    expect(s!.steps[0].title).toBe('步骤 1');
    expect(s!.completed).toBe(false);
  });

  it('upsertSession 更新已有 session 的步骤', () => {
    const sid = id();
    const now = Date.now();
    upsertSession(sid, [{ title: '步骤 1' }], now);
    upsertSession(sid, [{ title: '步骤 1' }, { title: '步骤 2' }], now);
    const s = _getSessionForTest(sid);
    expect(s!.steps).toHaveLength(2);
    expect(s!.steps[1].title).toBe('步骤 2');
  });

  it('completeSession 标记 completed=true', () => {
    const sid = id();
    upsertSession(sid, [{ title: '步骤 1' }], Date.now());
    completeSession(sid);
    const s = _getSessionForTest(sid);
    expect(s!.completed).toBe(true);
  });

  it('deleteSession 后 session 不存在', () => {
    const sid = id();
    upsertSession(sid, [{ title: '步骤 1' }], Date.now());
    deleteSession(sid);
    expect(_getSessionForTest(sid)).toBeNull();
  });

  it('不存在的 session completeSession 不抛异常', () => {
    expect(() => completeSession('nonexistent-abc')).not.toThrow();
  });

  it('不存在的 session deleteSession 不抛异常', () => {
    expect(() => deleteSession('nonexistent-def')).not.toThrow();
  });

  it('多次 upsert 同一 session 步骤正确累积', () => {
    const sid = id();
    const now = Date.now();
    for (let i = 0; i < 5; i++) {
      upsertSession(
        sid,
        Array.from({ length: i + 1 }, (_, j) => ({ title: `步骤 ${j + 1}` })),
        now,
      );
    }
    const s = _getSessionForTest(sid);
    expect(s!.steps).toHaveLength(5);
  });

  it('completeSession 后再 deleteSession → session 不存在', () => {
    const sid = id();
    upsertSession(sid, [{ title: 'x' }], Date.now());
    completeSession(sid);
    deleteSession(sid);
    expect(_getSessionForTest(sid)).toBeNull();
  });
});

// ---- getProgressUrl ----

describe('getProgressUrl', () => {
  it('格式正确：包含 /p/{id}', () => {
    const url = getProgressUrl('sess123');
    expect(url).toMatch(/^http:\/\/.+:\d+\/p\/sess123$/);
  });

  it('包含配置端口', () => {
    const url = getProgressUrl('test');
    expect(url).toContain(`:${PROGRESS_SERVER_PORT}/`);
  });

  it('不同 sessionId 产生不同 URL', () => {
    const u1 = getProgressUrl('aaa');
    const u2 = getProgressUrl('bbb');
    expect(u1).not.toBe(u2);
  });
});

// ---- getLanIp ----

describe('getLanIp', () => {
  it('返回有效 IPv4 地址', () => {
    const ip = getLanIp();
    expect(ip).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
  });
});
