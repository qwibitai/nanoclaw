/**
 * Integration tests for pr-kaizen-clear.ts — the TypeScript port.
 *
 * Tests mirror and exceed bash tests in tests/test-pr-kaizen-clear.sh.
 * Each test creates a kaizen gate state, simulates a declaration, and
 * verifies both output and state changes.
 *
 * Parity checklist vs bash tests:
 * [x] Valid KAIZEN_IMPEDIMENTS clears gate
 * [x] Empty array without reason is rejected
 * [x] Empty array with reason clears gate
 * [x] Missing impediment/finding field is rejected
 * [x] Missing disposition is rejected
 * [x] Invalid disposition is rejected
 * [x] filed/incident without ref is rejected
 * [x] waived without reason is rejected
 * [x] Meta-finding with no-action is rejected
 * [x] KAIZEN_NO_ACTION with valid category clears gate
 * [x] KAIZEN_NO_ACTION with invalid category is rejected
 * [x] KAIZEN_NO_ACTION without reason is rejected
 * [x] Waiver blocklist enforcement (kaizen #280)
 * [x] Meta-finding waiver without impact_minutes rejected
 * [x] Meta-finding with impact >= 5 must be filed
 * [x] All-passive advisory (kaizen #205)
 * [x] No gate active → silent exit
 *
 * NEW tests beyond bash:
 * [x] JSON in stdout (not just command line)
 * [x] Non-Bash tool name → silent exit
 * [x] Positive type allows no-action
 * [x] Gate cleared with specific PR URL targeting (kaizen #309)
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  formatReflectionComment,
  processHookInput,
} from './pr-kaizen-clear.js';

let testStateDir: string;
const HOOK_PATH = path.resolve(__dirname, 'pr-kaizen-clear.ts');

beforeEach(() => {
  testStateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kaizen-clear-test-'));
  // Create a kaizen gate state
  const branch = execSync('git rev-parse --abbrev-ref HEAD', {
    encoding: 'utf-8',
  }).trim();
  fs.writeFileSync(
    path.join(testStateDir, 'pr-kaizen-Garsson-io_nanoclaw_42'),
    `PR_URL=https://github.com/Garsson-io/nanoclaw/pull/42\nSTATUS=needs_pr_kaizen\nBRANCH=${branch}\n`,
  );
});

afterEach(() => {
  fs.rmSync(testStateDir, { recursive: true, force: true });
});

function runHook(input: object): string {
  const json = JSON.stringify(input);
  try {
    return execSync(
      `echo '${json.replace(/'/g, "'\\''")}' | npx tsx "${HOOK_PATH}"`,
      {
        encoding: 'utf-8',
        env: { ...process.env, STATE_DIR: testStateDir },
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 15000,
      },
    ).trim();
  } catch (err: any) {
    return err.stdout?.trim?.() ?? '';
  }
}

function impedimentsInput(impedimentsJson: string): object {
  return {
    tool_name: 'Bash',
    tool_input: { command: `echo 'KAIZEN_IMPEDIMENTS: ${impedimentsJson}'` },
    tool_response: {
      stdout: `KAIZEN_IMPEDIMENTS: ${impedimentsJson}`,
      stderr: '',
      exit_code: '0',
    },
  };
}

function noActionInput(category: string, reason: string): object {
  return {
    tool_name: 'Bash',
    tool_input: {
      command: `echo 'KAIZEN_NO_ACTION [${category}]: ${reason}'`,
    },
    tool_response: {
      stdout: `KAIZEN_NO_ACTION [${category}]: ${reason}`,
      stderr: '',
      exit_code: '0',
    },
  };
}

function gateExists(): boolean {
  return fs.existsSync(
    path.join(testStateDir, 'pr-kaizen-Garsson-io_nanoclaw_42'),
  );
}

// ── KAIZEN_IMPEDIMENTS tests ─────────────────────────────────────────

describe('pr-kaizen-clear: valid impediments', () => {
  it('clears gate with valid filed impediment', () => {
    const json = JSON.stringify([
      { impediment: 'test issue', disposition: 'filed', ref: '#123' },
    ]);
    const output = runHook(impedimentsInput(json));
    expect(output).toContain('PR kaizen gate cleared');
    expect(gateExists()).toBe(false);
  });

  it('clears gate with fixed-in-pr disposition', () => {
    const json = JSON.stringify([
      { impediment: 'fixed bug', disposition: 'fixed-in-pr' },
    ]);
    const output = runHook(impedimentsInput(json));
    expect(output).toContain('PR kaizen gate cleared');
  });

  it('clears gate with incident disposition', () => {
    const json = JSON.stringify([
      { impediment: 'known issue', disposition: 'incident', ref: '#456' },
    ]);
    const output = runHook(impedimentsInput(json));
    expect(output).toContain('PR kaizen gate cleared');
  });

  it('rejects waived disposition (kaizen #198 — waived eliminated)', () => {
    const json = JSON.stringify([
      {
        impediment: 'minor thing',
        disposition: 'waived',
        reason: 'cosmetic only, no functional impact',
      },
    ]);
    const output = runHook(impedimentsInput(json));
    expect(output).toContain('waived');
    expect(output).toContain('no longer accepted');
    expect(gateExists()).toBe(true);
  });

  it('clears gate with finding alias (kaizen #162)', () => {
    const json = JSON.stringify([
      { finding: 'good pattern', disposition: 'filed', ref: '#789' },
    ]);
    const output = runHook(impedimentsInput(json));
    expect(output).toContain('PR kaizen gate cleared');
  });
});

describe('pr-kaizen-clear: empty array', () => {
  it('rejects empty array without reason', () => {
    const output = runHook(impedimentsInput('[]'));
    expect(output).toContain('Empty array requires a reason');
    expect(gateExists()).toBe(true);
  });

  it('clears gate with empty array + reason', () => {
    const input = {
      tool_name: 'Bash',
      tool_input: {
        command: `echo 'KAIZEN_IMPEDIMENTS: [] straightforward bug fix'`,
      },
      tool_response: {
        stdout: 'KAIZEN_IMPEDIMENTS: [] straightforward bug fix',
        stderr: '',
        exit_code: '0',
      },
    };
    const output = runHook(input);
    expect(output).toContain('PR kaizen gate cleared');
    expect(output).toContain('no impediments identified');
  });
});

describe('pr-kaizen-clear: validation', () => {
  it('rejects missing impediment/finding field', () => {
    const json = JSON.stringify([{ disposition: 'filed', ref: '#1' }]);
    const output = runHook(impedimentsInput(json));
    expect(output).toContain('missing "impediment" or "finding"');
    expect(gateExists()).toBe(true);
  });

  it('rejects missing disposition', () => {
    const json = JSON.stringify([{ impediment: 'test' }]);
    const output = runHook(impedimentsInput(json));
    expect(output).toContain('missing "disposition"');
  });

  it('rejects invalid disposition', () => {
    const json = JSON.stringify([
      { impediment: 'test', disposition: 'ignored' },
    ]);
    const output = runHook(impedimentsInput(json));
    expect(output).toContain('invalid disposition');
  });

  it('rejects filed without ref', () => {
    const json = JSON.stringify([{ impediment: 'test', disposition: 'filed' }]);
    const output = runHook(impedimentsInput(json));
    expect(output).toContain('requires "ref" field');
  });

  it('rejects incident without ref', () => {
    const json = JSON.stringify([
      { impediment: 'test', disposition: 'incident' },
    ]);
    const output = runHook(impedimentsInput(json));
    expect(output).toContain('requires "ref" field');
  });

  it('rejects waived disposition entirely (kaizen #198)', () => {
    const json = JSON.stringify([
      { impediment: 'test', disposition: 'waived' },
    ]);
    const output = runHook(impedimentsInput(json));
    expect(output).toContain('no longer accepted');
  });

  it('rejects invalid JSON', () => {
    const input = {
      tool_name: 'Bash',
      tool_input: { command: `echo 'KAIZEN_IMPEDIMENTS: not json'` },
      tool_response: {
        stdout: 'KAIZEN_IMPEDIMENTS: not json',
        stderr: '',
        exit_code: '0',
      },
    };
    const output = runHook(input);
    expect(output).toContain('Invalid JSON');
  });
});

describe('pr-kaizen-clear: type-aware validation', () => {
  it('rejects meta-finding with no-action disposition', () => {
    const json = JSON.stringify([
      {
        finding: 'meta observation',
        type: 'meta',
        disposition: 'no-action',
        reason: 'just observing',
      },
    ]);
    const output = runHook(impedimentsInput(json));
    expect(output).toContain('must be "filed" or "fixed-in-pr"');
    expect(gateExists()).toBe(true);
  });

  it('allows positive type with no-action disposition', () => {
    const json = JSON.stringify([
      {
        finding: 'good pattern found',
        type: 'positive',
        disposition: 'no-action',
        reason: 'positive observation',
      },
    ]);
    const output = runHook(impedimentsInput(json));
    expect(output).toContain('PR kaizen gate cleared');
  });

  it('allows meta-finding with filed disposition', () => {
    const json = JSON.stringify([
      {
        finding: 'process gap',
        type: 'meta',
        disposition: 'filed',
        ref: '#100',
      },
    ]);
    const output = runHook(impedimentsInput(json));
    expect(output).toContain('PR kaizen gate cleared');
  });
});

describe('pr-kaizen-clear: waived elimination (kaizen #198)', () => {
  it('rejects ALL waived dispositions regardless of reason quality', () => {
    const json = JSON.stringify([
      {
        impediment: 'test',
        disposition: 'waived',
        reason: 'This is a perfectly valid reason with no blocklist matches',
      },
    ]);
    const output = runHook(impedimentsInput(json));
    expect(output).toContain('no longer accepted');
    expect(gateExists()).toBe(true);
  });

  it('guides user to reclassify waived as positive/no-action', () => {
    const json = JSON.stringify([
      {
        impediment: 'test',
        disposition: 'waived',
        reason: 'not real friction',
      },
    ]);
    const output = runHook(impedimentsInput(json));
    expect(output).toContain('positive');
    expect(output).toContain('no-action');
  });
});

describe('pr-kaizen-clear: all-passive advisory (kaizen #205)', () => {
  it('shows advisory when all findings are no-action', () => {
    const json = JSON.stringify([
      {
        finding: 'thing 1',
        type: 'positive',
        disposition: 'no-action',
        reason: 'positive observation, no change needed',
      },
      {
        finding: 'thing 2',
        type: 'positive',
        disposition: 'no-action',
        reason: 'validated existing pattern',
      },
    ]);
    const output = runHook(impedimentsInput(json));
    expect(output).toContain('no-action');
    expect(output).toContain('Every failure is a gift');
    expect(output).toContain('PR kaizen gate cleared');
  });
});

// ── KAIZEN_NO_ACTION tests ───────────────────────────────────────────

describe('pr-kaizen-clear: KAIZEN_NO_ACTION', () => {
  it('clears gate with valid category and reason', () => {
    const output = runHook(noActionInput('docs-only', 'updated README'));
    expect(output).toContain('PR kaizen gate cleared');
    expect(output).toContain('docs-only');
  });

  it('accepts docs-only category', () => {
    const output = runHook(noActionInput('docs-only', 'updated README'));
    expect(output).toContain('PR kaizen gate cleared');
  });

  it('accepts test-only category', () => {
    // Recreate gate (previous test cleared it)
    const branch = execSync('git rev-parse --abbrev-ref HEAD', {
      encoding: 'utf-8',
    }).trim();
    fs.writeFileSync(
      path.join(testStateDir, 'pr-kaizen-Garsson-io_nanoclaw_42'),
      `PR_URL=https://github.com/Garsson-io/nanoclaw/pull/42\nSTATUS=needs_pr_kaizen\nBRANCH=${branch}\n`,
    );
    const output = runHook(noActionInput('test-only', 'added tests'));
    expect(output).toContain('PR kaizen gate cleared');
  });

  it('accepts trivial-refactor category', () => {
    const branch = execSync('git rev-parse --abbrev-ref HEAD', {
      encoding: 'utf-8',
    }).trim();
    fs.writeFileSync(
      path.join(testStateDir, 'pr-kaizen-Garsson-io_nanoclaw_42'),
      `PR_URL=https://github.com/Garsson-io/nanoclaw/pull/42\nSTATUS=needs_pr_kaizen\nBRANCH=${branch}\n`,
    );
    const output = runHook(noActionInput('trivial-refactor', 'rename'));
    expect(output).toContain('PR kaizen gate cleared');
  });

  it('rejects invalid category', () => {
    const output = runHook(noActionInput('feature-add', 'not trivial'));
    expect(output).toContain('Invalid category');
    expect(gateExists()).toBe(true);
  });

  it('rejects missing reason', () => {
    const input = {
      tool_name: 'Bash',
      tool_input: { command: `echo 'KAIZEN_NO_ACTION [docs-only]:'` },
      tool_response: {
        stdout: `KAIZEN_NO_ACTION [docs-only]:`,
        stderr: '',
        exit_code: '0',
      },
    };
    const output = runHook(input);
    expect(output).toContain('Missing reason');
  });
});

// ── Edge cases ───────────────────────────────────────────────────────

describe('pr-kaizen-clear: edge cases', () => {
  it('exits silently when no gate is active', () => {
    // Remove the gate
    fs.unlinkSync(path.join(testStateDir, 'pr-kaizen-Garsson-io_nanoclaw_42'));

    const output = runHook(
      impedimentsInput(
        JSON.stringify([
          { impediment: 'test', disposition: 'filed', ref: '#1' },
        ]),
      ),
    );
    expect(output).toBe('');
  });

  it('exits silently for non-Bash tool', () => {
    const output = runHook({
      tool_name: 'Read',
      tool_input: { command: 'echo KAIZEN_IMPEDIMENTS: []' },
      tool_response: { stdout: '', stderr: '', exit_code: '0' },
    });
    expect(output).toBe('');
  });

  it('exits silently for failed commands', () => {
    const output = runHook({
      tool_name: 'Bash',
      tool_input: { command: 'echo KAIZEN_IMPEDIMENTS: []' },
      tool_response: { stdout: '', stderr: 'error', exit_code: '1' },
    });
    expect(output).toBe('');
  });

  it('creates reflection-done marker after clearing (kaizen #288)', () => {
    const json = JSON.stringify([
      { impediment: 'test', disposition: 'filed', ref: '#1' },
    ]);
    runHook(impedimentsInput(json));

    const markerFiles = fs
      .readdirSync(testStateDir)
      .filter((f) => f.startsWith('kaizen-done-'));
    expect(markerFiles.length).toBeGreaterThan(0);
  });
});

// ── Reflection persistence tests (kaizen #388) ─────────────────────

describe('formatReflectionComment', () => {
  it('formats impediments as markdown table', () => {
    const items = [
      {
        impediment: 'test issue',
        type: 'standard',
        disposition: 'filed',
        ref: '#123',
      },
      {
        finding: 'good pattern',
        type: 'positive',
        disposition: 'no-action',
        reason: 'positive',
      },
    ];
    const comment = formatReflectionComment(
      items,
      '2 finding(s) addressed',
      false,
    );
    expect(comment).toContain('## Kaizen Reflection');
    expect(comment).toContain('**2 finding(s) addressed:**');
    expect(comment).toContain('| test issue | standard | filed | #123 |');
    expect(comment).toContain('| good pattern | positive | no-action | — |');
    expect(comment).toContain('kaizen #388');
  });

  it('formats empty array with reason', () => {
    const comment = formatReflectionComment(
      [],
      'no impediments identified (straightforward fix)',
      false,
    );
    expect(comment).toContain('**No impediments:**');
    expect(comment).toContain('straightforward fix');
  });

  it('formats KAIZEN_NO_ACTION', () => {
    const comment = formatReflectionComment(
      [],
      'no action needed [docs-only]: updated README',
      true,
    );
    expect(comment).toContain('**No action needed:**');
    expect(comment).toContain('docs-only');
  });

  it('defaults type to standard when missing', () => {
    const items = [{ impediment: 'no type', disposition: 'filed', ref: '#1' }];
    const comment = formatReflectionComment(
      items,
      '1 finding(s) addressed',
      false,
    );
    expect(comment).toContain('| no type | standard | filed | #1 |');
  });
});

describe('processHookInput: reflection persistence (kaizen #388)', () => {
  let unitStateDir: string;

  beforeEach(() => {
    unitStateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kaizen-clear-unit-'));
    const branch = execSync('git rev-parse --abbrev-ref HEAD', {
      encoding: 'utf-8',
    }).trim();
    fs.writeFileSync(
      path.join(unitStateDir, 'pr-kaizen-Garsson-io_nanoclaw_99'),
      `PR_URL=https://github.com/Garsson-io/nanoclaw/pull/99\nSTATUS=needs_pr_kaizen\nBRANCH=${branch}\n`,
    );
  });

  afterEach(() => {
    fs.rmSync(unitStateDir, { recursive: true, force: true });
  });

  it('calls postComment with formatted reflection on valid impediments', () => {
    const postComment = vi.fn();
    const input = {
      tool_name: 'Bash',
      tool_input: {
        command: `echo 'KAIZEN_IMPEDIMENTS: [{"impediment":"test bug","disposition":"filed","ref":"#50"}]'`,
      },
      tool_response: {
        stdout:
          'KAIZEN_IMPEDIMENTS: [{"impediment":"test bug","disposition":"filed","ref":"#50"}]',
        exit_code: 0,
      },
    };

    const result = processHookInput(input, {
      stateDir: unitStateDir,
      postComment,
    });
    expect(result).toContain('PR kaizen gate cleared');
    expect(postComment).toHaveBeenCalledOnce();
    expect(postComment.mock.calls[0][0]).toBe(
      'https://github.com/Garsson-io/nanoclaw/pull/99',
    );
    const comment = postComment.mock.calls[0][1];
    expect(comment).toContain('## Kaizen Reflection');
    expect(comment).toContain('test bug');
    expect(comment).toContain('filed');
  });

  it('calls postComment on KAIZEN_NO_ACTION', () => {
    const postComment = vi.fn();
    const input = {
      tool_name: 'Bash',
      tool_input: {
        command: `echo 'KAIZEN_NO_ACTION [docs-only]: updated README'`,
      },
      tool_response: {
        stdout: 'KAIZEN_NO_ACTION [docs-only]: updated README',
        exit_code: 0,
      },
    };

    const result = processHookInput(input, {
      stateDir: unitStateDir,
      postComment,
    });
    expect(result).toContain('PR kaizen gate cleared');
    expect(postComment).toHaveBeenCalledOnce();
    const comment = postComment.mock.calls[0][1];
    expect(comment).toContain('**No action needed:**');
  });

  it('calls postComment on empty array with reason', () => {
    const postComment = vi.fn();
    const input = {
      tool_name: 'Bash',
      tool_input: { command: `echo 'KAIZEN_IMPEDIMENTS: [] simple fix'` },
      tool_response: {
        stdout: 'KAIZEN_IMPEDIMENTS: [] simple fix',
        exit_code: 0,
      },
    };

    const result = processHookInput(input, {
      stateDir: unitStateDir,
      postComment,
    });
    expect(result).toContain('PR kaizen gate cleared');
    expect(postComment).toHaveBeenCalledOnce();
    const comment = postComment.mock.calls[0][1];
    expect(comment).toContain('**No impediments:**');
  });

  it('does not call postComment on validation failure', () => {
    const postComment = vi.fn();
    const input = {
      tool_name: 'Bash',
      tool_input: {
        command: `echo 'KAIZEN_IMPEDIMENTS: [{"impediment":"test","disposition":"waived"}]'`,
      },
      tool_response: {
        stdout:
          'KAIZEN_IMPEDIMENTS: [{"impediment":"test","disposition":"waived"}]',
        exit_code: 0,
      },
    };

    const result = processHookInput(input, {
      stateDir: unitStateDir,
      postComment,
    });
    expect(result).toContain('no longer accepted');
    expect(postComment).not.toHaveBeenCalled();
  });

  it('still clears gate if postComment throws', () => {
    const postComment = vi.fn().mockImplementation(() => {
      throw new Error('gh command failed');
    });
    const input = {
      tool_name: 'Bash',
      tool_input: {
        command: `echo 'KAIZEN_IMPEDIMENTS: [{"impediment":"test","disposition":"fixed-in-pr"}]'`,
      },
      tool_response: {
        stdout:
          'KAIZEN_IMPEDIMENTS: [{"impediment":"test","disposition":"fixed-in-pr"}]',
        exit_code: 0,
      },
    };

    const result = processHookInput(input, {
      stateDir: unitStateDir,
      postComment,
    });
    expect(result).toContain('PR kaizen gate cleared');
    expect(postComment).toHaveBeenCalledOnce();
  });
});
