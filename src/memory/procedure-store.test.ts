import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';

import { STORE_DIR, GROUPS_DIR } from '../config.js';
import {
  saveProcedure,
  findProcedure,
  listProcedures,
  updateProcedureStats,
  deleteProcedure,
} from './procedure-store.js';
import type { Procedure } from './procedure-store.js';

// Use the actual directories the module resolves from config,
// but clean them before/after each test.
const globalProcDir = path.join(STORE_DIR, 'procedures');
const groupProcDir = path.join(GROUPS_DIR, 'main', 'procedures');

function cleanDir(dir: string): void {
  if (fs.existsSync(dir)) {
    for (const f of fs.readdirSync(dir)) {
      if (f.endsWith('.json')) {
        fs.unlinkSync(path.join(dir, f));
      }
    }
  }
}

beforeEach(() => {
  fs.mkdirSync(globalProcDir, { recursive: true });
  fs.mkdirSync(groupProcDir, { recursive: true });
  cleanDir(globalProcDir);
  cleanDir(groupProcDir);
});

afterEach(() => {
  cleanDir(globalProcDir);
  cleanDir(groupProcDir);
});

function makeProcedure(overrides?: Partial<Procedure>): Procedure {
  const now = new Date().toISOString();
  return {
    name: 'test_procedure',
    trigger: 'test this thing',
    description: 'A test procedure',
    steps: [{ action: 'Do step 1' }, { action: 'Do step 2' }],
    success_count: 0,
    failure_count: 0,
    auto_execute: false,
    created_at: now,
    updated_at: now,
    ...overrides,
  };
}

describe('Procedure Store', () => {
  it('saves and finds a global procedure', () => {
    const proc = makeProcedure();
    saveProcedure(proc);

    const found = findProcedure('test this thing');
    expect(found).not.toBeNull();
    expect(found!.name).toBe('test_procedure');
    expect(found!.steps).toHaveLength(2);
  });

  it('saves and finds a group-specific procedure', () => {
    const proc = makeProcedure({
      name: 'group_proc',
      trigger: 'group action',
      groupId: 'main',
    });
    saveProcedure(proc);

    // Found when searching with groupId
    const found = findProcedure('group action', 'main');
    expect(found).not.toBeNull();
    expect(found!.name).toBe('group_proc');

    // Not found globally
    const globalSearch = findProcedure('group action');
    expect(globalSearch).toBeNull();
  });

  it('group-specific procedure takes priority over global', () => {
    saveProcedure(makeProcedure({ name: 'global_ver', trigger: 'do thing' }));
    saveProcedure(
      makeProcedure({
        name: 'group_ver',
        trigger: 'do thing',
        groupId: 'main',
        description: 'Group version',
      }),
    );

    const found = findProcedure('do thing', 'main');
    expect(found).not.toBeNull();
    expect(found!.name).toBe('group_ver');
  });

  it('lists all procedures', () => {
    saveProcedure(makeProcedure({ name: 'proc_a', trigger: 'trigger a' }));
    saveProcedure(makeProcedure({ name: 'proc_b', trigger: 'trigger b' }));

    const all = listProcedures();
    expect(all).toHaveLength(2);
  });

  it('lists global and group procedures together', () => {
    saveProcedure(makeProcedure({ name: 'global_one', trigger: 'g1' }));
    saveProcedure(
      makeProcedure({
        name: 'group_one',
        trigger: 'g2',
        groupId: 'main',
      }),
    );

    const all = listProcedures('main');
    expect(all).toHaveLength(2);
  });

  it('updates procedure stats', () => {
    saveProcedure(makeProcedure());

    updateProcedureStats('test_procedure', true);
    updateProcedureStats('test_procedure', true);
    updateProcedureStats('test_procedure', false);

    const found = findProcedure('test this thing');
    expect(found!.success_count).toBe(2);
    expect(found!.failure_count).toBe(1);
  });

  it('returns false for updating non-existent procedure', () => {
    const result = updateProcedureStats('nonexistent', true);
    expect(result).toBe(false);
  });

  it('deletes a procedure', () => {
    saveProcedure(makeProcedure());
    expect(deleteProcedure('test_procedure')).toBe(true);
    expect(findProcedure('test this thing')).toBeNull();
  });

  it('returns false when deleting non-existent procedure', () => {
    expect(deleteProcedure('nonexistent')).toBe(false);
  });

  it('handles case-insensitive trigger matching', () => {
    saveProcedure(makeProcedure({ trigger: 'Reorder Alto Refills' }));

    const found = findProcedure('reorder alto refills');
    expect(found).not.toBeNull();
  });

  describe('fuzzy matching', () => {
    it('matches procedures by keyword overlap', () => {
      saveProcedure({
        name: 'check-pr-status',
        trigger: 'check PR status',
        description: 'Check GitHub PR status',
        steps: [{ action: 'github_api', details: 'list PRs' }],
        success_count: 3,
        failure_count: 0,
        auto_execute: false,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });

      // Exact match works
      expect(findProcedure('check PR status')).not.toBeNull();

      // Fuzzy match: subset of trigger words
      expect(findProcedure('check PR')).not.toBeNull();
      expect(findProcedure('PR status check')).not.toBeNull();

      // Non-match: no overlapping keywords
      expect(findProcedure('deploy to production')).toBeNull();
    });
  });

  describe('auto-execute promotion', () => {
    it('promotes to auto_execute after 5 consecutive successes', () => {
      saveProcedure(makeProcedure({ success_count: 4, failure_count: 0 }));
      updateProcedureStats('test_procedure', true);
      const found = findProcedure('test this thing');
      expect(found!.auto_execute).toBe(true);
      expect(found!.success_count).toBe(5);
    });

    it('does not promote if any failures exist', () => {
      saveProcedure(makeProcedure({ success_count: 4, failure_count: 1 }));
      updateProcedureStats('test_procedure', true);
      const found = findProcedure('test this thing');
      expect(found!.auto_execute).toBe(false);
    });
  });

  describe('procedure deprecation', () => {
    it('deprecates after 3 consecutive failures with no successes', () => {
      saveProcedure(makeProcedure({ success_count: 0, failure_count: 2 }));
      updateProcedureStats('test_procedure', false);
      const found = findProcedure('test this thing');
      expect(found).toBeNull();
    });

    it('deprecates when failure rate exceeds 50% with 5+ runs', () => {
      saveProcedure(makeProcedure({ success_count: 2, failure_count: 2 }));
      updateProcedureStats('test_procedure', false);
      // failure_count = 3, total = 5, rate = 60% > 50%
      const found = findProcedure('test this thing');
      expect(found).toBeNull();
    });

    it('does not deprecate if under 5 total runs', () => {
      saveProcedure(makeProcedure({ success_count: 1, failure_count: 1 }));
      updateProcedureStats('test_procedure', false);
      // failure_count = 2, total = 3 (< 5), rate = 66% but under threshold
      const found = findProcedure('test this thing');
      expect(found).not.toBeNull();
    });
  });
});
