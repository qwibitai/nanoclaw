import fs from 'fs';
import path from 'path';
import { getTraceDir } from './traces.js';

// Rough $/1M token prices (as of model release). Update when pricing changes.
// Input pricing is used for uncached input; cached reads are billed at 10%.
const PRICES: Record<
  1 | 2 | 3,
  { inUsdPerMtok: number; outUsdPerMtok: number }
> = {
  1: { inUsdPerMtok: 1.0, outUsdPerMtok: 5.0 }, // Haiku
  2: { inUsdPerMtok: 3.0, outUsdPerMtok: 15.0 }, // Sonnet
  3: { inUsdPerMtok: 15.0, outUsdPerMtok: 75.0 }, // Opus
};

export function estimateCostUsd(
  tier: 1 | 2 | 3,
  inputTokens: number,
  outputTokens: number,
  cacheReadTokens: number,
): number {
  const price = PRICES[tier];
  const uncachedIn = Math.max(0, inputTokens - cacheReadTokens);
  const cachedIn = cacheReadTokens;
  const inCost =
    (uncachedIn * price.inUsdPerMtok + cachedIn * price.inUsdPerMtok * 0.1) /
    1_000_000;
  const outCost = (outputTokens * price.outUsdPerMtok) / 1_000_000;
  return inCost + outCost;
}

function todayTraceFile(): string {
  const date = new Date().toISOString().slice(0, 10);
  return path.join(getTraceDir(), `${date}.jsonl`);
}

export function todayCostUsd(): number {
  const file = todayTraceFile();
  if (!fs.existsSync(file)) return 0;
  const contents = fs.readFileSync(file, 'utf8');
  let total = 0;
  for (const line of contents.split('\n')) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line) as {
        tier: 1 | 2 | 3;
        inputTokens: number;
        outputTokens: number;
        cacheReadTokens: number;
      };
      total += estimateCostUsd(
        r.tier,
        r.inputTokens,
        r.outputTokens,
        r.cacheReadTokens,
      );
    } catch {
      /* skip malformed */
    }
  }
  return total;
}

// In-memory reservation to guard against concurrent classifier calls from
// the fire-and-forget SSE path — the JSONL trace is only written AFTER a
// call completes, so a burst of concurrent calls would all pass the cap
// check simultaneously without this reservation.
let reservedUsdToday = 0;
let reservedDateKey = '';

function todayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Reserve an estimated cost up-front and enforce the cap against
 * (logged + reserved). Returns a handle that callers MUST settle once
 * the actual cost is known — settle(actualUsd) adjusts the reservation,
 * and settle(0) on failure releases it.
 */
export function reserveAndEnforceCostCap(
  capUsd: number,
  estimatedUsd: number,
): { settle: (actualUsd: number) => void } {
  const key = todayKey();
  if (key !== reservedDateKey) {
    reservedDateKey = key;
    reservedUsdToday = 0;
  }

  const logged = todayCostUsd();
  if (logged + reservedUsdToday + estimatedUsd >= capUsd) {
    throw new Error(
      `Triage cost cap hit: logged=$${logged.toFixed(4)} reserved=$${reservedUsdToday.toFixed(4)} cap=$${capUsd.toFixed(2)}`,
    );
  }

  reservedUsdToday += estimatedUsd;
  let settled = false;
  return {
    settle: (actualUsd: number) => {
      if (settled) return;
      settled = true;
      reservedUsdToday = Math.max(0, reservedUsdToday - estimatedUsd);
      // actualUsd is informational — the trace file is authoritative for
      // persisted cost; this just releases our reservation.
      void actualUsd;
    },
  };
}

/**
 * Legacy check-only variant — kept for callers that don't participate in
 * the reservation protocol (e.g. the cost-cap test suite).
 */
export function enforceCostCap(capUsd: number): void {
  const today = todayCostUsd();
  if (today >= capUsd) {
    throw new Error(
      `Triage cost cap hit: today=$${today.toFixed(4)}, cap=$${capUsd.toFixed(2)}`,
    );
  }
}
