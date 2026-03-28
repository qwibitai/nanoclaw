import { describe, it, expect } from 'vitest';

import { evaluateGates, type GateStats } from './sprint-smoke-test.js';

const passingStats: GateStats = {
  agent_count: 5,
  date_range_days: 14,
  has_test_rows: false,
  test_agents: [],
};

describe('Sprint smoke test — 3-gate pre-sprint health check', () => {
  it('passes when all three gates are met', () => {
    const result = evaluateGates(passingStats);
    expect(result.pass).toBe(true);
    expect(result.fail_reasons).toHaveLength(0);
  });

  it('passes at exact gate thresholds (3 agents, 7 days)', () => {
    const result = evaluateGates({
      agent_count: 3,
      date_range_days: 7,
      has_test_rows: false,
      test_agents: [],
    });
    expect(result.pass).toBe(true);
    expect(result.fail_reasons).toHaveLength(0);
  });

  // Gate 1: Insufficient agents
  it('fails when agent count is below threshold', () => {
    const result = evaluateGates({ ...passingStats, agent_count: 2 });
    expect(result.pass).toBe(false);
    expect(result.fail_reasons).toHaveLength(1);
    expect(result.fail_reasons[0]).toMatch(/Insufficient agents.*2.*3/);
  });

  it('fails when agent count is zero', () => {
    const result = evaluateGates({ ...passingStats, agent_count: 0 });
    expect(result.pass).toBe(false);
    expect(result.fail_reasons[0]).toMatch(/Insufficient agents/);
  });

  // Gate 2: Insufficient history
  it('fails when date range is below threshold', () => {
    const result = evaluateGates({ ...passingStats, date_range_days: 6 });
    expect(result.pass).toBe(false);
    expect(result.fail_reasons).toHaveLength(1);
    expect(result.fail_reasons[0]).toMatch(/Insufficient history.*6.*7/);
  });

  it('fails when date range is zero', () => {
    const result = evaluateGates({ ...passingStats, date_range_days: 0 });
    expect(result.pass).toBe(false);
    expect(result.fail_reasons[0]).toMatch(/Insufficient history/);
  });

  // Gate 3: Test rows present
  it('fails when test rows are detected', () => {
    const result = evaluateGates({
      ...passingStats,
      has_test_rows: true,
      test_agents: ['test-agent-1', 'test-agent-2'],
    });
    expect(result.pass).toBe(false);
    expect(result.fail_reasons).toHaveLength(1);
    expect(result.fail_reasons[0]).toMatch(/Test rows detected/);
    expect(result.fail_reasons[0]).toContain('test-agent-1');
  });

  it('fails with test rows even when test_agents list is empty', () => {
    const result = evaluateGates({
      ...passingStats,
      has_test_rows: true,
      test_agents: [],
    });
    expect(result.pass).toBe(false);
    expect(result.fail_reasons[0]).toMatch(/Test rows detected/);
  });

  // Multiple gate failures
  it('reports all failures when multiple gates fail', () => {
    const result = evaluateGates({
      agent_count: 1,
      date_range_days: 2,
      has_test_rows: true,
      test_agents: ['fake-bot'],
    });
    expect(result.pass).toBe(false);
    expect(result.fail_reasons).toHaveLength(3);
    expect(result.fail_reasons[0]).toMatch(/Insufficient agents/);
    expect(result.fail_reasons[1]).toMatch(/Insufficient history/);
    expect(result.fail_reasons[2]).toMatch(/Test rows detected/);
  });

  it('preserves original stats in result', () => {
    const stats: GateStats = {
      agent_count: 1,
      date_range_days: 3,
      has_test_rows: true,
      test_agents: ['bot-a'],
    };
    const result = evaluateGates(stats);
    expect(result.stats).toEqual(stats);
  });
});
