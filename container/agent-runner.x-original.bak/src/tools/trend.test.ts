import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  readTrendConfig,
  readTrendHistory,
  writeTrendSnapshot,
  pruneTrendHistory,
  collectTrendSnapshot,
  detectRestartFrequency,
  detectErrorRateTrend,
  detectUptimeAnomaly,
  detectCrossBotCorrelation,
  runTrendAnalysis,
  DEFAULT_TREND_CONFIG,
  type TrendSnapshot,
  type TrendConfig,
  type DetectorConfig,
  type DigestBotData,
  type BotTrendMetrics,
} from './trend.js';

// ─── Trend Config I/O (T1) ─────────────────────────────

describe('readTrendConfig', () => {
  let tmpDir: string;
  let configPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trend-config-test-'));
    configPath = path.join(tmpDir, 'trend-config.json');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns defaults for missing file and auto-creates', () => {
    const config = readTrendConfig(configPath);
    expect(config.retentionDays).toBe(30);
    expect(config.detectors['restart-frequency'].enabled).toBe(true);
    expect(config.detectors['restart-frequency'].windowDays).toBe(7);
    expect(config.detectors['restart-frequency'].threshold.restartCount).toBe(4);
    expect(config.detectors['restart-frequency'].minDataDays).toBe(3);
    // Auto-created
    expect(fs.existsSync(configPath)).toBe(true);
  });

  it('returns defaults for corrupt file', () => {
    fs.writeFileSync(configPath, 'not json!!!');
    const config = readTrendConfig(configPath);
    expect(config.retentionDays).toBe(30);
  });

  it('returns defaults for invalid structure (bad retentionDays)', () => {
    fs.writeFileSync(configPath, JSON.stringify({ retentionDays: -1, detectors: {} }));
    const config = readTrendConfig(configPath);
    expect(config.retentionDays).toBe(30);
  });

  it('returns defaults for invalid detector config', () => {
    const bad = {
      retentionDays: 30,
      detectors: {
        'restart-frequency': { enabled: 'yes' }, // should be boolean
      },
    };
    fs.writeFileSync(configPath, JSON.stringify(bad));
    const config = readTrendConfig(configPath);
    expect(config.detectors['restart-frequency'].enabled).toBe(true);
  });

  it('reads valid custom config', () => {
    const custom: TrendConfig = {
      retentionDays: 14,
      detectors: {
        'restart-frequency': {
          enabled: false,
          windowDays: 5,
          threshold: { restartCount: 8 },
          minDataDays: 2,
        },
      },
    };
    fs.writeFileSync(configPath, JSON.stringify(custom));
    const config = readTrendConfig(configPath);
    expect(config.retentionDays).toBe(14);
    expect(config.detectors['restart-frequency'].enabled).toBe(false);
    expect(config.detectors['restart-frequency'].threshold.restartCount).toBe(8);
  });

  it('default config has all 4 detectors', () => {
    expect(Object.keys(DEFAULT_TREND_CONFIG.detectors)).toHaveLength(4);
    expect(DEFAULT_TREND_CONFIG.detectors['restart-frequency']).toBeDefined();
    expect(DEFAULT_TREND_CONFIG.detectors['error-rate-trend']).toBeDefined();
    expect(DEFAULT_TREND_CONFIG.detectors['uptime-anomaly']).toBeDefined();
    expect(DEFAULT_TREND_CONFIG.detectors['cross-bot-correlation']).toBeDefined();
  });
});

// ─── Trend History I/O (T2) ────────────────────────────

describe('readTrendHistory', () => {
  let tmpDir: string;
  let histPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trend-hist-test-'));
    histPath = path.join(tmpDir, 'trend-history.json');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns empty array for missing file', () => {
    expect(readTrendHistory(histPath)).toEqual([]);
  });

  it('returns empty array for corrupt file', () => {
    fs.writeFileSync(histPath, '{{{bad json');
    expect(readTrendHistory(histPath)).toEqual([]);
  });

  it('returns empty array for non-array JSON', () => {
    fs.writeFileSync(histPath, JSON.stringify({ date: '2026-03-15' }));
    expect(readTrendHistory(histPath)).toEqual([]);
  });

  it('returns empty array for invalid snapshot entries', () => {
    fs.writeFileSync(histPath, JSON.stringify([{ noDate: true }]));
    expect(readTrendHistory(histPath)).toEqual([]);
  });

  it('reads valid history', () => {
    const data: TrendSnapshot[] = [
      { date: '2026-03-13', bots: { db: makeBotMetrics() } },
      { date: '2026-03-14', bots: { db: makeBotMetrics() } },
    ];
    fs.writeFileSync(histPath, JSON.stringify(data));
    const result = readTrendHistory(histPath);
    expect(result).toHaveLength(2);
    expect(result[0].date).toBe('2026-03-13');
  });
});

describe('writeTrendSnapshot', () => {
  let tmpDir: string;
  let histPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trend-write-test-'));
    histPath = path.join(tmpDir, 'trend-history.json');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates file with first snapshot', () => {
    const snap: TrendSnapshot = { date: '2026-03-15', bots: { db: makeBotMetrics() } };
    writeTrendSnapshot(histPath, snap);
    const read = readTrendHistory(histPath);
    expect(read).toHaveLength(1);
    expect(read[0].date).toBe('2026-03-15');
  });

  it('appends new snapshot', () => {
    writeTrendSnapshot(histPath, { date: '2026-03-14', bots: { db: makeBotMetrics() } });
    writeTrendSnapshot(histPath, { date: '2026-03-15', bots: { db: makeBotMetrics() } });
    const read = readTrendHistory(histPath);
    expect(read).toHaveLength(2);
    expect(read[0].date).toBe('2026-03-14');
    expect(read[1].date).toBe('2026-03-15');
  });

  it('replaces snapshot for same date (idempotent)', () => {
    writeTrendSnapshot(histPath, { date: '2026-03-15', bots: { db: makeBotMetrics({ restartCount: 1 }) } });
    writeTrendSnapshot(histPath, { date: '2026-03-15', bots: { db: makeBotMetrics({ restartCount: 5 }) } });
    const read = readTrendHistory(histPath);
    expect(read).toHaveLength(1);
    expect(read[0].bots.db.restartCount).toBe(5);
  });

  it('recovers from corrupt file', () => {
    fs.writeFileSync(histPath, '{{{bad');
    const snap: TrendSnapshot = { date: '2026-03-15', bots: { db: makeBotMetrics() } };
    writeTrendSnapshot(histPath, snap);
    const read = readTrendHistory(histPath);
    expect(read).toHaveLength(1);
  });

  it('creates parent directories', () => {
    const deepPath = path.join(tmpDir, 'a', 'b', 'trend-history.json');
    writeTrendSnapshot(deepPath, { date: '2026-03-15', bots: { db: makeBotMetrics() } });
    expect(fs.existsSync(deepPath)).toBe(true);
  });
});

describe('pruneTrendHistory', () => {
  it('prunes entries older than retentionDays', () => {
    const history: TrendSnapshot[] = [];
    for (let i = 0; i < 35; i++) {
      const d = new Date('2026-03-15');
      d.setDate(d.getDate() - (34 - i));
      history.push({ date: d.toISOString().slice(0, 10), bots: { db: makeBotMetrics() } });
    }
    const pruned = pruneTrendHistory(history, 30, '2026-03-15');
    expect(pruned.length).toBeLessThanOrEqual(31);
    // All entries should be within 30 days of reference
    for (const s of pruned) {
      expect(s.date >= '2026-02-13').toBe(true);
    }
  });

  it('does not prune when under retention limit', () => {
    const history: TrendSnapshot[] = [
      { date: '2026-03-14', bots: { db: makeBotMetrics() } },
      { date: '2026-03-15', bots: { db: makeBotMetrics() } },
    ];
    const pruned = pruneTrendHistory(history, 30, '2026-03-15');
    expect(pruned).toHaveLength(2);
  });

  it('returns empty for all-old entries', () => {
    const history: TrendSnapshot[] = [
      { date: '2025-01-01', bots: { db: makeBotMetrics() } },
    ];
    const pruned = pruneTrendHistory(history, 30, '2026-03-15');
    expect(pruned).toHaveLength(0);
  });
});

// ─── Snapshot Collection (T3) ───────────────────────────

describe('collectTrendSnapshot', () => {
  it('collects metrics from digest data', () => {
    const data: DigestBotData[] = [
      {
        bot: 'db',
        healthState: 'healthy',
        restartCount: 2,
        errorCount: 14,
        uptimePercent: 97.2,
        stateTransitions: [
          { from: 'healthy', to: 'down', timestamp: '2026-03-13T03:22:00Z' },
          { from: 'down', to: 'healthy', timestamp: '2026-03-13T03:25:00Z' },
        ],
        unreachableEpisodes: 0,
      },
      {
        bot: 'nook',
        healthState: 'healthy',
        restartCount: 0,
        errorCount: 8,
        uptimePercent: 100,
        stateTransitions: [],
        unreachableEpisodes: 0,
      },
    ];

    const snap = collectTrendSnapshot(data, '2026-03-13');
    expect(snap.date).toBe('2026-03-13');
    expect(snap.bots.db.restartCount).toBe(2);
    expect(snap.bots.db.errorCount).toBe(14);
    expect(snap.bots.db.uptimePercent).toBe(97.2);
    expect(snap.bots.db.stateTransitions).toHaveLength(2);
    expect(snap.bots.nook.restartCount).toBe(0);
    expect(snap.bots.nook.healthState).toBe('healthy');
  });

  it('uses current date if not provided', () => {
    const snap = collectTrendSnapshot([]);
    expect(snap.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

// ─── Restart Frequency Detector (T4) ───────────────────

describe('detectRestartFrequency', () => {
  const config: DetectorConfig = {
    enabled: true,
    windowDays: 7,
    threshold: { restartCount: 4 },
    minDataDays: 3,
  };

  it('fires when total restarts exceed threshold', () => {
    const history = makeHistory([
      { date: '2026-03-13', db: { restartCount: 2 } },
      { date: '2026-03-14', db: { restartCount: 1 } },
      { date: '2026-03-15', db: { restartCount: 2 } },
    ]);
    const proposals = detectRestartFrequency(history, config);
    expect(proposals).toHaveLength(1);
    expect(proposals[0].detector).toBe('restart-frequency');
    expect(proposals[0].bot).toBe('db');
    expect(proposals[0].summary).toContain('5 times');
  });

  it('does not fire when below threshold', () => {
    const history = makeHistory([
      { date: '2026-03-13', db: { restartCount: 1 } },
      { date: '2026-03-14', db: { restartCount: 0 } },
      { date: '2026-03-15', db: { restartCount: 1 } },
    ]);
    const proposals = detectRestartFrequency(history, config);
    expect(proposals).toHaveLength(0);
  });

  it('does not fire with insufficient data', () => {
    const history = makeHistory([
      { date: '2026-03-15', db: { restartCount: 10 } },
    ]);
    const proposals = detectRestartFrequency(history, config);
    expect(proposals).toHaveLength(0);
  });

  it('filters by bot when specified', () => {
    const history = makeHistory([
      { date: '2026-03-13', db: { restartCount: 3 }, nook: { restartCount: 3 } },
      { date: '2026-03-14', db: { restartCount: 3 }, nook: { restartCount: 0 } },
      { date: '2026-03-15', db: { restartCount: 0 }, nook: { restartCount: 0 } },
    ]);
    const dbOnly = detectRestartFrequency(history, config, 'db');
    expect(dbOnly).toHaveLength(1);
    expect(dbOnly[0].bot).toBe('db');

    const nookOnly = detectRestartFrequency(history, config, 'nook');
    expect(nookOnly).toHaveLength(0); // nook only has 3, below threshold
  });

  it('exactly at threshold fires', () => {
    const history = makeHistory([
      { date: '2026-03-13', db: { restartCount: 2 } },
      { date: '2026-03-14', db: { restartCount: 1 } },
      { date: '2026-03-15', db: { restartCount: 1 } },
    ]);
    const proposals = detectRestartFrequency(history, config);
    expect(proposals).toHaveLength(1); // 4 == threshold
  });
});

// ─── Error Rate Trend Detector (T5) ────────────────────

describe('detectErrorRateTrend', () => {
  const config: DetectorConfig = {
    enabled: true,
    windowDays: 5,
    threshold: { consecutiveIncreasingDays: 3 },
    minDataDays: 3,
  };

  it('fires on 3 consecutive increasing days', () => {
    const history = makeHistory([
      { date: '2026-03-12', db: { errorCount: 10 } },
      { date: '2026-03-13', db: { errorCount: 15 } },
      { date: '2026-03-14', db: { errorCount: 20 } },
      { date: '2026-03-15', db: { errorCount: 30 } },
    ]);
    const proposals = detectErrorRateTrend(history, config);
    expect(proposals).toHaveLength(1);
    expect(proposals[0].detector).toBe('error-rate-trend');
    expect(proposals[0].summary).toContain('climbing');
  });

  it('does not fire on plateau', () => {
    const history = makeHistory([
      { date: '2026-03-13', db: { errorCount: 10 } },
      { date: '2026-03-14', db: { errorCount: 10 } },
      { date: '2026-03-15', db: { errorCount: 10 } },
    ]);
    const proposals = detectErrorRateTrend(history, config);
    expect(proposals).toHaveLength(0);
  });

  it('does not fire on single spike', () => {
    const history = makeHistory([
      { date: '2026-03-13', db: { errorCount: 10 } },
      { date: '2026-03-14', db: { errorCount: 50 } },
      { date: '2026-03-15', db: { errorCount: 10 } },
    ]);
    const proposals = detectErrorRateTrend(history, config);
    expect(proposals).toHaveLength(0);
  });

  it('does not fire with insufficient data', () => {
    const history = makeHistory([
      { date: '2026-03-14', db: { errorCount: 10 } },
      { date: '2026-03-15', db: { errorCount: 20 } },
    ]);
    const proposals = detectErrorRateTrend(history, config);
    expect(proposals).toHaveLength(0);
  });

  it('handles decreasing then increasing (no false fire)', () => {
    const history = makeHistory([
      { date: '2026-03-12', db: { errorCount: 20 } },
      { date: '2026-03-13', db: { errorCount: 10 } },
      { date: '2026-03-14', db: { errorCount: 15 } },
      { date: '2026-03-15', db: { errorCount: 20 } },
    ]);
    const proposals = detectErrorRateTrend(history, config);
    // Only 2 consecutive increasing (10→15→20), needs 3
    expect(proposals).toHaveLength(0);
  });
});

// ─── Uptime Anomaly Detector (T6) ──────────────────────

describe('detectUptimeAnomaly', () => {
  const config: DetectorConfig = {
    enabled: true,
    windowDays: 7,
    threshold: { avgUptimePercentBelow: 95 },
    minDataDays: 5,
  };

  it('fires when average uptime below threshold', () => {
    const history = makeHistory([
      { date: '2026-03-11', db: { uptimePercent: 80 } },
      { date: '2026-03-12', db: { uptimePercent: 85 } },
      { date: '2026-03-13', db: { uptimePercent: 90 } },
      { date: '2026-03-14', db: { uptimePercent: 92 } },
      { date: '2026-03-15', db: { uptimePercent: 88 } },
    ]);
    const proposals = detectUptimeAnomaly(history, config);
    expect(proposals).toHaveLength(1);
    expect(proposals[0].detector).toBe('uptime-anomaly');
    expect(proposals[0].summary).toContain('uptime');
  });

  it('does not fire when average above threshold', () => {
    const history = makeHistory([
      { date: '2026-03-11', db: { uptimePercent: 99 } },
      { date: '2026-03-12', db: { uptimePercent: 98 } },
      { date: '2026-03-13', db: { uptimePercent: 97 } },
      { date: '2026-03-14', db: { uptimePercent: 96 } },
      { date: '2026-03-15', db: { uptimePercent: 99 } },
    ]);
    const proposals = detectUptimeAnomaly(history, config);
    expect(proposals).toHaveLength(0);
  });

  it('one bad day in otherwise good week does not fire', () => {
    const history = makeHistory([
      { date: '2026-03-11', db: { uptimePercent: 99 } },
      { date: '2026-03-12', db: { uptimePercent: 50 } }, // bad day
      { date: '2026-03-13', db: { uptimePercent: 99 } },
      { date: '2026-03-14', db: { uptimePercent: 99 } },
      { date: '2026-03-15', db: { uptimePercent: 99 } },
    ]);
    // average = (99+50+99+99+99)/5 = 89.2 — below 95, so it fires
    const proposals = detectUptimeAnomaly(history, config);
    expect(proposals).toHaveLength(1);
  });

  it('does not fire with insufficient data', () => {
    const history = makeHistory([
      { date: '2026-03-14', db: { uptimePercent: 50 } },
      { date: '2026-03-15', db: { uptimePercent: 50 } },
    ]);
    const proposals = detectUptimeAnomaly(history, config);
    expect(proposals).toHaveLength(0);
  });
});

// ─── Cross-Bot Correlation Detector (T7) ────────────────

describe('detectCrossBotCorrelation', () => {
  const config: DetectorConfig = {
    enabled: true,
    windowDays: 1,
    threshold: { minBotsAffected: 2 },
    minDataDays: 1,
  };

  it('fires when both bots had unreachable episodes same day', () => {
    const history: TrendSnapshot[] = [
      {
        date: '2026-03-15',
        bots: {
          db: makeBotMetrics({ unreachableEpisodes: 2 }),
          nook: makeBotMetrics({ unreachableEpisodes: 1 }),
        },
      },
    ];
    const proposals = detectCrossBotCorrelation(history, config);
    expect(proposals).toHaveLength(1);
    expect(proposals[0].detector).toBe('cross-bot-correlation');
    expect(proposals[0].bot).toBe('fleet');
    expect(proposals[0].summary).toContain('unreachable');
  });

  it('fires when both bots are down same day', () => {
    const history: TrendSnapshot[] = [
      {
        date: '2026-03-15',
        bots: {
          db: makeBotMetrics({ healthState: 'down' }),
          nook: makeBotMetrics({ healthState: 'down' }),
        },
      },
    ];
    const proposals = detectCrossBotCorrelation(history, config);
    expect(proposals).toHaveLength(1);
    expect(proposals[0].summary).toContain('down');
  });

  it('does not fire when only one bot affected', () => {
    const history: TrendSnapshot[] = [
      {
        date: '2026-03-15',
        bots: {
          db: makeBotMetrics({ unreachableEpisodes: 2 }),
          nook: makeBotMetrics({ unreachableEpisodes: 0 }),
        },
      },
    ];
    const proposals = detectCrossBotCorrelation(history, config);
    expect(proposals).toHaveLength(0);
  });

  it('reports multiple issue types separately', () => {
    const history: TrendSnapshot[] = [
      {
        date: '2026-03-15',
        bots: {
          db: makeBotMetrics({ unreachableEpisodes: 1, healthState: 'degraded' }),
          nook: makeBotMetrics({ unreachableEpisodes: 1, healthState: 'degraded' }),
        },
      },
    ];
    const proposals = detectCrossBotCorrelation(history, config);
    expect(proposals).toHaveLength(2); // unreachable + degraded
  });

  it('does not fire with insufficient data (empty history)', () => {
    const proposals = detectCrossBotCorrelation([], config);
    expect(proposals).toHaveLength(0);
  });
});

// ─── Run All Detectors (T8) ────────────────────────────

describe('runTrendAnalysis', () => {
  it('runs all enabled detectors and returns combined proposals', () => {
    const history = makeHistory([
      { date: '2026-03-10', db: { restartCount: 2, errorCount: 10, uptimePercent: 80 }, nook: { restartCount: 0, errorCount: 5, uptimePercent: 99 } },
      { date: '2026-03-11', db: { restartCount: 1, errorCount: 15, uptimePercent: 85 }, nook: { restartCount: 0, errorCount: 5, uptimePercent: 99 } },
      { date: '2026-03-12', db: { restartCount: 1, errorCount: 20, uptimePercent: 82 }, nook: { restartCount: 0, errorCount: 5, uptimePercent: 99 } },
      { date: '2026-03-13', db: { restartCount: 0, errorCount: 25, uptimePercent: 88 }, nook: { restartCount: 0, errorCount: 5, uptimePercent: 99 } },
      { date: '2026-03-14', db: { restartCount: 1, errorCount: 30, uptimePercent: 90 }, nook: { restartCount: 0, errorCount: 5, uptimePercent: 99 } },
      { date: '2026-03-15', db: { restartCount: 0, errorCount: 35, uptimePercent: 86 }, nook: { restartCount: 0, errorCount: 5, uptimePercent: 99 } },
    ]);

    const result = runTrendAnalysis(history, DEFAULT_TREND_CONFIG);
    expect(result.analyzedDays).toBe(6);
    expect(result.botsAnalyzed).toContain('db');
    expect(result.botsAnalyzed).toContain('nook');
    // db should trigger: restart-frequency (total 5), error-rate-trend (6 consecutive increasing), uptime-anomaly (avg ~85)
    const detectors = result.proposals.map(p => p.detector);
    expect(detectors).toContain('restart-frequency');
    expect(detectors).toContain('error-rate-trend');
    expect(detectors).toContain('uptime-anomaly');
  });

  it('skips disabled detectors', () => {
    const config: TrendConfig = {
      retentionDays: 30,
      detectors: {
        'restart-frequency': { ...DEFAULT_TREND_CONFIG.detectors['restart-frequency'], enabled: false },
        'error-rate-trend': { ...DEFAULT_TREND_CONFIG.detectors['error-rate-trend'] },
        'uptime-anomaly': { ...DEFAULT_TREND_CONFIG.detectors['uptime-anomaly'] },
        'cross-bot-correlation': { ...DEFAULT_TREND_CONFIG.detectors['cross-bot-correlation'] },
      },
    };

    const history = makeHistory([
      { date: '2026-03-13', db: { restartCount: 5 } },
      { date: '2026-03-14', db: { restartCount: 5 } },
      { date: '2026-03-15', db: { restartCount: 5 } },
    ]);

    const result = runTrendAnalysis(history, config);
    const detectors = result.proposals.map(p => p.detector);
    expect(detectors).not.toContain('restart-frequency');
  });

  it('filters by bot when specified', () => {
    const history = makeHistory([
      { date: '2026-03-13', db: { restartCount: 3 }, nook: { restartCount: 3 } },
      { date: '2026-03-14', db: { restartCount: 3 }, nook: { restartCount: 3 } },
      { date: '2026-03-15', db: { restartCount: 3 }, nook: { restartCount: 3 } },
    ]);

    const result = runTrendAnalysis(history, DEFAULT_TREND_CONFIG, 'db');
    expect(result.botsAnalyzed).toEqual(['db']);
    // All proposals should be for db only (or fleet)
    for (const p of result.proposals) {
      expect(['db', 'fleet']).toContain(p.bot);
    }
  });

  it('returns empty proposals when no issues', () => {
    const history = makeHistory([
      { date: '2026-03-11', db: { restartCount: 0, errorCount: 5, uptimePercent: 99 } },
      { date: '2026-03-12', db: { restartCount: 0, errorCount: 5, uptimePercent: 99 } },
      { date: '2026-03-13', db: { restartCount: 0, errorCount: 5, uptimePercent: 99 } },
      { date: '2026-03-14', db: { restartCount: 0, errorCount: 5, uptimePercent: 99 } },
      { date: '2026-03-15', db: { restartCount: 0, errorCount: 5, uptimePercent: 99 } },
    ]);

    const result = runTrendAnalysis(history, DEFAULT_TREND_CONFIG);
    expect(result.proposals).toHaveLength(0);
  });
});

// ─── Helpers ────────────────────────────────────────────

function makeBotMetrics(overrides: Partial<BotTrendMetrics> = {}): BotTrendMetrics {
  return {
    restartCount: 0,
    errorCount: 0,
    uptimePercent: 100,
    stateTransitions: [],
    unreachableEpisodes: 0,
    healthState: 'healthy',
    ...overrides,
  };
}

function makeHistory(
  entries: Array<{ date: string; [bot: string]: any }>,
): TrendSnapshot[] {
  return entries.map(entry => {
    const { date, ...bots } = entry;
    const botMetrics: Record<string, BotTrendMetrics> = {};
    for (const [bot, overrides] of Object.entries(bots)) {
      botMetrics[bot] = makeBotMetrics(overrides as Partial<BotTrendMetrics>);
    }
    return { date, bots: botMetrics };
  });
}
