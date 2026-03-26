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
        connectBtn:         ':is(button, a)[aria-label*="connect" i]',
        addNoteBtn:         'button[aria-label="Add a note"]',
        noteTextarea:       'textarea[name="message"]',
        sendNowBtn:         'button[aria-label="Send invitation"]',
        sendWithoutNoteBtn: 'button[aria-label="Send without a note"]',
        profileName:        'h1',
        messageBtn:         'button[aria-label*="Message"]',
      },
      delays: { afterClick: 0, afterType: 0, afterPageLoad: 0, minMs: 0, maxMs: 0 },
      timeouts: { elementWait: 0, secondaryWait: 0 },
      limits: { maxConnectionsPerDay: 25 },
    },
  };
});

vi.mock('../lib/notion.js', () => {
  state.updateLeadStatusMock = vi.fn().mockResolvedValue(undefined);
  return { updateLeadStatus: state.updateLeadStatusMock };
});

import '../scripts/send-connection.js';

// ── Helpers ────────────────────────────────────────────────────────────────

/**
 * Build a mock Playwright page. `visibleBySelector` maps exact selector strings
 * (including any `:visible` suffix) to boolean visibility.
 *
 * Unrecognised selectors default to isVisible=false so hidden-duplicate tests
 * behave correctly: the non-`:visible` key is absent → false, while the
 * `:visible` key is present → true.
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
        evaluate: vi.fn().mockResolvedValue('button'),
        getAttribute: vi.fn().mockResolvedValue(null),
        elementHandle: vi.fn().mockResolvedValue(null),
        first: vi.fn(),
      };
      inner.first.mockReturnValue(inner);
      return inner;
    }),
    fill: vi.fn().mockResolvedValue(undefined),
    waitForTimeout: vi.fn().mockResolvedValue(undefined),
    waitForURL: vi.fn().mockRejectedValue(new Error('timeout')),
    url: vi.fn().mockReturnValue('https://www.linkedin.com/in/testuser/'),
    goto: vi.fn().mockResolvedValue(undefined),
    evaluate: vi.fn().mockResolvedValue([]),
    keyboard: { type: vi.fn().mockResolvedValue(undefined) },
    get clickedSelectors() { return clickedSelectors; },
  };
}

function makeMockContext() {
  return { close: vi.fn().mockResolvedValue(undefined) };
}

async function runConnect(input: { profileUrl?: string; note?: string }) {
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

  // Default context — close spy only
  state.getBrowserContextMock!.mockResolvedValue(makeMockContext());
});

// ── Callback registration ──────────────────────────────────────────────────

describe('runScript registration', () => {
  it('registers a callback at import time', () => {
    expect(state.runScriptCb).toBeDefined();
    expect(typeof state.runScriptCb).toBe('function');
  });
});

// ── Input validation ───────────────────────────────────────────────────────

describe('input validation', () => {
  it('returns success:false immediately when profileUrl is missing', async () => {
    const result = await runConnect({});
    expect(result.success).toBe(false);
    expect(result.message).toMatch(/profileUrl is required/i);
    expect(state.getBrowserContextMock).not.toHaveBeenCalled();
  });

  it('returns success:false when daily connection limit is reached', async () => {
    state.checkLimitMock!.mockReturnValue(false);
    const result = await runConnect({ profileUrl: PROFILE_URL });
    expect(result.success).toBe(false);
    expect(result.message).toMatch(/daily connection limit/i);
    expect(state.getBrowserContextMock).not.toHaveBeenCalled();
  });

  it('returns success:false when navigateToProfile fails', async () => {
    state.navigateToProfileMock!.mockResolvedValue({ success: false, error: 'timeout' });
    const result = await runConnect({ profileUrl: PROFILE_URL });
    expect(result.success).toBe(false);
    expect(result.message).toMatch(/timeout/i);
  });
});

// ── :visible selector prevents silent hidden-button false-negative ─────────
//
// Regression: LinkedIn renders hidden DOM duplicates of action buttons.
// Without `:visible` in the selector, `.first()` picks a hidden element,
// `isVisible()` returns false, and the script silently reports "not found"
// instead of clicking the real visible button.

describe(':visible selector prevents hidden-button false-negative', () => {
  it('proceeds when connectBtn:visible is visible even though the bare (hidden) selector is not', async () => {
    // Simulates LinkedIn hidden-duplicate DOM:
    //   ':is(button, a)[aria-label*="connect" i]'        → isVisible=false (hidden duplicate)
    //   ':is(button, a)[aria-label*="connect" i]:visible' → isVisible=true  (real button)
    const page = makeMockPage({
      ':is(button, a)[aria-label*="connect" i]:visible': true,
      'button[aria-label="Send without a note"]': true,
    });
    state.navigateToProfileMock!.mockResolvedValue({ page, success: true });

    const result = await runConnect({ profileUrl: PROFILE_URL });

    expect(result.success).toBe(true);
    // The `:visible` version was clicked
    expect(page.clickedSelectors).toContain(':is(button, a)[aria-label*="connect" i]:visible');
  });

  it('returns failure when connectBtn:visible is not visible and more-actions also absent', async () => {
    // Both the :visible connect button and the more-actions fallback are absent.
    // This verifies the script does NOT silently proceed with a hidden button.
    const page = makeMockPage({
      // ':is(button, a)[aria-label*="connect" i]:visible' is absent → defaults to false
      'button:visible[aria-label*="More actions"]': false,
    });
    state.navigateToProfileMock!.mockResolvedValue({ page, success: true });

    const result = await runConnect({ profileUrl: PROFILE_URL });

    expect(result.success).toBe(false);
    expect(result.message).toMatch(/connect button not found/i);
    // No send-button click should ever happen
    expect(page.clickedSelectors).not.toContain('button[aria-label="Send invitation"]');
    expect(page.clickedSelectors).not.toContain('button[aria-label="Send without a note"]');
  });
});

// ── Connect modal — no-note path ───────────────────────────────────────────
//
// Regression (ISSUE-003): The no-note `else` branch previously fell back to
// `sendNowBtn` ("Send invitation") if `sendWithoutNoteBtn` wasn't visible.
// "Send invitation" only exists AFTER clicking "Add a note" — it is never
// present in the no-note path, so this caused a timeout/hang.

describe('connect modal — no-note path', () => {
  it('clicks sendWithoutNoteBtn and never touches sendNowBtn when note is absent', async () => {
    const page = makeMockPage({
      ':is(button, a)[aria-label*="connect" i]:visible': true,
      'button[aria-label="Send without a note"]': true,
    });
    state.navigateToProfileMock!.mockResolvedValue({ page, success: true });

    const result = await runConnect({ profileUrl: PROFILE_URL });

    expect(result.success).toBe(true);
    expect(page.clickedSelectors).toContain('button[aria-label="Send without a note"]');
    // Regression guard: "Send invitation" must NOT be called in the no-note path
    expect(page.clickedSelectors).not.toContain('button[aria-label="Send invitation"]');
  });

  it('treats empty-string note as no-note — clicks sendWithoutNoteBtn only', async () => {
    const page = makeMockPage({
      ':is(button, a)[aria-label*="connect" i]:visible': true,
      'button[aria-label="Send without a note"]': true,
    });
    state.navigateToProfileMock!.mockResolvedValue({ page, success: true });

    const result = await runConnect({ profileUrl: PROFILE_URL, note: '   ' });

    expect(result.success).toBe(true);
    expect(page.clickedSelectors).toContain('button[aria-label="Send without a note"]');
    expect(page.clickedSelectors).not.toContain('button[aria-label="Send invitation"]');
  });
});

// ── Connect modal — note path ──────────────────────────────────────────────
//
// LinkedIn's connect modal changed: "Send invitation" only appears AFTER
// clicking "Add a note". The correct flow is: connectBtn → addNoteBtn →
// fill textarea → sendNowBtn ("Send invitation").

describe('connect modal — note path', () => {
  it('clicks addNoteBtn → fills textarea → clicks sendNowBtn when note provided', async () => {
    const page = makeMockPage({
      ':is(button, a)[aria-label*="connect" i]:visible': true,
      'button[aria-label="Add a note"]': true,
      'button[aria-label="Send invitation"]': true,
    });
    state.navigateToProfileMock!.mockResolvedValue({ page, success: true });

    const result = await runConnect({ profileUrl: PROFILE_URL, note: 'Loved your recent post!' });

    expect(result.success).toBe(true);
    // "Add a note" must be clicked before filling the textarea
    expect(page.clickedSelectors).toContain('button[aria-label="Add a note"]');
    expect(page.fill).toHaveBeenCalledWith('textarea[name="message"]', expect.stringContaining('Loved your recent post!'));
    // "Send invitation" is the correct post-note send button
    expect(page.clickedSelectors).toContain('button[aria-label="Send invitation"]');
    // sendWithoutNoteBtn must NOT be clicked when a note is added successfully
    expect(page.clickedSelectors).not.toContain('button[aria-label="Send without a note"]');
  });

  it('truncates note to 300 characters before filling', async () => {
    const longNote = 'x'.repeat(400);
    const page = makeMockPage({
      ':is(button, a)[aria-label*="connect" i]:visible': true,
      'button[aria-label="Add a note"]': true,
      'button[aria-label="Send invitation"]': true,
    });
    state.navigateToProfileMock!.mockResolvedValue({ page, success: true });

    await runConnect({ profileUrl: PROFILE_URL, note: longNote });

    const fillArg = (page.fill as ReturnType<typeof vi.fn>).mock.calls[0][1] as string;
    expect(fillArg.length).toBeLessThanOrEqual(300);
  });

  it('falls back to sendWithoutNoteBtn when addNoteBtn is not available', async () => {
    // Some LinkedIn accounts/profiles don't show "Add a note" (e.g. premium restriction)
    const page = makeMockPage({
      ':is(button, a)[aria-label*="connect" i]:visible': true,
      // 'button[aria-label="Add a note"]' is absent → defaults to false
      'button[aria-label="Send without a note"]': true,
    });
    state.navigateToProfileMock!.mockResolvedValue({ page, success: true });

    const result = await runConnect({ profileUrl: PROFILE_URL, note: 'Hi!' });

    expect(result.success).toBe(true);
    expect(page.clickedSelectors).toContain('button[aria-label="Send without a note"]');
    // "Send invitation" must NOT be called — it requires "Add a note" to be clicked first
    expect(page.clickedSelectors).not.toContain('button[aria-label="Send invitation"]');
  });
});

// ── <a> href custom-invite path (SVG overlay workaround) ────────────────
//
// LinkedIn A/B: some profiles render Connect as <a href="/preload/custom-invite/...">
// with an SVG overlay div blocking Playwright pointer clicks. The script detects
// <a> tags, extracts the href, and navigates directly via page.goto().

describe('<a> href custom-invite path', () => {
  /** Build a page where the connect button is an <a> with a custom-invite href. */
  function makeMockPageWithAnchor(visibleBySelector: Record<string, boolean> = {}) {
    const clickedSelectors: string[] = [];
    return {
      locator: vi.fn().mockImplementation((sel: string) => {
        const visible = visibleBySelector[sel] ?? false;
        const inner = {
          isVisible: vi.fn().mockResolvedValue(visible),
          click: vi.fn().mockImplementation(async () => { clickedSelectors.push(sel); }),
          waitFor: vi.fn().mockResolvedValue(undefined),
          textContent: vi.fn().mockResolvedValue('Test User'),
          // Return 'a' for tagName and a custom-invite href
          evaluate: vi.fn().mockResolvedValue('a'),
          getAttribute: vi.fn().mockResolvedValue('/preload/custom-invite/?vanityName=testuser'),
          elementHandle: vi.fn().mockResolvedValue(null),
          first: vi.fn(),
        };
        inner.first.mockReturnValue(inner);
        return inner;
      }),
      fill: vi.fn().mockResolvedValue(undefined),
      waitForTimeout: vi.fn().mockResolvedValue(undefined),
      waitForURL: vi.fn().mockRejectedValue(new Error('timeout')),
      url: vi.fn().mockReturnValue('https://www.linkedin.com/in/testuser/'),
      goto: vi.fn().mockResolvedValue(undefined),
      evaluate: vi.fn().mockResolvedValue([]),
      keyboard: { type: vi.fn().mockResolvedValue(undefined) },
      get clickedSelectors() { return clickedSelectors; },
    };
  }

  it('navigates to custom-invite URL and clicks sendWithoutNoteBtn when no note', async () => {
    const page = makeMockPageWithAnchor({
      ':is(button, a)[aria-label*="connect" i]:visible': true,
      'button[aria-label="Send without a note"]': true,
    });
    state.navigateToProfileMock!.mockResolvedValue({ page, success: true });

    const result = await runConnect({ profileUrl: PROFILE_URL });

    expect(result.success).toBe(true);
    expect(page.goto).toHaveBeenCalledWith(
      expect.stringContaining('/preload/custom-invite/'),
      expect.any(Object),
    );
    expect(page.clickedSelectors).toContain('button[aria-label="Send without a note"]');
    // The connect button itself should NOT be clicked (SVG overlay bypass)
    expect(page.clickedSelectors).not.toContain(':is(button, a)[aria-label*="connect" i]:visible');
  });

  it('navigates to custom-invite URL and fills note when textarea is available', async () => {
    const page = makeMockPageWithAnchor({
      ':is(button, a)[aria-label*="connect" i]:visible': true,
      'button[aria-label="Add a note"]': true,
      'textarea[name="message"]': true,
      'button[aria-label="Send invitation"]': true,
    });
    state.navigateToProfileMock!.mockResolvedValue({ page, success: true });

    const result = await runConnect({ profileUrl: PROFILE_URL, note: 'Hello!' });

    expect(result.success).toBe(true);
    expect(page.goto).toHaveBeenCalledWith(
      expect.stringContaining('/preload/custom-invite/'),
      expect.any(Object),
    );
    expect(page.clickedSelectors).toContain('button[aria-label="Add a note"]');
    expect(page.fill).toHaveBeenCalledWith('textarea[name="message"]', 'Hello!');
    expect(page.clickedSelectors).toContain('button[aria-label="Send invitation"]');
  });

  it('falls back to sendWithoutNoteBtn when Premium paywall blocks textarea', async () => {
    // After clicking "Add a note", textarea does NOT appear (Premium paywall).
    // Dismiss button appears instead.
    const page = makeMockPageWithAnchor({
      ':is(button, a)[aria-label*="connect" i]:visible': true,
      'button[aria-label="Add a note"]': true,
      // 'textarea[name="message"]' is absent → defaults to false (Premium paywall)
      'button[aria-label="Dismiss"]': true,
      'button[aria-label="Send without a note"]': true,
    });
    state.navigateToProfileMock!.mockResolvedValue({ page, success: true });

    const result = await runConnect({ profileUrl: PROFILE_URL, note: 'Hello!' });

    expect(result.success).toBe(true);
    // Dismiss was clicked to close the paywall
    expect(page.clickedSelectors).toContain('button[aria-label="Dismiss"]');
    // Re-navigated to custom-invite after dismissing
    expect(page.goto).toHaveBeenCalledTimes(2);
    // Fell back to sending without note
    expect(page.clickedSelectors).toContain('button[aria-label="Send without a note"]');
    // Message should mention Premium
    expect(result.message).toMatch(/premium/i);
  });
});

// ── More-actions menu fallback ─────────────────────────────────────────────

describe('more-actions menu fallback', () => {
  it('succeeds via More menu when direct connect button is absent', async () => {
    const page = makeMockPage({
      // Direct connect button absent
      'button:visible[aria-label*="More actions"]': true,
      'div[aria-label*="connect" i]': true,
      'button[aria-label="Send without a note"]': true,
    });
    state.navigateToProfileMock!.mockResolvedValue({ page, success: true });

    const result = await runConnect({ profileUrl: PROFILE_URL });

    expect(result.success).toBe(true);
    expect(page.clickedSelectors).toContain('button:visible[aria-label*="More actions"]');
    expect(page.clickedSelectors).toContain('div[aria-label*="connect" i]');
  });

  it('returns failure when More menu is open but has no connect option', async () => {
    const page = makeMockPage({
      'button:visible[aria-label*="More actions"]': true,
      // 'div[aria-label*="connect" i]' absent → false
    });
    state.navigateToProfileMock!.mockResolvedValue({ page, success: true });

    const result = await runConnect({ profileUrl: PROFILE_URL });

    expect(result.success).toBe(false);
    expect(result.message).toMatch(/connect button not found/i);
  });
});

// ── Post-send state ────────────────────────────────────────────────────────

describe('post-send state', () => {
  it('calls incrementCount("connections") on success', async () => {
    const page = makeMockPage({
      ':is(button, a)[aria-label*="connect" i]:visible': true,
      'button[aria-label="Send without a note"]': true,
    });
    state.navigateToProfileMock!.mockResolvedValue({ page, success: true });

    await runConnect({ profileUrl: PROFILE_URL });

    expect(state.incrementCountMock).toHaveBeenCalledWith('connections');
  });

  it('calls updateLeadStatus with "Requested" on success', async () => {
    const page = makeMockPage({
      ':is(button, a)[aria-label*="connect" i]:visible': true,
      'button[aria-label="Send without a note"]': true,
    });
    state.navigateToProfileMock!.mockResolvedValue({ page, success: true });

    await runConnect({ profileUrl: PROFILE_URL });

    expect(state.updateLeadStatusMock).toHaveBeenCalledWith(PROFILE_URL, 'Requested');
  });
});

// ── Browser context cleanup ────────────────────────────────────────────────

describe('browser context cleanup', () => {
  it('closes context even when navigateToProfile fails', async () => {
    const ctx = makeMockContext();
    state.getBrowserContextMock!.mockResolvedValue(ctx);
    state.navigateToProfileMock!.mockResolvedValue({ success: false, error: 'timeout' });

    await runConnect({ profileUrl: PROFILE_URL });

    expect(ctx.close).toHaveBeenCalledOnce();
  });

  it('closes context after successful send', async () => {
    const ctx = makeMockContext();
    state.getBrowserContextMock!.mockResolvedValue(ctx);
    const page = makeMockPage({
      ':is(button, a)[aria-label*="connect" i]:visible': true,
      'button[aria-label="Send without a note"]': true,
    });
    state.navigateToProfileMock!.mockResolvedValue({ page, success: true });

    await runConnect({ profileUrl: PROFILE_URL });

    expect(ctx.close).toHaveBeenCalledOnce();
  });
});
