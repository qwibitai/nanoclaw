import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleCookieMessage, CookieHandlerDeps } from './cookie-handler.js';
import type { NewMessage } from './types.js';

describe('handleCookieMessage', () => {
  // INVARIANT: handleCookieMessage detects cookie JSON for known domains
  // in incoming messages, converts to Playwright storageState format,
  // saves to the right path, and confirms to the user.

  let deps: CookieHandlerDeps;
  let written: { path: string; content: string }[];
  let sentMessages: { jid: string; text: string }[];

  beforeEach(() => {
    written = [];
    sentMessages = [];
    deps = {
      writeFile: vi.fn((p, c) => written.push({ path: p, content: c })),
      findInsuranceMountPath: vi.fn().mockReturnValue(null),
      sendMessage: vi.fn(async (jid, text) => {
        sentMessages.push({ jid, text });
      }),
    };
  });

  function makeMsg(
    content: string,
    overrides: Partial<NewMessage> = {},
  ): NewMessage {
    return {
      id: 'msg-1',
      chat_jid: 'group@test',
      sender: 'user@test',
      sender_name: 'Test User',
      content,
      timestamp: '2026-03-21T12:00:00Z',
      is_from_me: false,
      is_bot_message: false,
      ...overrides,
    };
  }

  const validCookieJson = JSON.stringify([
    {
      name: 'connect.roeto',
      value: 'abc123session',
      domain: 'app.roeto.co.il',
      path: '/',
      expirationDate: 1800000000,
      httpOnly: true,
      secure: true,
      sameSite: 'Lax',
    },
  ]);

  it('ignores messages from self', () => {
    const msg = makeMsg(validCookieJson, { is_from_me: true });
    const result = handleCookieMessage(deps, 'group@test', msg);
    expect(result).toBe(false);
    expect(deps.writeFile).not.toHaveBeenCalled();
  });

  it('ignores bot messages', () => {
    const msg = makeMsg(validCookieJson, { is_bot_message: true });
    const result = handleCookieMessage(deps, 'group@test', msg);
    expect(result).toBe(false);
    expect(deps.writeFile).not.toHaveBeenCalled();
  });

  it('ignores messages without roeto domain markers', () => {
    const msg = makeMsg('some random text');
    const result = handleCookieMessage(deps, 'group@test', msg);
    expect(result).toBe(false);
  });

  it('ignores messages that look like roeto but are not valid JSON', () => {
    const msg = makeMsg('app.roeto.co.il connect.roeto not json');
    const result = handleCookieMessage(deps, 'group@test', msg);
    expect(result).toBe(false);
  });

  it('ignores valid JSON without matching cookie name/domain', () => {
    const cookies = JSON.stringify([
      {
        name: 'other-cookie',
        value: 'abc',
        domain: 'app.roeto.co.il',
      },
    ]);
    // Need connect.roeto in the text for the quick check
    const msg = makeMsg(cookies + ' connect.roeto');
    const result = handleCookieMessage(deps, 'group@test', msg);
    expect(result).toBe(false);
  });

  it('ignores when no insurance mount path is configured', () => {
    (deps.findInsuranceMountPath as ReturnType<typeof vi.fn>).mockReturnValue(
      null,
    );
    const msg = makeMsg(validCookieJson);
    const result = handleCookieMessage(deps, 'group@test', msg);
    expect(result).toBe(false);
    expect(deps.writeFile).not.toHaveBeenCalled();
  });

  it('saves cookie in Playwright storageState format when everything matches', () => {
    (deps.findInsuranceMountPath as ReturnType<typeof vi.fn>).mockReturnValue(
      '/home/user/garsson-insurance',
    );
    const msg = makeMsg(validCookieJson);
    const result = handleCookieMessage(deps, 'group@test', msg);

    expect(result).toBe(true);
    expect(written).toHaveLength(1);
    expect(written[0].path).toBe(
      '/home/user/garsson-insurance/tools/.roeto-session.json',
    );

    const saved = JSON.parse(written[0].content);
    expect(saved.cookies).toHaveLength(1);
    expect(saved.cookies[0].name).toBe('connect.roeto');
    expect(saved.cookies[0].value).toBe('abc123session');
    expect(saved.cookies[0].domain).toBe('app.roeto.co.il');
    expect(saved.origins).toEqual([]);
  });

  it('sends confirmation messages to the user', async () => {
    (deps.findInsuranceMountPath as ReturnType<typeof vi.fn>).mockReturnValue(
      '/home/user/garsson-insurance',
    );
    const msg = makeMsg(validCookieJson);
    handleCookieMessage(deps, 'group@test', msg);

    // Should have sent confirmation
    expect(deps.sendMessage).toHaveBeenCalled();
  });

  it('handles single cookie object (not array)', () => {
    const singleCookie = JSON.stringify({
      name: 'connect.roeto',
      value: 'single-value',
      domain: 'app.roeto.co.il',
      path: '/app',
    });
    (deps.findInsuranceMountPath as ReturnType<typeof vi.fn>).mockReturnValue(
      '/mnt/insurance',
    );
    const msg = makeMsg(singleCookie);
    const result = handleCookieMessage(deps, 'group@test', msg);

    expect(result).toBe(true);
    const saved = JSON.parse(written[0].content);
    expect(saved.cookies[0].value).toBe('single-value');
    expect(saved.cookies[0].path).toBe('/app');
  });

  it('uses default values for optional cookie fields', () => {
    const minimalCookie = JSON.stringify([
      {
        name: 'connect.roeto',
        value: 'minimal',
        domain: 'app.roeto.co.il',
      },
    ]);
    (deps.findInsuranceMountPath as ReturnType<typeof vi.fn>).mockReturnValue(
      '/mnt/ins',
    );
    const msg = makeMsg(minimalCookie);
    handleCookieMessage(deps, 'group@test', msg);

    const saved = JSON.parse(written[0].content);
    expect(saved.cookies[0].path).toBe('/');
    expect(saved.cookies[0].expires).toBe(-1);
    expect(saved.cookies[0].httpOnly).toBe(true);
    expect(saved.cookies[0].secure).toBe(true);
    expect(saved.cookies[0].sameSite).toBe('Lax');
  });
});
