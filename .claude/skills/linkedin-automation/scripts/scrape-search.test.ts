import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Hoist: capture the runScript callback before any imports ──────────────

const state = vi.hoisted(() => ({
  runScriptCb: undefined as ((input: unknown) => Promise<unknown>) | undefined,
  getBrowserContextMock: undefined as ReturnType<typeof vi.fn> | undefined,
  checkLimitMock: undefined as ReturnType<typeof vi.fn> | undefined,
  incrementCountMock: undefined as ReturnType<typeof vi.fn> | undefined,
  randomDelayMock: undefined as ReturnType<typeof vi.fn> | undefined,
  upsertLeadMock: undefined as ReturnType<typeof vi.fn> | undefined,
}));

vi.mock('../lib/browser.js', () => {
  state.getBrowserContextMock = vi.fn();
  state.checkLimitMock = vi.fn().mockReturnValue(true);
  state.incrementCountMock = vi.fn();
  state.randomDelayMock = vi.fn().mockResolvedValue(undefined);

  return {
    runScript: (cb: (input: unknown) => Promise<unknown>) => {
      state.runScriptCb = cb;
    },
    getBrowserContext: state.getBrowserContextMock,
    config: {
      urls: { search: 'https://www.linkedin.com/search/results/people/' },
      timeouts: { navigation: 30000 },
      delays: { afterPageLoad: 0 },
      selectors: {
        searchResultsList: '[data-chameleon-result-urn]',
        nextPageBtn: 'button[aria-label="Next"]',
      },
    },
    randomDelay: state.randomDelayMock,
    checkLimit: state.checkLimitMock,
    incrementCount: state.incrementCountMock,
    loadDailyCounts: vi.fn(),
  };
});

vi.mock('../lib/notion.js', () => {
  state.upsertLeadMock = vi.fn().mockResolvedValue(undefined);
  return { upsertLead: state.upsertLeadMock };
});

// Import the script — triggers runScript() registration, sets state.runScriptCb
import '../scripts/scrape-search.js';

// ── Helpers ────────────────────────────────────────────────────────────────

/** A minimal mock Playwright element for a search result card */
function makeResultEl() {
  // All locator calls return this same self-referential object for simplicity
  const el: Record<string, unknown> = {};
  el['getAttribute'] = vi.fn().mockResolvedValue('/in/test-profile');
  el['textContent'] = vi.fn().mockResolvedValue('Test Name');
  el['all'] = vi.fn().mockResolvedValue([]);
  el['isEnabled'] = vi.fn().mockResolvedValue(false);
  el['click'] = vi.fn().mockResolvedValue(undefined);
  // .first() and .locator() both return this same mock (handles arbitrary chaining)
  el['first'] = vi.fn().mockReturnValue(el);
  el['locator'] = vi.fn().mockReturnValue(el);
  return el;
}

/**
 * Build a mock Playwright page where locator(selector).all() returns
 * `selectorHits[selector]` result elements (0 if not listed).
 */
function makeMockPage(selectorHits: Record<string, number> = {}) {
  return {
    goto: vi.fn().mockResolvedValue(undefined),
    waitForTimeout: vi.fn().mockResolvedValue(undefined),
    waitForSelector: vi.fn().mockResolvedValue(null),
    evaluate: vi.fn().mockResolvedValue(undefined),
    locator: vi.fn().mockImplementation((sel: string) => {
      const count = selectorHits[sel] ?? 0;
      const elements = Array.from({ length: count }, makeResultEl);
      const container = {
        all: vi.fn().mockResolvedValue(elements),
        first: vi.fn().mockReturnValue({
          isEnabled: vi.fn().mockResolvedValue(false),
          click: vi.fn().mockResolvedValue(undefined),
        }),
      };
      return container;
    }),
  };
}

function makeMockContext(page: ReturnType<typeof makeMockPage>) {
  return {
    pages: vi.fn().mockReturnValue([page]),
    newPage: vi.fn().mockResolvedValue(page),
    close: vi.fn().mockResolvedValue(undefined),
  };
}

async function runSearch(input: { query: string; maxLeads?: number; campaign?: string; connectionsOnly?: boolean }) {
  if (!state.runScriptCb) throw new Error('runScript callback was never captured');
  return state.runScriptCb(input) as Promise<{
    success: boolean;
    message: string;
    data?: { count: number; leads: string[] };
  }>;
}

// ── Setup ──────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  // Re-apply defaults cleared by clearAllMocks
  state.checkLimitMock!.mockReturnValue(true);
  state.randomDelayMock!.mockResolvedValue(undefined);
  state.upsertLeadMock!.mockResolvedValue(undefined);
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
  it('returns success:false immediately when query is empty', async () => {
    const result = await runSearch({ query: '' });
    expect(result.success).toBe(false);
    expect(result.message).toMatch(/query is required/i);
    expect(state.getBrowserContextMock).not.toHaveBeenCalled();
  });

  it('returns success:false immediately when query is whitespace-only', async () => {
    const result = await runSearch({ query: '   ' });
    expect(result.success).toBe(false);
    expect(state.getBrowserContextMock).not.toHaveBeenCalled();
  });
});

// ── Primary selector works (no fallback needed) ────────────────────────────

describe('primary selector works', () => {
  it('finds results with primary selector and does not probe fallbacks', async () => {
    const page = makeMockPage({
      '[data-chameleon-result-urn]': 2,
    });
    state.getBrowserContextMock!.mockResolvedValue(makeMockContext(page));

    const result = await runSearch({ query: 'software engineer', maxLeads: 2 });

    expect(result.success).toBe(true);
    expect(result.data?.count).toBe(2);

    // Primary found results — waitForSelector should not have been called at all
    const waitCalls = (page.waitForSelector as ReturnType<typeof vi.fn>).mock.calls.map(
      (c: unknown[]) => c[0],
    );
    expect(waitCalls).toHaveLength(0);
  });

  it('calls upsertLead for each found result with source=Search and status=New', async () => {
    const page = makeMockPage({ '[data-chameleon-result-urn]': 3 });
    state.getBrowserContextMock!.mockResolvedValue(makeMockContext(page));

    await runSearch({ query: 'engineer', maxLeads: 3 });

    expect(state.upsertLeadMock).toHaveBeenCalledTimes(3);
    for (const call of (state.upsertLeadMock as ReturnType<typeof vi.fn>).mock.calls) {
      expect(call[0]).toMatchObject({ source: 'Search', status: 'New' });
    }
  });
});

// ── Selector fallback (the 0-results bug) ─────────────────────────────────

describe('selector fallback when primary returns 0 results', () => {
  it('tries RESULT_SELECTORS in order and picks the first that has results', async () => {
    const page = makeMockPage({
      // Primary and first fallback return nothing
      'li.reusable-search__result-container': 0,
      'li[class*="reusable-search"]': 0,
      // Third selector is the one that works
      'div[data-view-name="search-entity-result-item"]': 2,
    });
    state.getBrowserContextMock!.mockResolvedValue(makeMockContext(page));

    const result = await runSearch({ query: 'pm', maxLeads: 2 });

    expect(result.success).toBe(true);
    expect(result.data?.count).toBe(2);
  });

  it('picks li[class*="reusable-search"] (index 1) and stops — skips later selectors', async () => {
    const page = makeMockPage({
      'li.reusable-search__result-container': 0,
      'li[class*="reusable-search"]': 1,
    });
    state.getBrowserContextMock!.mockResolvedValue(makeMockContext(page));

    const result = await runSearch({ query: 'designer', maxLeads: 1 });

    expect(result.success).toBe(true);
    expect(result.data?.count).toBe(1);

    // waitForSelector should NOT have been called with the third or fourth selector
    const waitCalls = (page.waitForSelector as ReturnType<typeof vi.fn>).mock.calls.map(
      (c: unknown[]) => c[0],
    );
    expect(waitCalls).not.toContain('div[data-view-name="search-entity-result-item"]');
    expect(waitCalls).not.toContain('ul.reusable-search__entity-result-list > li');
  });

  it('saves leads to Notion via upsertLead when fallback selector finds results', async () => {
    const page = makeMockPage({
      'li.reusable-search__result-container': 0,
      'li[class*="reusable-search"]': 2,
    });
    state.getBrowserContextMock!.mockResolvedValue(makeMockContext(page));

    await runSearch({ query: 'recruiter', maxLeads: 2, campaign: 'OutreachQ1' });

    expect(state.upsertLeadMock).toHaveBeenCalledTimes(2);
    const firstCall = (state.upsertLeadMock as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(firstCall).toMatchObject({ source: 'Search', status: 'New', campaign: 'OutreachQ1' });
  });
});

// ── All selectors fail ─────────────────────────────────────────────────────

describe('all selectors return 0 results', () => {
  it('returns success:true with count:0 — no crash', async () => {
    // All selectors return 0 elements
    const page = makeMockPage({});
    state.getBrowserContextMock!.mockResolvedValue(makeMockContext(page));

    const result = await runSearch({ query: 'unicorn role', maxLeads: 10 });

    expect(result.success).toBe(true);
    expect(result.data?.count).toBe(0);
    expect(result.data?.leads).toEqual([]);
  });

  it('does not call upsertLead when no results found', async () => {
    const page = makeMockPage({});
    state.getBrowserContextMock!.mockResolvedValue(makeMockContext(page));

    await runSearch({ query: 'nobody' });

    expect(state.upsertLeadMock).not.toHaveBeenCalled();
  });
});

// ── Daily limit respected ──────────────────────────────────────────────────

describe('daily limit enforcement', () => {
  it('stops processing results when checkLimit returns false', async () => {
    const page = makeMockPage({ '[data-chameleon-result-urn]': 5 });
    state.getBrowserContextMock!.mockResolvedValue(makeMockContext(page));

    // Limit reached on first check
    state.checkLimitMock!.mockReturnValue(false);

    const result = await runSearch({ query: 'engineer', maxLeads: 5 });

    expect(result.success).toBe(true);
    expect(state.upsertLeadMock).not.toHaveBeenCalled();
    expect(result.data?.count).toBe(0);
  });

  it('respects maxLeads cap — stops after saving maxLeads results', async () => {
    // Return more elements than maxLeads
    const page = makeMockPage({ '[data-chameleon-result-urn]': 10 });
    state.getBrowserContextMock!.mockResolvedValue(makeMockContext(page));

    await runSearch({ query: 'engineer', maxLeads: 3 });

    expect(state.upsertLeadMock).toHaveBeenCalledTimes(3);
  });
});

// ── connectionsOnly parameter ─────────────────────────────────────────────

describe('connectionsOnly parameter', () => {
  it('sets status=Connected (not New) when connectionsOnly is true', async () => {
    // Regression: ISSUE-002 — connectionsOnly status path had no test coverage
    // Found by /qa on 2026-03-23
    const page = makeMockPage({ '[data-chameleon-result-urn]': 2 });
    state.getBrowserContextMock!.mockResolvedValue(makeMockContext(page));

    await runSearch({ query: 'engineer', maxLeads: 2, connectionsOnly: true });

    expect(state.upsertLeadMock).toHaveBeenCalledTimes(2);
    for (const call of (state.upsertLeadMock as ReturnType<typeof vi.fn>).mock.calls) {
      expect(call[0]).toMatchObject({ status: 'Connected' });
    }
  });

  it('includes network filter in URL when connectionsOnly is true', async () => {
    const page = makeMockPage({ '[data-chameleon-result-urn]': 1 });
    state.getBrowserContextMock!.mockResolvedValue(makeMockContext(page));

    await runSearch({ query: 'designer', maxLeads: 1, connectionsOnly: true });

    const gotoUrl = (page.goto as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(gotoUrl).toContain('network=%5B%22F%22%5D');
  });

  it('does NOT include network filter when connectionsOnly is false or absent', async () => {
    const page = makeMockPage({ '[data-chameleon-result-urn]': 1 });
    state.getBrowserContextMock!.mockResolvedValue(makeMockContext(page));

    await runSearch({ query: 'designer', maxLeads: 1 });

    const gotoUrl = (page.goto as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(gotoUrl).not.toContain('network=');
  });
});

// ── Context is always closed ───────────────────────────────────────────────

describe('browser context cleanup', () => {
  it('closes browser context even when all selectors fail', async () => {
    const mockContext = makeMockContext(makeMockPage({}));
    state.getBrowserContextMock!.mockResolvedValue(mockContext);

    await runSearch({ query: 'test' });

    expect(mockContext.close).toHaveBeenCalledOnce();
  });

  it('closes browser context after successful scrape', async () => {
    const page = makeMockPage({ '[data-chameleon-result-urn]': 1 });
    const mockContext = makeMockContext(page);
    state.getBrowserContextMock!.mockResolvedValue(mockContext);

    await runSearch({ query: 'test', maxLeads: 1 });

    expect(mockContext.close).toHaveBeenCalledOnce();
  });
});
