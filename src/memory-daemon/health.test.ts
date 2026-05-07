import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import Database from 'better-sqlite3';
import { runMnemonIngestMigrations } from '../db/migrations/019-mnemon-ingest-db.js';
import { HealthRecorder, resetHealthRecorder } from './health.js';

function makeIngestDb(): Database.Database {
  const db = new Database(':memory:');
  runMnemonIngestMigrations(db);
  return db;
}

function insertJudgedOutcome(
  db: Database.Database,
  opts: {
    recallEventId: string;
    factId: string;
    agentGroupId: string;
    judgeScore: number;
    judgeMethod?: string;
    createdHoursAgo?: number;
    judgedHoursAgo?: number;
  },
): void {
  const createdAt = new Date(Date.now() - (opts.createdHoursAgo ?? 1) * 3_600_000).toISOString();
  const judgedAt = new Date(Date.now() - (opts.judgedHoursAgo ?? 0.5) * 3_600_000).toISOString();
  db.prepare(
    `INSERT INTO recall_outcomes
     (recall_event_id, fact_id, judge_prompt_version, agent_group_id, query_strategy,
      trigger_sent_at, created_at, judge_score, judge_method, judged_at)
     VALUES (?, ?, 'v1', ?, 'raw', ?, ?, ?, ?, ?)`,
  ).run(
    opts.recallEventId,
    opts.factId,
    opts.agentGroupId,
    createdAt,
    createdAt,
    opts.judgeScore,
    opts.judgeMethod ?? 'llm',
    judgedAt,
  );
}

beforeEach(() => {
  resetHealthRecorder();
});

afterEach(() => {
  resetHealthRecorder();
});

describe('health recorder recall_quality block (C4)', () => {
  it('test_recall_quality_block_added', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'health-rq-test-'));
    const healthPath = path.join(tmpDir, 'memory-health.json');
    try {
      const db = makeIngestDb();
      insertJudgedOutcome(db, { recallEventId: 'e1', factId: 'f1', agentGroupId: 'ag-1', judgeScore: 2 });
      insertJudgedOutcome(db, { recallEventId: 'e1', factId: 'f2', agentGroupId: 'ag-1', judgeScore: 0 });

      const hr = new HealthRecorder();
      hr.setIngestDbForTest(db);
      hr.recordTurnClassified('ag-1', 1, 100);
      await hr.flush(healthPath);

      const parsed = JSON.parse(fs.readFileSync(healthPath, 'utf8'));
      const rq = parsed.groups['ag-1'].recall_quality as Record<string, unknown>;
      expect(rq).toBeDefined();
      expect(typeof rq.coverage_24h).toBe('number');
      expect(typeof rq.useful_fact_rate_7d).toBe('number');
      expect(typeof rq.load_bearing_event_rate_7d).toBe('number');
      expect(rq.rank_distribution_7d).toBeDefined();
      expect(typeof rq.judge_failure_rate_24h).toBe('number');
      expect(typeof rq.ambiguous_correlation_rate_24h).toBe('number');
      expect(typeof rq.judged_count_total).toBe('number');
      expect(typeof rq.judge_retry_p50_24h).toBe('number');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('test_existing_fields_preserved', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'health-existing-test-'));
    const healthPath = path.join(tmpDir, 'memory-health.json');
    try {
      const hr = new HealthRecorder();
      hr.recordTurnClassified('ag-1', 5, 100);
      hr.recordClassifierFailure('ag-1', new Error('boom'));
      await hr.flush(healthPath);

      const parsed = JSON.parse(fs.readFileSync(healthPath, 'utf8'));
      const g = parsed.groups['ag-1'] as Record<string, unknown>;
      expect(g.factsLast24h).toBe(5);
      expect(g.classifierFails24h).toBe(1);
      expect(g.deadLettersOpen).toBeDefined();
      expect(g.recallP50Ms).toBeDefined();
      expect(g.recallTopKDistribution24h).toBeDefined();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('test_coverage_24h_calculation', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'health-cov-test-'));
    const healthPath = path.join(tmpDir, 'memory-health.json');
    try {
      const db = makeIngestDb();
      // 9 judged outcomes in one event, 1 pending (no judged_at)
      for (let i = 0; i < 9; i++) {
        insertJudgedOutcome(db, { recallEventId: `ev-j${i}`, factId: 'f1', agentGroupId: 'ag-1', judgeScore: 1, createdHoursAgo: 2 });
      }
      // 1 pending (no judged_at) — createdHoursAgo = 2 so it's in the 24h window
      db.prepare(
        `INSERT INTO recall_outcomes (recall_event_id, fact_id, judge_prompt_version, agent_group_id, query_strategy, trigger_sent_at, created_at, judge_method)
         VALUES ('ev-pending', 'f1', 'v1', 'ag-1', 'raw', ?, ?, 'pending')`,
      ).run(new Date(Date.now() - 7_200_000).toISOString(), new Date(Date.now() - 7_200_000).toISOString());

      const hr = new HealthRecorder();
      hr.setIngestDbForTest(db);
      hr.recordTurnClassified('ag-1', 0, 0);
      await hr.flush(healthPath);

      const parsed = JSON.parse(fs.readFileSync(healthPath, 'utf8'));
      const rq = parsed.groups['ag-1'].recall_quality as { coverage_24h: number };
      expect(rq.coverage_24h).toBeCloseTo(0.9, 5);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('test_load_bearing_event_rate', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'health-lb-test-'));
    const healthPath = path.join(tmpDir, 'memory-health.json');
    try {
      const db = makeIngestDb();
      // 4 events with a score=2 fact, 6 without (only score 0 or 1)
      for (let i = 0; i < 4; i++) {
        insertJudgedOutcome(db, { recallEventId: `ev-lb-${i}`, factId: 'f1', agentGroupId: 'ag-1', judgeScore: 2 });
      }
      for (let i = 0; i < 6; i++) {
        insertJudgedOutcome(db, { recallEventId: `ev-nonlb-${i}`, factId: 'f1', agentGroupId: 'ag-1', judgeScore: 1 });
      }

      const hr = new HealthRecorder();
      hr.setIngestDbForTest(db);
      hr.recordTurnClassified('ag-1', 0, 0);
      await hr.flush(healthPath);

      const parsed = JSON.parse(fs.readFileSync(healthPath, 'utf8'));
      const rq = parsed.groups['ag-1'].recall_quality as { load_bearing_event_rate_7d: number };
      expect(rq.load_bearing_event_rate_7d).toBeCloseTo(0.4, 5);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('test_rank_distribution', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'health-dist-rq-test-'));
    const healthPath = path.join(tmpDir, 'memory-health.json');
    try {
      const db = makeIngestDb();
      // 30 score=0, 50 score=1, 20 score=2
      for (let i = 0; i < 30; i++) insertJudgedOutcome(db, { recallEventId: `e0-${i}`, factId: 'f1', agentGroupId: 'ag-1', judgeScore: 0 });
      for (let i = 0; i < 50; i++) insertJudgedOutcome(db, { recallEventId: `e1-${i}`, factId: 'f1', agentGroupId: 'ag-1', judgeScore: 1 });
      for (let i = 0; i < 20; i++) insertJudgedOutcome(db, { recallEventId: `e2-${i}`, factId: 'f1', agentGroupId: 'ag-1', judgeScore: 2 });

      const hr = new HealthRecorder();
      hr.setIngestDbForTest(db);
      hr.recordTurnClassified('ag-1', 0, 0);
      await hr.flush(healthPath);

      const parsed = JSON.parse(fs.readFileSync(healthPath, 'utf8'));
      const dist = (parsed.groups['ag-1'].recall_quality as { rank_distribution_7d: Record<string, number> }).rank_distribution_7d;
      expect(dist.score_0).toBeCloseTo(0.3, 5);
      expect(dist.score_1).toBeCloseTo(0.5, 5);
      expect(dist.score_2).toBeCloseTo(0.2, 5);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('test_merge_host_ollama_status', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'health-ollama-test-'));
    const healthPath = path.join(tmpDir, 'memory-health.json');
    const statusPath = path.join(tmpDir, 'ollama-status.json');
    try {
      fs.writeFileSync(statusPath, JSON.stringify({ ok: true, checkedAt: '2026-05-07T00:00:00Z', endpoint: 'http://127.0.0.1:11434' }), 'utf8');

      const hr = new HealthRecorder();
      hr.setOllamaStatusFilePathForTest(statusPath);
      await hr.mergeHostOllamaStatus();
      await hr.flush(healthPath);

      const parsed = JSON.parse(fs.readFileSync(healthPath, 'utf8')) as { ollamaCheckHost?: { ok: boolean } };
      expect(parsed.ollamaCheckHost).toBeDefined();
      expect(parsed.ollamaCheckHost!.ok).toBe(true);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('test_merge_host_ollama_missing_is_noop', async () => {
    const hr = new HealthRecorder();
    hr.setOllamaStatusFilePathForTest('/nonexistent/path/ollama-status.json');
    await expect(hr.mergeHostOllamaStatus()).resolves.toBeUndefined();
  });
});

describe('health recorder', () => {
  it('test_recordTurnClassified_aggregates', () => {
    const hr = new HealthRecorder();

    hr.recordTurnClassified('ag-1', 2, 100);
    hr.recordTurnClassified('ag-1', 3, 150);
    hr.recordTurnClassified('ag-1', 0, 80);
    hr.recordTurnClassified('ag-1', 5, 200);
    hr.recordTurnClassified('ag-1', 1, 120);

    const groupState = (
      hr as unknown as { groups: Map<string, { factsLast24h: number; classifierFails24h: number }> }
    ).groups.get('ag-1');
    expect(groupState).toBeDefined();
    expect(groupState!.factsLast24h).toBe(11);
    expect(groupState!.classifierFails24h).toBe(0);
  });

  it('test_flush_writes_atomic', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'health-test-'));
    const healthPath = path.join(tmpDir, 'memory-health.json');

    try {
      const hr = new HealthRecorder();
      hr.recordTurnClassified('ag-1', 5, 100);
      hr.setPrereqVerification(true, { db: true });

      await hr.flush(healthPath);

      expect(fs.existsSync(healthPath)).toBe(true);
      expect(fs.existsSync(`${healthPath}.tmp`)).toBe(false);

      const raw = fs.readFileSync(healthPath, 'utf8');
      const parsed = JSON.parse(raw);
      expect(parsed).toBeDefined();
      expect(parsed.prereqVerification).toBeDefined();
      expect(parsed.prereqVerification.ok).toBe(true);
      expect(parsed.groups['ag-1']).toBeDefined();
      expect(parsed.groups['ag-1'].factsLast24h).toBe(5);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('test_recallTopKDistribution_buckets', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'health-dist-test-'));
    const healthPath = path.join(tmpDir, 'memory-health.json');

    try {
      const hr = new HealthRecorder();
      const counts = [0, 0, 1, 2, 3, 4, 4, 5, 6];

      for (const c of counts) {
        hr.recordRecallLatency('ag-1', 50, c);
      }

      await hr.flush(healthPath);

      const raw = fs.readFileSync(healthPath, 'utf8');
      const parsed = JSON.parse(raw);
      const dist = parsed.groups['ag-1'].recallTopKDistribution24h;

      expect(dist['0']).toBe(2);
      expect(dist['1-3']).toBe(3);
      expect(dist['4-5']).toBe(3);
      expect(dist['6+']).toBe(1);
      expect(dist['0'] + dist['1-3'] + dist['4-5'] + dist['6+']).toBe(9);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
