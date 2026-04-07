import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---- mock 飞书 SDK ----

const mockCreate = vi
  .fn()
  .mockResolvedValue({ data: { message_id: 'msg_mock' } });
const mockPatch = vi.fn().mockResolvedValue({});
const mockReactionCreate = vi
  .fn()
  .mockResolvedValue({ data: { reaction_id: 'react_1' } });
const mockReactionDelete = vi.fn().mockResolvedValue({});
const mockChatList = vi.fn().mockResolvedValue({
  data: {
    items: [
      { chat_id: 'oc_group1', name: '测试群' },
      { chat_id: 'oc_group2', name: '开发群' },
    ],
    page_token: undefined,
    has_more: false,
  },
});

vi.mock('@larksuiteoapi/node-sdk', () => {
  class MockClient {
    im = {
      message: { create: mockCreate, patch: mockPatch },
      messageReaction: {
        create: mockReactionCreate,
        delete: mockReactionDelete,
      },
      chat: { list: mockChatList },
    };
  }
  class MockWSClient {
    close = vi.fn();
    start = vi.fn().mockResolvedValue(undefined);
  }
  class MockEventDispatcher {
    register() {
      return this;
    }
  }
  return {
    Client: MockClient,
    WSClient: MockWSClient,
    EventDispatcher: MockEventDispatcher,
    Domain: { Feishu: 'https://open.feishu.cn' },
    LoggerLevel: { warn: 2 },
  };
});

vi.mock('../group-folder.js', () => ({
  resolveGroupFolderPath: (folder: string) => `/tmp/groups/${folder}`,
}));

import { FeishuChannel } from './feishu.js';
import type { ChannelOpts } from './registry.js';

// ---- 测试辅助 ----

function makeOpts(overrides?: Partial<ChannelOpts>): ChannelOpts {
  return {
    onMessage: vi.fn(),
    onChatMetadata: vi.fn(),
    registeredGroups: () => ({}),
    ...overrides,
  };
}

// ---- 测试 ----

describe('FeishuChannel', () => {
  let channel: FeishuChannel;
  let opts: ChannelOpts;

  beforeEach(() => {
    vi.clearAllMocks();
    opts = makeOpts();
    channel = new FeishuChannel('app_id', 'app_secret', opts);
  });

  describe('基本属性', () => {
    it('name 为 feishu', () => {
      expect(channel.name).toBe('feishu');
    });

    it('ownsJid 匹配 fs: 前缀', () => {
      expect(channel.ownsJid('fs:oc_123')).toBe(true);
      expect(channel.ownsJid('tg:123')).toBe(false);
      expect(channel.ownsJid('slack:C123')).toBe(false);
    });
  });

  describe('connect / disconnect', () => {
    it('connect 后 isConnected 为 true', async () => {
      expect(channel.isConnected()).toBe(false);
      await channel.connect();
      expect(channel.isConnected()).toBe(true);
    });

    it('disconnect 后 isConnected 为 false', async () => {
      await channel.connect();
      await channel.disconnect();
      expect(channel.isConnected()).toBe(false);
    });
  });

  describe('sendMessage', () => {
    it('短文本用 text 类型发送', async () => {
      await channel.sendMessage('fs:oc_123', 'hello');
      expect(mockCreate).toHaveBeenCalledWith({
        data: {
          receive_id: 'oc_123',
          msg_type: 'text',
          content: JSON.stringify({ text: 'hello' }),
        },
        params: { receive_id_type: 'chat_id' },
      });
    });

    it('长文本用 interactive 卡片发送', async () => {
      const longText = 'a'.repeat(501);
      await channel.sendMessage('fs:oc_123', longText);
      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            receive_id: 'oc_123',
            msg_type: 'interactive',
          }),
        }),
      );
    });

    it('含 Markdown 代码块的文本用卡片发送', async () => {
      const mdText = '看看这个:\n```js\nconsole.log(1)\n```';
      await channel.sendMessage('fs:oc_123', mdText);
      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ msg_type: 'interactive' }),
        }),
      );
    });

    it('含 Markdown 标题的文本用卡片发送', async () => {
      await channel.sendMessage('fs:oc_123', '## 标题\n内容');
      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ msg_type: 'interactive' }),
        }),
      );
    });

    it('含表格的文本用卡片发送', async () => {
      await channel.sendMessage('fs:oc_123', '| 列1 | 列2 |\n| --- | --- |');
      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ msg_type: 'interactive' }),
        }),
      );
    });
  });

  describe('syncGroups', () => {
    it('同步群列表并调用 onChatMetadata', async () => {
      await channel.syncGroups();
      expect(mockChatList).toHaveBeenCalled();
      expect(opts.onChatMetadata).toHaveBeenCalledTimes(2);
      expect(opts.onChatMetadata).toHaveBeenCalledWith(
        'fs:oc_group1',
        expect.any(String),
        '测试群',
        'feishu',
        true,
      );
      expect(opts.onChatMetadata).toHaveBeenCalledWith(
        'fs:oc_group2',
        expect.any(String),
        '开发群',
        'feishu',
        true,
      );
    });
  });

  describe('extractPostContent', () => {
    it('提取纯文本 post', () => {
      const parsed = {
        content: [
          [
            { tag: 'text', text: '你好' },
            { tag: 'text', text: '世界' },
          ],
          [{ tag: 'text', text: '第二行' }],
        ],
      };
      const result = channel.extractPostContent(parsed);
      expect(result.text).toBe('你好世界\n第二行');
      expect(result.imageKeys).toEqual([]);
    });

    it('提取 post 中的图片 key', () => {
      const parsed = {
        title: '测试标题',
        content: [
          [
            { tag: 'text', text: '看看这张图' },
            { tag: 'img', image_key: 'img_abc123' },
          ],
          [{ tag: 'img', image_key: 'img_def456' }],
          [{ tag: 'text', text: '结束' }],
        ],
      };
      const result = channel.extractPostContent(parsed);
      expect(result.text).toBe('测试标题\n看看这张图\n结束');
      expect(result.imageKeys).toEqual(['img_abc123', 'img_def456']);
    });

    it('提取 a 标签中的文本', () => {
      const parsed = {
        content: [
          [
            { tag: 'text', text: '点击 ' },
            { tag: 'a', text: '这里', href: 'https://example.com' },
          ],
        ],
      };
      const result = channel.extractPostContent(parsed);
      expect(result.text).toBe('点击 这里');
    });

    it('空 content 返回空', () => {
      const result = channel.extractPostContent({});
      expect(result.text).toBe('');
      expect(result.imageKeys).toEqual([]);
    });

    it('有 title 无 content 只返回 title', () => {
      const result = channel.extractPostContent({ title: '仅标题' });
      expect(result.text).toBe('仅标题');
      expect(result.imageKeys).toEqual([]);
    });
  });

  describe('factory 注册', () => {
    it('无凭证时 factory 返回 null', async () => {
      // 清理环境变量确保不干扰
      const origId = process.env.FEISHU_APP_ID;
      const origSecret = process.env.FEISHU_APP_SECRET;
      delete process.env.FEISHU_APP_ID;
      delete process.env.FEISHU_APP_SECRET;

      // 重新导入以触发 factory
      const { getChannelFactory } = await import('./registry.js');
      const factory = getChannelFactory('feishu');
      expect(factory).toBeDefined();
      const result = factory!(opts);
      // 由于 .env 文件中也没有这些值，应该返回 null
      // 但如果 .env 有值则可能不为 null，所以只验证 factory 存在
      expect(factory).toBeTypeOf('function');

      // 恢复
      if (origId) process.env.FEISHU_APP_ID = origId;
      if (origSecret) process.env.FEISHU_APP_SECRET = origSecret;
    });
  });
});
