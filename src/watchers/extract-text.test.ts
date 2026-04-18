import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { createExtractFn } from './extract-text.js';

function makeMocks() {
  const page = {
    goto: vi.fn().mockResolvedValue(undefined),
    textContent: vi.fn().mockResolvedValue('$42.00'),
    close: vi.fn().mockResolvedValue(undefined),
  };
  const ctx = { newPage: vi.fn().mockResolvedValue(page) };
  const sessionManager = {
    acquireContext: vi.fn().mockResolvedValue(ctx),
  };
  return { sessionManager, ctx, page };
}

describe('createExtractFn', () => {
  let sessionManager: ReturnType<typeof makeMocks>['sessionManager'];
  let ctx: ReturnType<typeof makeMocks>['ctx'];
  let page: ReturnType<typeof makeMocks>['page'];

  beforeEach(() => {
    ({ sessionManager, ctx, page } = makeMocks());
  });

  it('navigates to the URL and extracts textContent from the selector', async () => {
    const extract = createExtractFn(sessionManager as any, 'group-1');
    const result = await extract('https://example.com/price', '.price');

    expect(sessionManager.acquireContext).toHaveBeenCalledWith('group-1');
    expect(ctx.newPage).toHaveBeenCalled();
    expect(page.goto).toHaveBeenCalledWith('https://example.com/price', {
      waitUntil: 'domcontentloaded',
      timeout: 30_000,
    });
    expect(page.textContent).toHaveBeenCalledWith('.price', {
      timeout: 10_000,
    });
    expect(page.close).toHaveBeenCalled();
    expect(result).toBe('$42.00');
  });

  it('returns empty string when textContent returns null', async () => {
    page.textContent.mockResolvedValue(null);

    const extract = createExtractFn(sessionManager as any, 'group-1');
    const result = await extract('https://example.com', '.missing');

    expect(result).toBe('');
  });

  it('closes the page even when textContent throws', async () => {
    const error = new Error('element not found');
    page.textContent.mockRejectedValue(error);

    const extract = createExtractFn(sessionManager as any, 'group-1');

    await expect(extract('https://example.com', '.bad')).rejects.toThrow(
      'element not found',
    );
    expect(page.close).toHaveBeenCalled();
  });
});
