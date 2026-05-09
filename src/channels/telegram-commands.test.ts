/**
 * Pure registry tests for the Telegram command dispatcher.
 *
 * Boundary semantics: '/auth' should match '/auth' and '/auth foo',
 * but NOT '/authy'. Test those cases explicitly because they're
 * exactly the kind of footgun a string-prefix dispatcher invites.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

import {
  _resetCommandsForTest,
  dispatchTelegramCommand,
  registerTelegramCommand,
  type TelegramCommandContext,
} from './telegram-commands.js';

const BASE_CTX: TelegramCommandContext = {
  token: 'BOT_TOKEN_xxx',
  platformId: 'telegram:42',
  text: '',
  authorUserId: '42',
};

beforeEach(() => _resetCommandsForTest());

describe('dispatchTelegramCommand', () => {
  it('returns false when no handler matches', async () => {
    registerTelegramCommand('/foo', vi.fn().mockResolvedValue(true));
    const consumed = await dispatchTelegramCommand({ ...BASE_CTX, text: '/bar' });
    expect(consumed).toBe(false);
  });

  it('routes to a matching handler and returns its consumed value', async () => {
    const handler = vi.fn().mockResolvedValue(true);
    registerTelegramCommand('/auth', handler);
    const consumed = await dispatchTelegramCommand({ ...BASE_CTX, text: '/auth oauth' });
    expect(consumed).toBe(true);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(expect.objectContaining({ text: '/auth oauth' }));
  });

  it('does not match a longer prefix (/auth must not match /authy)', async () => {
    const auth = vi.fn().mockResolvedValue(true);
    registerTelegramCommand('/auth', auth);
    const consumed = await dispatchTelegramCommand({ ...BASE_CTX, text: '/authy something' });
    expect(consumed).toBe(false);
    expect(auth).not.toHaveBeenCalled();
  });

  it('matches when text equals the prefix exactly', async () => {
    const handler = vi.fn().mockResolvedValue(true);
    registerTelegramCommand('/playground', handler);
    const consumed = await dispatchTelegramCommand({ ...BASE_CTX, text: '/playground' });
    expect(consumed).toBe(true);
  });

  it('matches when prefix is followed by whitespace', async () => {
    const handler = vi.fn().mockResolvedValue(true);
    registerTelegramCommand('/model', handler);
    const consumed = await dispatchTelegramCommand({ ...BASE_CTX, text: '/model claude-sonnet-4-6' });
    expect(consumed).toBe(true);
  });

  it('lets a non-consuming handler fall through to the next match', async () => {
    const skipping = vi.fn().mockResolvedValue(false);
    const consuming = vi.fn().mockResolvedValue(true);
    registerTelegramCommand('/auth', skipping);
    registerTelegramCommand('/auth', consuming);
    const consumed = await dispatchTelegramCommand({ ...BASE_CTX, text: '/auth' });
    expect(skipping).toHaveBeenCalledTimes(1);
    expect(consuming).toHaveBeenCalledTimes(1);
    expect(consumed).toBe(true);
  });

  it('runs handlers in registration order', async () => {
    const calls: string[] = [];
    registerTelegramCommand('/auth', async () => {
      calls.push('first');
      return false;
    });
    registerTelegramCommand('/auth', async () => {
      calls.push('second');
      return true;
    });
    await dispatchTelegramCommand({ ...BASE_CTX, text: '/auth' });
    expect(calls).toEqual(['first', 'second']);
  });

  it('passes token, platformId, authorUserId through to the handler', async () => {
    const handler = vi.fn().mockResolvedValue(true);
    registerTelegramCommand('/login', handler);
    const ctx = { ...BASE_CTX, text: '/login', authorUserId: '99', platformId: 'telegram:99' };
    await dispatchTelegramCommand(ctx);
    expect(handler).toHaveBeenCalledWith(ctx);
  });
});

describe('registerTelegramCommand', () => {
  it('rejects a prefix that does not start with /', () => {
    expect(() => registerTelegramCommand('login', vi.fn())).toThrow(/start with/);
  });
});
