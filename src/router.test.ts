import { describe, it, expect, vi } from 'vitest';

import {
  escapeXml,
  formatMessages,
  stripInternalTags,
  formatOutbound,
  routeOutbound,
  findChannel,
} from './router.js';
import type { Channel, NewMessage } from './types.js';

// ---- escapeXml ----

describe('escapeXml', () => {
  it('转义 & < > " 四种字符', () => {
    expect(escapeXml('a & b < c > d "e"')).toBe(
      'a &amp; b &lt; c &gt; d &quot;e&quot;',
    );
  });

  it('空字符串 → 空字符串', () => {
    expect(escapeXml('')).toBe('');
  });

  it('falsy guard（空值）→ 空字符串', () => {
    expect(escapeXml(undefined as unknown as string)).toBe('');
    expect(escapeXml(null as unknown as string)).toBe('');
  });

  it('无需转义的文本 → 原样返回', () => {
    expect(escapeXml('hello world 你好')).toBe('hello world 你好');
  });

  it('连续特殊字符', () => {
    expect(escapeXml('<<>>')).toBe('&lt;&lt;&gt;&gt;');
  });
});

// ---- formatMessages ----

describe('formatMessages', () => {
  const makeMsg = (overrides: Partial<NewMessage> = {}): NewMessage => ({
    id: 'msg-1',
    chat_jid: 'test@g.us',
    sender: 'user-1',
    sender_name: 'Alice',
    content: 'hello',
    timestamp: '2026-01-01T12:00:00.000Z',
    ...overrides,
  });

  it('单条消息格式正确', () => {
    const result = formatMessages([makeMsg()], 'Asia/Shanghai');
    expect(result).toContain('<message sender="Alice"');
    expect(result).toContain('hello');
    expect(result).toContain('<context timezone="Asia/Shanghai" />');
  });

  it('多条消息换行拼接', () => {
    const msgs = [
      makeMsg({ content: 'first' }),
      makeMsg({ id: 'msg-2', content: 'second' }),
    ];
    const result = formatMessages(msgs, 'UTC');
    expect(result).toContain('first');
    expect(result).toContain('second');
    expect(result.split('<message ').length).toBe(3); // header + 2 messages
  });

  it('带 reply_to 属性', () => {
    const msg = makeMsg({
      reply_to_message_id: 'orig-1',
      reply_to_message_content: '原始消息',
      reply_to_sender_name: 'Bob',
    });
    const result = formatMessages([msg], 'UTC');
    expect(result).toContain('reply_to="orig-1"');
    expect(result).toContain('<quoted_message from="Bob">');
    expect(result).toContain('原始消息');
  });

  it('content 中的 XML 特殊字符被转义', () => {
    const msg = makeMsg({ content: '<script>alert("xss")</script>' });
    const result = formatMessages([msg], 'UTC');
    expect(result).toContain('&lt;script&gt;');
    expect(result).not.toContain('<script>');
  });

  it('空消息数组 → 只有 header 和 messages 标签', () => {
    const result = formatMessages([], 'UTC');
    expect(result).toContain('<context timezone="UTC" />');
    expect(result).toContain('<messages>');
  });
});

// ---- stripInternalTags ----

describe('stripInternalTags', () => {
  it('移除 <internal>...</internal> 标签', () => {
    expect(stripInternalTags('前<internal>内部</internal>后')).toBe('前后');
  });

  it('多个 internal 标签全部移除', () => {
    expect(
      stripInternalTags('<internal>a</internal>中<internal>b</internal>'),
    ).toBe('中');
  });

  it('跨行 internal 标签', () => {
    expect(stripInternalTags('<internal>\n多行\n内容\n</internal>剩余')).toBe(
      '剩余',
    );
  });

  it('无标签 → 原样返回（trim）', () => {
    expect(stripInternalTags('hello world')).toBe('hello world');
  });
});

// ---- formatOutbound ----

describe('formatOutbound', () => {
  it('移除 internal 标签后返回', () => {
    expect(formatOutbound('<internal>隐藏</internal>可见')).toBe('可见');
  });

  it('全是 internal → 返回空字符串', () => {
    expect(formatOutbound('<internal>全部隐藏</internal>')).toBe('');
  });

  it('普通文本原样返回', () => {
    expect(formatOutbound('hello')).toBe('hello');
  });
});

// ---- routeOutbound ----

describe('routeOutbound', () => {
  const mockChannel = (jidPrefix: string, connected = true): Channel => ({
    name: `ch-${jidPrefix}`,
    connect: vi.fn(),
    sendMessage: vi.fn().mockResolvedValue(undefined),
    isConnected: () => connected,
    ownsJid: (jid: string) => jid.startsWith(jidPrefix),
    disconnect: vi.fn(),
  });

  it('匹配到 channel → 调用 sendMessage', async () => {
    const ch = mockChannel('fs:');
    await routeOutbound([ch], 'fs:oc_123', 'hello');
    expect(ch.sendMessage).toHaveBeenCalledWith('fs:oc_123', 'hello');
  });

  it('无匹配 channel → 抛出 Error', () => {
    const ch = mockChannel('wa:', true);
    expect(() => routeOutbound([ch], 'fs:oc_123', 'hello')).toThrow(
      'No channel for JID',
    );
  });

  it('channel 未连接 → 跳过', () => {
    const ch = mockChannel('fs:', false);
    expect(() => routeOutbound([ch], 'fs:oc_123', 'hello')).toThrow(
      'No channel for JID',
    );
  });
});

// ---- findChannel ----

describe('findChannel', () => {
  const mockChannel = (jidPrefix: string): Channel => ({
    name: `ch-${jidPrefix}`,
    connect: vi.fn(),
    sendMessage: vi.fn(),
    isConnected: () => true,
    ownsJid: (jid: string) => jid.startsWith(jidPrefix),
    disconnect: vi.fn(),
  });

  it('匹配 → 返回 channel', () => {
    const ch = mockChannel('fs:');
    expect(findChannel([ch], 'fs:oc_123')).toBe(ch);
  });

  it('无匹配 → 返回 undefined', () => {
    const ch = mockChannel('wa:');
    expect(findChannel([ch], 'fs:oc_123')).toBeUndefined();
  });
});
