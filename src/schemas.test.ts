import { describe, expect, it } from 'vitest';
import { ZodError } from 'zod';

import {
  AllowedRootSchema,
  ChatAllowlistEntrySchema,
  ContainerConfigSchema,
  ContainerOutputSchema,
  IpcMessageSchema,
  MountAllowlistSchema,
  RemoteControlSessionSchema,
  SenderAllowlistConfigSchema,
  WorktreeLockSchema,
} from './schemas.js';

describe('MountAllowlistSchema', () => {
  it('accepts valid allowlist', () => {
    const result = MountAllowlistSchema.parse({
      allowedRoots: [
        { path: '~/projects', allowReadWrite: true, description: 'Dev' },
      ],
      blockedPatterns: ['.ssh'],
      nonMainReadOnly: true,
    });
    expect(result.allowedRoots).toHaveLength(1);
    expect(result.nonMainReadOnly).toBe(true);
  });

  it('rejects missing allowedRoots', () => {
    expect(() =>
      MountAllowlistSchema.parse({
        blockedPatterns: [],
        nonMainReadOnly: true,
      }),
    ).toThrow(ZodError);
  });

  it('rejects non-boolean nonMainReadOnly', () => {
    expect(() =>
      MountAllowlistSchema.parse({
        allowedRoots: [],
        blockedPatterns: [],
        nonMainReadOnly: 'yes',
      }),
    ).toThrow(ZodError);
  });

  it('rejects allowedRoot with non-boolean allowReadWrite', () => {
    expect(() =>
      AllowedRootSchema.parse({ path: '/tmp', allowReadWrite: 'yes' }),
    ).toThrow(ZodError);
  });

  it('accepts allowedRoot without description', () => {
    const result = AllowedRootSchema.parse({
      path: '/tmp',
      allowReadWrite: false,
    });
    expect(result.description).toBeUndefined();
  });
});

describe('SenderAllowlistConfigSchema', () => {
  it('accepts valid config with defaults', () => {
    const result = SenderAllowlistConfigSchema.parse({
      default: { allow: '*', mode: 'trigger' },
    });
    expect(result.chats).toEqual({});
    expect(result.logDenied).toBe(true);
    expect(result.autoTriggerSenders).toEqual([]);
  });

  it('accepts config with array allow', () => {
    const result = SenderAllowlistConfigSchema.parse({
      default: { allow: ['alice', 'bob'], mode: 'drop' },
    });
    expect(result.default.allow).toEqual(['alice', 'bob']);
    expect(result.default.mode).toBe('drop');
  });

  it('rejects invalid mode', () => {
    expect(() =>
      ChatAllowlistEntrySchema.parse({ allow: '*', mode: 'invalid' }),
    ).toThrow(ZodError);
  });

  it('rejects non-string array items in allow', () => {
    expect(() =>
      ChatAllowlistEntrySchema.parse({ allow: [123], mode: 'trigger' }),
    ).toThrow(ZodError);
  });
});

describe('ContainerConfigSchema', () => {
  it('accepts empty config', () => {
    const result = ContainerConfigSchema.parse({});
    expect(result.additionalMounts).toBeUndefined();
    expect(result.timeout).toBeUndefined();
  });

  it('accepts config with mounts and timeout', () => {
    const result = ContainerConfigSchema.parse({
      additionalMounts: [{ hostPath: '/data', readonly: true }],
      timeout: 60000,
    });
    expect(result.additionalMounts).toHaveLength(1);
    expect(result.timeout).toBe(60000);
  });

  it('rejects non-number timeout', () => {
    expect(() => ContainerConfigSchema.parse({ timeout: 'fast' })).toThrow(
      ZodError,
    );
  });
});

describe('ContainerOutputSchema', () => {
  it('accepts success output', () => {
    const result = ContainerOutputSchema.parse({
      status: 'success',
      result: 'done',
    });
    expect(result.status).toBe('success');
  });

  it('accepts error output with null result', () => {
    const result = ContainerOutputSchema.parse({
      status: 'error',
      result: null,
      error: 'timeout',
    });
    expect(result.error).toBe('timeout');
  });

  it('rejects invalid status', () => {
    expect(() =>
      ContainerOutputSchema.parse({ status: 'pending', result: null }),
    ).toThrow(ZodError);
  });
});

describe('WorktreeLockSchema', () => {
  it('accepts valid lock', () => {
    const result = WorktreeLockSchema.parse({
      case_id: 'c1',
      case_name: 'fix-bug',
      started_at: '2026-01-01T00:00:00Z',
      heartbeat: '2026-01-01T00:01:00Z',
      pid: 12345,
    });
    expect(result.pid).toBe(12345);
  });

  it('rejects missing fields', () => {
    expect(() => WorktreeLockSchema.parse({ case_id: 'c1' })).toThrow(ZodError);
  });

  it('rejects non-number pid', () => {
    expect(() =>
      WorktreeLockSchema.parse({
        case_id: 'c1',
        case_name: 'test',
        started_at: 'now',
        heartbeat: 'now',
        pid: 'not-a-number',
      }),
    ).toThrow(ZodError);
  });
});

describe('RemoteControlSessionSchema', () => {
  it('accepts valid session', () => {
    const result = RemoteControlSessionSchema.parse({
      pid: 1234,
      url: 'https://claude.ai/code/abc123',
      startedBy: 'aviad',
      startedInChat: 'tg:123',
      startedAt: '2026-01-01T00:00:00Z',
    });
    expect(result.url).toContain('claude.ai');
  });

  it('rejects missing url', () => {
    expect(() =>
      RemoteControlSessionSchema.parse({
        pid: 1234,
        startedBy: 'aviad',
        startedInChat: 'tg:123',
        startedAt: '2026-01-01T00:00:00Z',
      }),
    ).toThrow(ZodError);
  });
});

describe('IpcMessageSchema', () => {
  it('accepts text message', () => {
    const result = IpcMessageSchema.parse({
      type: 'message',
      chatJid: 'tg:123',
      text: 'hello',
    });
    expect(result.type).toBe('message');
  });

  it('accepts image message', () => {
    const result = IpcMessageSchema.parse({
      type: 'image',
      chatJid: 'tg:123',
      imagePath: '/tmp/img.png',
    });
    expect(result.type).toBe('image');
  });

  it('accepts document message', () => {
    const result = IpcMessageSchema.parse({
      type: 'document',
      chatJid: 'tg:123',
      documentPath: '/tmp/doc.pdf',
      filename: 'report.pdf',
    });
    expect(result.type).toBe('document');
  });

  it('rejects unknown type', () => {
    expect(() =>
      IpcMessageSchema.parse({
        type: 'video',
        chatJid: 'tg:123',
      }),
    ).toThrow(ZodError);
  });

  it('rejects message without text', () => {
    expect(() =>
      IpcMessageSchema.parse({
        type: 'message',
        chatJid: 'tg:123',
      }),
    ).toThrow(ZodError);
  });

  it('accepts message with signals', () => {
    const result = IpcMessageSchema.parse({
      type: 'message',
      chatJid: 'tg:123',
      text: 'hello',
      signals: { urgent: true },
    });
    if (result.type === 'message') {
      expect(result.signals).toEqual({ urgent: true });
    }
  });
});
