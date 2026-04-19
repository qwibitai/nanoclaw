import { describe, it, expect, beforeEach, vi } from 'vitest';

import { _initTestDatabase, getDb, logSessionCost } from '../db.js';
import { insertTrackedItem, type TrackedItem } from '../tracked-items.js';
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
      estimated_cost_usd: 0.1,
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
      estimated_cost_usd: 0.2,
    });

    const breakdown = getCostBreakdown(
      new Date(Date.now() - 86400000).toISOString(),
    );
    expect(breakdown).toHaveLength(2);

    const interactive = breakdown.find((b) => b.session_type === 'interactive');
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
      estimated_cost_usd: 4.2,
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
  it('executes cost report command', async () => {
    const result = await executeAssistantCommand({
      type: 'cost_report',
      days: 7,
    });
    expect(result).toContain('Cost report');
  });

  it('teaches a procedure scoped to a group', async () => {
    const cmd = parseAssistantCommand('teach: check PR status');
    expect(cmd).toEqual({ type: 'teach', description: 'check PR status' });
    const result = await executeAssistantCommand(cmd!, 'test-group');
    expect(result).toContain('Learned');
  });

  describe('archive_all', () => {
    function queuedGmailItem(
      id: string,
      threadId: string,
      account = 'topcoder1@gmail.com',
    ): TrackedItem {
      return {
        id,
        source: 'gmail',
        source_id: `gmail:${threadId}`,
        group_name: 'main',
        state: 'queued',
        classification: 'digest',
        superpilot_label: null,
        trust_tier: null,
        title: 'Test email',
        summary: null,
        thread_id: threadId,
        detected_at: Date.now(),
        pushed_at: null,
        resolved_at: null,
        resolution_method: null,
        digest_count: 0,
        telegram_message_id: null,
        classification_reason: null,
        metadata: { account },
      };
    }

    it('archives in Gmail before resolving locally', async () => {
      insertTrackedItem(queuedGmailItem('a', 'thread-a'));
      insertTrackedItem(queuedGmailItem('b', 'thread-b'));

      const archiveThread = vi.fn().mockResolvedValue(undefined);
      const result = await executeAssistantCommand(
        { type: 'archive_all' },
        undefined,
        { archiveThread },
      );

      expect(archiveThread).toHaveBeenCalledTimes(2);
      expect(result).toMatch(/Archived 2/);
      const rows = getDb()
        .prepare(
          `SELECT id, state, resolution_method FROM tracked_items ORDER BY id`,
        )
        .all() as Array<{ id: string; state: string; resolution_method: string }>;
      for (const r of rows) {
        expect(r.state).toBe('resolved');
        expect(r.resolution_method).toBe('manual:archive_all');
      }
    });

    it('leaves items queued when Gmail archive fails', async () => {
      insertTrackedItem(queuedGmailItem('fail', 'thread-fail'));
      insertTrackedItem(queuedGmailItem('ok', 'thread-ok'));

      const archiveThread = vi.fn(async (_acct: string, tid: string) => {
        if (tid === 'thread-fail') throw new Error('gmail 500');
      });
      const result = await executeAssistantCommand(
        { type: 'archive_all' },
        undefined,
        { archiveThread },
      );

      expect(result).toMatch(/Archived 1/);
      expect(result).toMatch(/1 item.*failed/);
      const fail = getDb()
        .prepare('SELECT state FROM tracked_items WHERE id = ?')
        .get('fail') as { state: string };
      const ok = getDb()
        .prepare('SELECT state FROM tracked_items WHERE id = ?')
        .get('ok') as { state: string };
      expect(fail.state).toBe('queued'); // stays queued — retry later
      expect(ok.state).toBe('resolved');
    });

    it('does not local-resolve gmail items when gmailOps is absent', async () => {
      // Safety net: if the chat-command path is wired up without a
      // gmailOps handle, we must NOT silently local-resolve — that's
      // the split-brain bug the PR review gate is designed to catch.
      insertTrackedItem(queuedGmailItem('x', 'thread-x'));
      const result = await executeAssistantCommand(
        { type: 'archive_all' },
        undefined,
        undefined,
      );
      expect(result).toMatch(/failed/i);
      const row = getDb()
        .prepare('SELECT state FROM tracked_items WHERE id = ?')
        .get('x') as { state: string };
      expect(row.state).toBe('queued');
    });
  });
});
