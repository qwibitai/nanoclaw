import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { setTraceDir, emitTrace } from '../triage/traces.js';
import { enforceCostCap, estimateCostUsd } from '../triage/cost-cap.js';

describe('cost cap', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cost-cap-'));
    setTraceDir(dir);
  });

  afterEach(() => {
    try {
      fs.rmSync(dir, { recursive: true });
    } catch {
      /* noop */
    }
  });

  it('estimates cost proportional to tokens and tier', () => {
    const tier1Cost = estimateCostUsd(1, 100_000, 1000, 0);
    const tier3Cost = estimateCostUsd(3, 100_000, 1000, 0);
    expect(tier3Cost).toBeGreaterThan(tier1Cost);
  });

  it('does not throw when today cost < cap', () => {
    expect(() => enforceCostCap(1.0)).not.toThrow();
  });

  it('throws when today cost >= cap', () => {
    for (let i = 0; i < 200; i++) {
      emitTrace({
        trackedItemId: `i${i}`,
        tier: 3,
        latencyMs: 100,
        queue: 'attention',
        confidence: 0.9,
        cacheReadTokens: 0,
        inputTokens: 50_000,
        outputTokens: 2000,
      });
    }
    expect(() => enforceCostCap(1.0)).toThrow(/cost cap/i);
  });
});
