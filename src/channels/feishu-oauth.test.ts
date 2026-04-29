import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---- mocks ----

const mockGetFeishuTokenByUserId = vi.fn();
const mockSetFeishuToken = vi.fn();
const mockGetAllFeishuTokenUsers = vi.fn(() => []);

vi.mock('../db.js', () => ({
  getFeishuTokenByUserId: (...args: unknown[]) =>
    mockGetFeishuTokenByUserId(...args),
  setFeishuToken: (...args: unknown[]) => mockSetFeishuToken(...args),
  getAllFeishuTokenUsers: () => mockGetAllFeishuTokenUsers(),
}));

vi.mock('../env.js', () => ({
  readEnvFile: vi.fn(() => ({
    FEISHU_APP_ID: 'test-app-id',
    FEISHU_APP_SECRET: 'test-app-secret',
  })),
}));

vi.mock('../logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Mock fetch globally
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

import { getFeishuUserToken, buildAuthUrl } from './feishu-oauth.js';

// ---- 清理全局状态 ----

beforeEach(() => {
  vi.clearAllMocks();
  // 通过导入模块内部状态清理缓存是不可能的（tokenCache 是私有的）
  // 但每个测试使用不同的 userId 来避免缓存污染
});

// ---- buildAuthUrl ----

describe('buildAuthUrl', () => {
  it('包含 app_id、redirect_uri、scope、state', () => {
    const url = buildAuthUrl('test-state');
    expect(url).toContain('app_id=test-app-id');
    expect(url).toContain('redirect_uri=');
    expect(url).toContain('scope=');
    expect(url).toContain('state=test-state');
  });

  it('state 被 encodeURIComponent', () => {
    const url = buildAuthUrl('fs:oc_xxx|folder_name');
    expect(url).toContain(
      `state=${encodeURIComponent('fs:oc_xxx|folder_name')}`,
    );
  });

  it('包含授权 URL 基础路径', () => {
    const url = buildAuthUrl('s');
    expect(url).toContain('open.feishu.cn/open-apis/authen/v1/authorize');
  });
});

// ---- getFeishuUserToken ----

describe('getFeishuUserToken', () => {
  it('DB 无记录 → 返回 null', async () => {
    mockGetFeishuTokenByUserId.mockReturnValue(null);
    const token = await getFeishuUserToken('user-no-record');
    expect(token).toBeNull();
  });

  it('DB token 未过期 → 返回 token + 不调 refresh', async () => {
    const userId = `user-valid-${Date.now()}`;
    mockGetFeishuTokenByUserId.mockReturnValue({
      access_token: 'valid-token',
      refresh_token: 'refresh-xxx',
      expires_at: new Date(Date.now() + 3600_000).toISOString(), // 1 小时后过期
      chat_jid: 'fs:oc_test',
    });

    const token = await getFeishuUserToken(userId);
    expect(token).toBe('valid-token');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('DB token 即将过期 → 触发 refresh', async () => {
    const userId = `user-expiring-${Date.now()}`;
    mockGetFeishuTokenByUserId.mockReturnValue({
      access_token: 'old-token',
      refresh_token: 'refresh-xxx',
      expires_at: new Date(Date.now() + 60_000).toISOString(), // 1 分钟后过期（在 5 分钟刷新窗口内）
      chat_jid: 'fs:oc_test',
    });

    // Mock app_access_token 响应
    mockFetch
      .mockResolvedValueOnce({
        json: async () => ({ app_access_token: 'app-token-xxx' }),
      })
      // Mock refresh_access_token 响应
      .mockResolvedValueOnce({
        json: async () => ({
          code: 0,
          data: {
            access_token: 'new-access-token',
            refresh_token: 'new-refresh-token',
            expires_in: 7200,
          },
        }),
      });

    const token = await getFeishuUserToken(userId);
    expect(token).toBe('new-access-token');
    expect(mockSetFeishuToken).toHaveBeenCalled();
  });

  it('refresh 失败 → 返回 null', async () => {
    const userId = `user-refresh-fail-${Date.now()}`;
    mockGetFeishuTokenByUserId.mockReturnValue({
      access_token: 'old-token',
      refresh_token: 'refresh-xxx',
      expires_at: new Date(Date.now() + 60_000).toISOString(),
      chat_jid: 'fs:oc_test',
    });

    // Mock app_access_token 响应
    mockFetch
      .mockResolvedValueOnce({
        json: async () => ({ app_access_token: 'app-token-xxx' }),
      })
      // Mock refresh 失败
      .mockResolvedValueOnce({
        json: async () => ({
          code: 99999,
          msg: 'invalid refresh token',
        }),
      });

    const token = await getFeishuUserToken(userId);
    expect(token).toBeNull();
  });

  it('内存缓存命中 → 不查 DB', async () => {
    const userId = `user-cache-${Date.now()}`;

    // 第一次：从 DB 读
    mockGetFeishuTokenByUserId.mockReturnValue({
      access_token: 'cached-token',
      refresh_token: 'refresh-xxx',
      expires_at: new Date(Date.now() + 3600_000).toISOString(),
      chat_jid: 'fs:oc_test',
    });

    await getFeishuUserToken(userId);
    expect(mockGetFeishuTokenByUserId).toHaveBeenCalledTimes(1);

    // 第二次：应该走缓存
    mockGetFeishuTokenByUserId.mockClear();
    const token2 = await getFeishuUserToken(userId);
    expect(token2).toBe('cached-token');
    expect(mockGetFeishuTokenByUserId).not.toHaveBeenCalled();
  });

  it('refresh 并发去重（两次调用只触发一次 fetch）', async () => {
    const userId = `user-dedup-${Date.now()}`;
    mockGetFeishuTokenByUserId.mockReturnValue({
      access_token: 'old',
      refresh_token: 'refresh-xxx',
      expires_at: new Date(Date.now() + 60_000).toISOString(),
      chat_jid: 'fs:oc_test',
    });

    mockFetch
      .mockResolvedValueOnce({
        json: async () => ({ app_access_token: 'app-token' }),
      })
      .mockResolvedValueOnce({
        json: async () => ({
          code: 0,
          data: {
            access_token: 'deduped-token',
            refresh_token: 'new-refresh',
            expires_in: 7200,
          },
        }),
      });

    // 并发调用
    const [t1, t2] = await Promise.all([
      getFeishuUserToken(userId),
      getFeishuUserToken(userId),
    ]);

    expect(t1).toBe('deduped-token');
    expect(t2).toBe('deduped-token');
    // app_access_token 只请求一次
    expect(mockFetch).toHaveBeenCalledTimes(2); // 1 app_token + 1 refresh
  });
});
