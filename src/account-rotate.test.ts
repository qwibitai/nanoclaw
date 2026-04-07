import { describe, it, expect, beforeEach, vi } from 'vitest';

import {
  _initTestDatabase,
  getRotateEnabled,
  setRotateEnabled,
  getRotateIndex,
  setRotateIndex,
  getLastRotateAt,
  setLastRotateAt,
} from './db.js';
import { detectRateLimit, rotateAccount } from './container-runner.js';

// Mock config
vi.mock('./config.js', () => ({
  DATA_DIR: '/tmp/nanoclaw-test-data',
  GROUPS_DIR: '/tmp/nanoclaw-test-groups',
  IDLE_TIMEOUT: 1800000,
  ONECLI_URL: 'http://localhost:10254',
  TIMEZONE: 'America/Los_Angeles',
}));

// Mock logger
vi.mock('./logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Mock fs
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    default: {
      ...actual,
      existsSync: vi.fn(() => false),
      mkdirSync: vi.fn(),
      writeFileSync: vi.fn(),
      readFileSync: vi.fn(() => ''),
      readdirSync: vi.fn(() => []),
      statSync: vi.fn(() => ({ isDirectory: () => false })),
    },
  };
});

// Mock env
vi.mock('./env.js', () => ({
  readEnvFile: vi.fn(() => ({})),
}));

// Mock group-folder
vi.mock('./group-folder.js', () => ({
  resolveGroupFolderPath: (folder: string) =>
    `/tmp/nanoclaw-test-groups/${folder}`,
  resolveGroupIpcPath: (folder: string) =>
    `/tmp/nanoclaw-test-data/ipc/${folder}`,
}));

// Mock child_process — 控制 execSync 的返回值
const mockExecSync = vi.fn();
vi.mock('child_process', async () => {
  const actual =
    await vi.importActual<typeof import('child_process')>('child_process');
  return {
    ...actual,
    execSync: (...args: unknown[]) => mockExecSync(...args),
    spawn: vi.fn(),
  };
});

// --- detectRateLimit 测试 ---

describe('detectRateLimit', () => {
  it('匹配 429 状态码', () => {
    expect(detectRateLimit('Error: 429 Too Many Requests')).toBe(true);
  });

  it('匹配 rate_limit_error', () => {
    expect(
      detectRateLimit('{"type":"error","error":{"type":"rate_limit_error"}}'),
    ).toBe(true);
  });

  it('匹配 rate limit（带空格）', () => {
    expect(detectRateLimit('Rate limit exceeded')).toBe(true);
  });

  it('匹配 overloaded', () => {
    expect(
      detectRateLimit('{"type":"error","error":{"type":"overloaded_error"}}'),
    ).toBe(true);
  });

  it('匹配 quota exceeded', () => {
    expect(detectRateLimit('API quota exceeded for this billing period')).toBe(
      true,
    );
  });

  it('匹配 too many requests', () => {
    expect(detectRateLimit('too many requests, please slow down')).toBe(true);
  });

  it('不匹配普通错误', () => {
    expect(detectRateLimit('TypeError: Cannot read property')).toBe(false);
  });

  it('不匹配空字符串', () => {
    expect(detectRateLimit('')).toBe(false);
  });

  it('匹配 stderr 中的混合输出', () => {
    const stderr = `[debug] starting container\nError: 429 rate_limit_error\n[debug] exiting`;
    expect(detectRateLimit(stderr)).toBe(true);
  });
});

// --- DB 持久化测试 ---

describe('account_rotate_config DB', () => {
  beforeEach(() => {
    _initTestDatabase();
  });

  it('默认 rotateEnabled = false', () => {
    expect(getRotateEnabled()).toBe(false);
  });

  it('setRotateEnabled → getRotateEnabled 保持一致', () => {
    setRotateEnabled(true);
    expect(getRotateEnabled()).toBe(true);
    setRotateEnabled(false);
    expect(getRotateEnabled()).toBe(false);
  });

  it('默认 rotateIndex = 0', () => {
    expect(getRotateIndex()).toBe(0);
  });

  it('setRotateIndex → getRotateIndex 保持一致', () => {
    setRotateIndex(3);
    expect(getRotateIndex()).toBe(3);
  });

  it('默认 lastRotateAt = null', () => {
    expect(getLastRotateAt()).toBeNull();
  });

  it('setLastRotateAt → getLastRotateAt 保持一致', () => {
    const ts = Date.now();
    setLastRotateAt(ts);
    expect(getLastRotateAt()).toBe(ts);
  });
});

// --- rotateAccount 测试 ---

describe('rotateAccount', () => {
  beforeEach(() => {
    _initTestDatabase();
    mockExecSync.mockReset();
  });

  it('未开启时返回 null', () => {
    setRotateEnabled(false);
    expect(rotateAccount('test-agent')).toBeNull();
  });

  it('60 秒内防抖返回 null', () => {
    setRotateEnabled(true);
    setLastRotateAt(Date.now() - 30_000); // 30 秒前
    expect(rotateAccount('test-agent')).toBeNull();
  });

  it('成功轮换到下一个 secret', () => {
    setRotateEnabled(true);
    setRotateIndex(0);
    // 确保不在防抖期
    setLastRotateAt(Date.now() - 120_000);

    const secrets = [
      { id: 'sec-1', name: 'account-a' },
      { id: 'sec-2', name: 'account-b' },
      { id: 'sec-3', name: 'account-c' },
    ];
    const agents = [
      { id: 'agent-1', identifier: 'test-agent', isDefault: false },
    ];

    mockExecSync
      .mockReturnValueOnce(JSON.stringify(secrets)) // secrets list
      .mockReturnValueOnce(JSON.stringify(agents)) // agents list
      .mockReturnValueOnce(''); // set-secrets

    const result = rotateAccount('test-agent');
    expect(result).toEqual({ success: true, newSecretName: 'account-b' });
    expect(getRotateIndex()).toBe(1);
    expect(getLastRotateAt()).toBeGreaterThan(0);
  });

  it('轮换一圈后检测全部耗尽', () => {
    setRotateEnabled(true);
    // index 在最后一个位置，下一个是 0（回到起点）
    setRotateIndex(2);
    // 上次轮换在 5 分钟前（10 分钟 cooldown 内）
    setLastRotateAt(Date.now() - 5 * 60 * 1000);

    const secrets = [
      { id: 'sec-1', name: 'account-a' },
      { id: 'sec-2', name: 'account-b' },
      { id: 'sec-3', name: 'account-c' },
    ];

    mockExecSync.mockReturnValueOnce(JSON.stringify(secrets));

    const result = rotateAccount('test-agent');
    expect(result).toEqual({ success: false, newSecretName: '' });
  });

  it('只有一个 secret 时返回 null', () => {
    setRotateEnabled(true);
    setLastRotateAt(Date.now() - 120_000);

    mockExecSync.mockReturnValueOnce(
      JSON.stringify([{ id: 'sec-1', name: 'account-a' }]),
    );

    expect(rotateAccount('test-agent')).toBeNull();
  });

  it('cooldown 过期后允许再次轮换到 index 0', () => {
    setRotateEnabled(true);
    setRotateIndex(2);
    // 上次轮换在 15 分钟前（超过 10 分钟 cooldown）
    setLastRotateAt(Date.now() - 15 * 60 * 1000);

    const secrets = [
      { id: 'sec-1', name: 'account-a' },
      { id: 'sec-2', name: 'account-b' },
      { id: 'sec-3', name: 'account-c' },
    ];
    const agents = [
      { id: 'agent-1', identifier: 'test-agent', isDefault: false },
    ];

    mockExecSync
      .mockReturnValueOnce(JSON.stringify(secrets))
      .mockReturnValueOnce(JSON.stringify(agents))
      .mockReturnValueOnce('');

    const result = rotateAccount('test-agent');
    expect(result).toEqual({ success: true, newSecretName: 'account-a' });
    expect(getRotateIndex()).toBe(0);
  });
});
