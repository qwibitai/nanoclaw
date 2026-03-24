import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Hoist: capture runScript callback and mock refs ───────────────────────

const state = vi.hoisted(() => ({
  runScriptCb: undefined as ((input: unknown) => Promise<unknown>) | undefined,
  getBrowserContextMock: undefined as ReturnType<typeof vi.fn> | undefined,
  navigateToProfileMock: undefined as ReturnType<typeof vi.fn> | undefined,
  checkLimitMock:        undefined as ReturnType<typeof vi.fn> | undefined,
  incrementCountMock:    undefined as ReturnType<typeof vi.fn> | undefined,
  randomDelayMock:       undefined as ReturnType<typeof vi.fn> | undefined,
  updateLeadStatusMock:  undefined as ReturnType<typeof vi.fn> | undefined,
  loadDailyCountsMock:   undefined as ReturnType<typeof vi.fn> | undefined,
}));

vi.mock('../lib/browser.js', () => {
  state.getBrowserContextMock  = vi.fn();
  state.navigateToProfileMock  = vi.fn();
  state.checkLimitMock         = vi.fn().mockReturnValue(true);
  state.incrementCountMock     = vi.fn();
  state.randomDelayMock        = vi.fn().mockResolvedValue(undefined);
  state.loadDailyCountsMock    = vi.fn().mockReturnValue({
    connections: 0, messages: 0, profileViews: 0, likes: 0, comments: 0, follows: 0,
  });

  return {
    runScript: (cb: (input: unknown) => Promise<unknown>) => { state.runScriptCb = cb; },
    getBrowserContext:  state.getBrowserContextMock,
    navigateToProfile: state.navigateToProfileMock,
    incrementCount:    state.incrementCountMock,
    checkLimit:        state.checkLimitMock,
    loadDailyCounts:   state.loadDailyCountsMock,
    randomDelay:       state.randomDelayMock,
    humanType:         vi.fn(),
    config: {
      selectors: {
        messageBtn:  'button[aria-label*="Message"]',
        msgCompose:  'div.msg-form__contenteditable',
        msgSendBtn:  'button.msg-form__send-button',
        profileName: 'h1',
        connectBtn:  'button[aria-label*="connect" i]',
      },
      delays: { afterClick: 0, afterType: 0, minMs: 0, maxMs: 0 },
      timeouts: { elementWait: 0 },
      limits: { maxMessagesPerDay: 40 },
    },
  };
});

vi.mock('../lib/notion.js', () => {
  state.updateLeadStatusMock = vi.fn().mockResolvedValue(undefined);
  return { updateLeadStatus: state.updateLeadStatusMock };
});

import '../scripts/send-message.js';

// ── Helpers ────────────────────────────────────────────────────────────────

/**
 * Build a mock Playwright page. `visibleBySelector` maps exact selector strings
 * (including any `:visible` suffix) to boolean visibility.
 *
 * Unlisted selectors default to isVisible=false — critical for the :visible
 * regression tests where the bare selector (no `:visible`) should return false
 * while the `:visible`-suffixed key returns true.
 */
function makeMockPage(visibleBySelector: Record<string, boolean> = {}) {
  const clickedSelectors: string[] = [];

  return {
    locator: vi.fn().mockImplementation((sel: string) => {
      const visible = visibleBySelector[sel] ?? false;
      const inner = {
        isVisible: vi.fn().mockResolvedValue(visible),
        click: vi.fn().mockImplementation(async () => { clickedSelectors.push(sel); }),
        waitFor: vi.fn().mockResolvedValue(undefined),
        textContent: vi.fn().mockResolvedValue('Test User'),
        first: vi.fn(),
      };
      inner.first.mockReturnValue(inner);
      return inner;
    }),
    fill: vi.fn().mockResolvedValue(undefined),
    waitForTimeout: vi.fn().mockResolvedValue(undefined),
    keyboard: { type: vi.fn().mockResolvedValue(undefined) },
    get clickedSelectors() { return clickedSelectors; },
  };
}

function makeMockContext() {
  return { close: vi.fn().mockResolvedValue(undefined) };
}

async function runMessage(input: { profileUrl?: string; message?: string }) {
  if (!state.runScriptCb) throw new Error('runScript callback was never captured');
  return state.runScriptCb(input) as Promise<{ success: boolean; message: string }>;
}

const PROFILE_URL = 'https://www.linkedin.com/in/testuser';

// ── Setup ──────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  state.checkLimitMock!.mockReturnValue(true);
  state.randomDelayMock!.mockResolvedValue(undefined);
  state.updateLeadStatusMock!.mockResolvedValue(undefined);
  state.loadDailyCountsMock!.mockReturnValue({
    connections: 0, messages: 0, profileViews: 0, likes: 0, comments: 0, follows: 0,
  });
  state.getBrowserContextMock!.mockResolvedValue(makeMockContext());
});

// ── Callback registration ──────────────────────────────────────────────────

describe('runScript registration', () => {
  it('registers a callback at import time', () => {
    expect(state.runScriptCb).toBeDefined();
  });
});

// ── Input validation ───────────────────────────────────────────────────────

describe('input validation', () => {
  it('returns success:false when profileUrl is missing', async () => {
    const result = await runMessage({ message: 'hi' });
    expect(result.success).toBe(false);
    expect(result.message).toMatch(/profileUrl is required/i);
    expect(state.getBrowserContextMock).not.toHaveBeenCalled();
  });

  it('returns success:false when message is empty', async () => {
    const result = await runMessage({ profileUrl: PROFILE_URL, message: '  ' });
    expect(result.success).toBe(false);
    expect(result.message).toMatch(/message is required/i);
    expect(state.getBrowserContextMock).not.toHaveBeenCalled();
  });

  it('returns success:false when daily message limit is reached', async () => {
    state.checkLimitMock!.mockReturnValue(false);
    const result = await runMessage({ profileUrl: PROFILE_URL, message: 'hello' });
    expect(result.success).toBe(false);
    expect(result.message).toMatch(/daily message limit/i);
    expect(state.getBrowserContextMock).not.toHaveBeenCalled();
  });

  it('returns success:false when navigateToProfile fails', async () => {
    state.navigateToProfileMock!.mockResolvedValue({ success: false, error: 'timeout' });
    const result = await runMessage({ profileUrl: PROFILE_URL, message: 'hello' });
    expect(result.success).toBe(false);
  });
});

// ── :visible selector prevents silent hidden-button false-negative ─────────
//
// Regression: LinkedIn renders hidden DOM duplicates of profile-card buttons.
// Without `:visible` in the locator, `.first()` picks a hidden element,
// `isVisible()` returns false, and the script silently reports "not found"
// instead of clicking the real Message button.

describe(':visible selector prevents hidden-button false-negative', () => {
  it('proceeds when messageBtn:visible is visible even though the bare selector is not', async () => {
    // Simulates LinkedIn hidden-duplicate DOM:
    //   'button[aria-label*="Message"]'         → isVisible=false (hidden duplicate)
    //   'button[aria-label*="Message"]:visible'  → isVisible=true  (real button)
    const page = makeMockPage({
      'button[aria-label*="Message"]:visible': true,
      'div.msg-form__contenteditable': true,
      'button.msg-form__send-button': true,
    });
    state.navigateToProfileMock!.mockResolvedValue({ page, success: true });

    const result = await runMessage({ profileUrl: PROFILE_URL, message: 'hello' });

    expect(result.success).toBe(true);
    // The :visible button was clicked
    expect(page.clickedSelectors).toContain('button[aria-label*="Message"]:visible');
  });

  it('returns failure with clear message when messageBtn:visible is not visible', async () => {
    // No visible Message button — not a 1st-degree connection or wrong profile state
    const page = makeMockPage({
      // 'button[aria-label*="Message"]:visible' is absent → defaults to false
    });
    state.navigateToProfileMock!.mockResolvedValue({ page, success: true });

    const result = await runMessage({ profileUrl: PROFILE_URL, message: 'hello' });

    expect(result.success).toBe(false);
    expect(result.message).toMatch(/message button not found/i);
    // No send-button click should ever happen
    expect(page.clickedSelectors).not.toContain('button.msg-form__send-button');
  });
});

// ── Message flow ───────────────────────────────────────────────────────────

describe('message flow', () => {
  it('types the message character by character and clicks msgSendBtn', async () => {
    const page = makeMockPage({
      'button[aria-label*="Message"]:visible': true,
      'div.msg-form__contenteditable': true,
      'button.msg-form__send-button': true,
    });
    state.navigateToProfileMock!.mockResolvedValue({ page, success: true });

    await runMessage({ profileUrl: PROFILE_URL, message: 'hi there' });

    // keyboard.type should have been called once per character
    expect(page.keyboard.type).toHaveBeenCalledTimes('hi there'.length);
    expect(page.clickedSelectors).toContain('button.msg-form__send-button');
  });

  it('calls incrementCount("messages") on success', async () => {
    const page = makeMockPage({
      'button[aria-label*="Message"]:visible': true,
      'div.msg-form__contenteditable': true,
      'button.msg-form__send-button': true,
    });
    state.navigateToProfileMock!.mockResolvedValue({ page, success: true });

    await runMessage({ profileUrl: PROFILE_URL, message: 'hello' });

    expect(state.incrementCountMock).toHaveBeenCalledWith('messages');
  });

  it('calls updateLeadStatus with "Messaged" and message text on success', async () => {
    const page = makeMockPage({
      'button[aria-label*="Message"]:visible': true,
      'div.msg-form__contenteditable': true,
      'button.msg-form__send-button': true,
    });
    state.navigateToProfileMock!.mockResolvedValue({ page, success: true });

    await runMessage({ profileUrl: PROFILE_URL, message: 'hope you are doing well' });

    expect(state.updateLeadStatusMock).toHaveBeenCalledWith(
      PROFILE_URL,
      'Messaged',
      expect.objectContaining({ messageSent: 'hope you are doing well' }),
    );
  });
});

// ── Browser context cleanup ────────────────────────────────────────────────

describe('browser context cleanup', () => {
  it('closes context even when navigateToProfile fails', async () => {
    const ctx = makeMockContext();
    state.getBrowserContextMock!.mockResolvedValue(ctx);
    state.navigateToProfileMock!.mockResolvedValue({ success: false, error: 'timeout' });

    await runMessage({ profileUrl: PROFILE_URL, message: 'hi' });

    expect(ctx.close).toHaveBeenCalledOnce();
  });

  it('closes context after successful send', async () => {
    const ctx = makeMockContext();
    state.getBrowserContextMock!.mockResolvedValue(ctx);
    const page = makeMockPage({
      'button[aria-label*="Message"]:visible': true,
      'div.msg-form__contenteditable': true,
      'button.msg-form__send-button': true,
    });
    state.navigateToProfileMock!.mockResolvedValue({ page, success: true });

    await runMessage({ profileUrl: PROFILE_URL, message: 'hi' });

    expect(ctx.close).toHaveBeenCalledOnce();
  });
});
