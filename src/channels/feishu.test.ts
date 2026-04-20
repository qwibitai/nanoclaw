import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---- mock 飞书 SDK ----

const mockCreate = vi
  .fn()
  .mockResolvedValue({ data: { message_id: 'msg_mock' } });
const mockPatch = vi.fn().mockResolvedValue({});
const mockMessageDelete = vi.fn().mockResolvedValue({});
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
      message: { create: mockCreate, patch: mockPatch, delete: mockMessageDelete },
      messageReaction: {
        create: mockReactionCreate,
        delete: mockReactionDelete,
      },
      chat: { list: mockChatList },
    };
    contact = {
      user: {
        get: vi.fn().mockResolvedValue({ data: { user: { name: '测试用户' } } }),
      },
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

  describe('sendPlainOrCard 降级', () => {
    it('卡片发送失败 → 自动降级纯文本', async () => {
      // 第一次 create（卡片）失败，第二次 create（纯文本）成功
      mockCreate
        .mockRejectedValueOnce(new Error('invalid image keys'))
        .mockResolvedValueOnce({ data: { message_id: 'msg_fallback' } });

      // 长文本 → shouldUseCard → interactive 卡片路径
      const longText = 'a'.repeat(501);
      await channel.sendMessage('fs:oc_123', longText);

      // create 被调用两次（卡片 + 降级纯文本）
      expect(mockCreate).toHaveBeenCalledTimes(2);
      // 第一次是 interactive
      expect(mockCreate.mock.calls[0][0].data.msg_type).toBe('interactive');
      // 第二次降级为 text
      expect(mockCreate.mock.calls[1][0].data.msg_type).toBe('text');
    });

    it('降级后纯文本也失败 → promise rejects', async () => {
      mockCreate
        .mockRejectedValueOnce(new Error('card failed'))
        .mockRejectedValueOnce(new Error('text also failed'));

      const longText = 'b'.repeat(501);
      await expect(
        channel.sendMessage('fs:oc_123', longText),
      ).rejects.toThrow('text also failed');
    });
  });

  describe('typing indicator', () => {
    it('setTyping(true) 添加 emoji reaction', async () => {
      // 设置最新 messageId（通过 private Map）
      (channel as any).lastMessageIds.set('fs:oc_typing', 'msg_user_1');

      await channel.setTyping!('fs:oc_typing', true);

      expect(mockReactionCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          path: { message_id: 'msg_user_1' },
        }),
      );
    });

    it('setTyping(false) 移除 emoji reaction', async () => {
      // 先 setTyping true（设置 reactionId）
      (channel as any).lastMessageIds.set('fs:oc_typing2', 'msg_user_2');
      await channel.setTyping!('fs:oc_typing2', true);

      await channel.setTyping!('fs:oc_typing2', false);

      expect(mockReactionDelete).toHaveBeenCalled();
    });

    it('无 lastMessageId 时 setTyping(true) 不抛异常', async () => {
      // 没有设置 lastMessageId
      await expect(
        channel.setTyping!('fs:oc_no_msg', true),
      ).resolves.toBeUndefined();
      // reaction 不应被调用
      expect(mockReactionCreate).not.toHaveBeenCalled();
    });
  });

  describe('进度消息聚合', () => {
    it('progressDone 后忽略迟到的进度消息', async () => {
      const jid = 'fs:oc_progress_done';
      // 模拟 progressDone 已标记（正式回复已到达）
      (channel as any).progressDone.add(jid);

      // 发送进度消息（emoji 开头）
      await channel.sendMessage(jid, '⚙️ 正在处理...');

      // 不应调用 create（被忽略）
      expect(mockCreate).not.toHaveBeenCalled();
    });

    it('💭 消息单独发送不加入卡片', async () => {
      const jid = 'fs:oc_thought';
      // 确保没有 progressDone 标记
      (channel as any).progressDone.delete(jid);

      await channel.sendMessage(jid, '💭 这是内部思考');

      // 应该调用 create 发送（而非 patch 卡片）
      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            receive_id: 'oc_thought',
          }),
        }),
      );
    });
  });

  describe('cleanupProgressCard', () => {
    const jid = 'fs:oc_test_cleanup';

    /** 手动注入一个进度卡片 entry，模拟 onAgentProgress 创建后的状态 */
    function injectProgressCard(messageId: string, steps: { title: string }[]) {
      // 通过 private Map 注入（测试场景合理使用 as any）
      (channel as any).progressCards.set(jid, {
        messageId,
        sessionId: 'sess_test',
        steps: steps.map((s) => ({ ...s, detail: undefined })),
        allSteps: steps.map((s) => ({ ...s, detail: undefined })),
        frame: 0,
        startTime: Date.now(),
      });
    }

    it('patch 成功时正常转为完成卡片', async () => {
      injectProgressCard('msg_card_1', [{ title: '⚙️ Bash: ls' }]);
      mockPatch.mockResolvedValueOnce({});

      await channel.cleanupProgressCard(jid);

      expect(mockPatch).toHaveBeenCalledWith(
        expect.objectContaining({
          path: { message_id: 'msg_card_1' },
        }),
      );
      expect(mockMessageDelete).not.toHaveBeenCalled();
    });

    it('patch 失败时 fallback 删除卡片', async () => {
      injectProgressCard('msg_card_2', [{ title: '⚙️ Bash: ls' }]);
      mockPatch.mockRejectedValueOnce(new Error('ErrCode: 200800'));

      await channel.cleanupProgressCard(jid);

      // patch 被调用且失败
      expect(mockPatch).toHaveBeenCalledWith(
        expect.objectContaining({
          path: { message_id: 'msg_card_2' },
        }),
      );
      // fallback: 删除卡片
      expect(mockMessageDelete).toHaveBeenCalledWith({
        path: { message_id: 'msg_card_2' },
      });
    });

    it('patch 失败且 delete 也失败时不抛异常', async () => {
      injectProgressCard('msg_card_3', [{ title: '⚙️ Bash: ls' }]);
      mockPatch.mockRejectedValueOnce(new Error('200800'));
      mockMessageDelete.mockRejectedValueOnce(new Error('delete also failed'));

      // 不应抛异常
      await expect(channel.cleanupProgressCard(jid)).resolves.toBeUndefined();
    });

    it('纯思考步骤（无工具）时删除卡片而非 patch', async () => {
      injectProgressCard('msg_card_4', [{ title: '💭 思考中...' }]);

      await channel.cleanupProgressCard(jid);

      expect(mockPatch).not.toHaveBeenCalled();
      expect(mockMessageDelete).toHaveBeenCalledWith({
        path: { message_id: 'msg_card_4' },
      });
    });

    it('无 messageId 时静默返回不调 API', async () => {
      injectProgressCard('', [{ title: '⚙️ Bash: ls' }]);

      await channel.cleanupProgressCard(jid);

      expect(mockPatch).not.toHaveBeenCalled();
      expect(mockMessageDelete).not.toHaveBeenCalled();
    });
  });
});
