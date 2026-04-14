import { describe, it, expect, beforeEach } from 'vitest';

import { _initTestDatabase, logSessionCost } from '../db.js';
import {
  getCostBreakdown,
  formatCostReport,
  parseAssistantCommand,
  executeAssistantCommand,
} from './cost-dashboard.js';

beforeEach(() => {
  _initTestDatabase();
});

describe('Cost Dashboard', () => {
  it('returns empty breakdown with no data', () => {
    const breakdown = getCostBreakdown(
      new Date(Date.now() - 7 * 86400000).toISOString(),
    );
    expect(breakdown).toHaveLength(0);
  });

  it('aggregates costs by session type', () => {
    const now = new Date().toISOString();
    logSessionCost({
      session_type: 'interactive',
      group_folder: 'main',
      started_at: now,
      duration_ms: 5000,
      estimated_cost_usd: 0.10,
    });
    logSessionCost({
      session_type: 'interactive',
      group_folder: 'main',
      started_at: now,
      duration_ms: 3000,
      estimated_cost_usd: 0.05,
    });
    logSessionCost({
      session_type: 'scheduled',
      group_folder: 'main',
      started_at: now,
      duration_ms: 10000,
      estimated_cost_usd: 0.20,
    });

    const breakdown = getCostBreakdown(
      new Date(Date.now() - 86400000).toISOString(),
    );
    expect(breakdown).toHaveLength(2);

    const interactive = breakdown.find(
      (b) => b.session_type === 'interactive',
    );
    expect(interactive).toBeDefined();
    expect(interactive!.total_cost).toBeCloseTo(0.15, 2);
    expect(interactive!.task_count).toBe(2);
  });

  it('formats a cost report', () => {
    const now = new Date().toISOString();
    logSessionCost({
      session_type: 'interactive',
      group_folder: 'main',
      started_at: now,
      duration_ms: 5000,
      estimated_cost_usd: 4.20,
    });

    const report = formatCostReport(7);
    expect(report).toContain('Cost report');
    expect(report).toContain('Interactive');
    expect(report).toContain('$4.20');
    expect(report).toContain('Budget');
  });

  it('formats empty cost report', () => {
    const report = formatCostReport(7);
    expect(report).toContain('No activity recorded');
  });
});

describe('parseAssistantCommand', () => {
  it('parses "cost report"', () => {
    const cmd = parseAssistantCommand('cost report');
    expect(cmd).toEqual({ type: 'cost_report', days: 7 });
  });

  it('parses "cost report 30"', () => {
    const cmd = parseAssistantCommand('cost report 30');
    expect(cmd).toEqual({ type: 'cost_report', days: 30 });
  });

  it('parses "costs"', () => {
    const cmd = parseAssistantCommand('costs');
    expect(cmd).toEqual({ type: 'cost_report', days: 7 });
  });

  it('parses "teach: how to do something"', () => {
    const cmd = parseAssistantCommand('teach: how to do something');
    expect(cmd).toEqual({
      type: 'teach',
      description: 'how to do something',
    });
  });

  it('parses "teach how to do something" (without colon)', () => {
    const cmd = parseAssistantCommand('teach how to do something');
    expect(cmd).toEqual({
      type: 'teach',
      description: 'how to do something',
    });
  });

  it('returns null for unknown commands', () => {
    expect(parseAssistantCommand('hello world')).toBeNull();
    expect(parseAssistantCommand('trust status')).toBeNull();
  });
});

describe('executeAssistantCommand', () => {
  it('executes cost report command', () => {
    const result = executeAssistantCommand({ type: 'cost_report', days: 7 });
    expect(result).toContain('Cost report');
  });
});
