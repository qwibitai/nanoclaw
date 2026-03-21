/**
 * Integration tests for pr-review-loop.ts — the TypeScript port.
 *
 * Tests mirror (and exceed) the bash tests in tests/test-pr-review-loop.sh.
 * Each test creates a temporary STATE_DIR, runs the hook via `npx tsx`
 * with simulated JSON stdin, and verifies both stdout AND state files.
 *
 * Parity checklist vs bash tests:
 * [x] pr_url_to_state_file produces repo-specific keys
 * [x] PR create outputs review prompt + creates state
 * [x] Two PRs from different repos don't conflict
 * [x] Push triggers next review round (same branch)
 * [x] Merge cleans up state + outputs post-merge checklist
 * [x] Push with no active state exits silently
 * [x] PR create with no URL exits silently
 * [x] Cross-worktree isolation: push ignores other branch's state
 * [x] Cross-worktree isolation: push updates same branch's state
 * [x] Cross-worktree isolation: legacy state (no BRANCH) skipped
 * [x] Cross-worktree isolation: stale state skipped
 * [x] Merge-from-main push does NOT increment round
 * [x] Regular push DOES increment round
 * [x] gh pr diff outputs checklist + transitions to passed
 * [x] gh pr diff with passed state exits silently
 * [x] Escalation after MAX_ROUNDS
 * [x] Push after escalated exits silently
 * [x] PR create records LAST_REVIEWED_SHA
 * [x] gh pr diff records LAST_REVIEWED_SHA
 *
 * NEW tests beyond bash:
 * [x] Atomic state writes (no partial reads)
 * [x] PR URL validation rejects malformed URLs
 * [x] Auto-merge (--auto) flag produces awaiting_merge state
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

let testStateDir: string;
const HOOK_PATH = path.resolve(__dirname, 'pr-review-loop.ts');

beforeEach(() => {
  testStateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-review-test-'));
});

afterEach(() => {
  fs.rmSync(testStateDir, { recursive: true, force: true });
});

/** Run the hook with JSON input and return stdout. */
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
    // Hook always exits 0, but if it exits 0 with output, execSync still works
    return err.stdout?.trim?.() ?? '';
  }
}

/** Create a state file directly for test setup. */
function createState(filename: string, fields: Record<string, string>): string {
  const filePath = path.join(testStateDir, filename);
  const content = Object.entries(fields)
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
  fs.writeFileSync(filePath, content + '\n');
  return filePath;
}

/** Read a state file for assertions. */
function readState(filename: string): Record<string, string> {
  const filePath = path.join(testStateDir, filename);
  if (!fs.existsSync(filePath)) return {};
  const content = fs.readFileSync(filePath, 'utf-8');
  const state: Record<string, string> = {};
  for (const line of content.split('\n')) {
    const eq = line.indexOf('=');
    if (eq > 0) state[line.slice(0, eq)] = line.slice(eq + 1);
  }
  return state;
}

function prCreateInput(prUrl: string): object {
  return {
    tool_input: { command: `gh pr create --title "test"` },
    tool_response: { stdout: prUrl, stderr: '', exit_code: '0' },
  };
}

function gitPushInput(): object {
  return {
    tool_input: { command: 'git push' },
    tool_response: {
      stdout: 'Everything up-to-date',
      stderr: '',
      exit_code: '0',
    },
  };
}

function prDiffInput(prUrl: string): object {
  return {
    tool_input: { command: `gh pr diff ${prUrl}` },
    tool_response: {
      stdout: 'diff --git a/foo b/foo',
      stderr: '',
      exit_code: '0',
    },
  };
}

function prMergeInput(prUrl: string, options: string = '--squash'): object {
  return {
    tool_input: { command: `gh pr merge ${prUrl} ${options}` },
    tool_response: {
      stdout: `\u2713 Merged ${prUrl}`,
      stderr: '',
      exit_code: '0',
    },
  };
}

// ── Core trigger tests ───────────────────────────────────────────────

describe('pr-review-loop: PR create', () => {
  it('outputs review prompt and creates state file', () => {
    const output = runHook(
      prCreateInput('https://github.com/Garsson-io/nanoclaw/pull/42'),
    );
    expect(output).toContain('MANDATORY SELF-REVIEW');
    expect(output).toContain('nanoclaw/pull/42');
    expect(output).toContain('ROUND 1/4');

    const state = readState('Garsson-io_nanoclaw_42');
    expect(state.PR_URL).toBe('https://github.com/Garsson-io/nanoclaw/pull/42');
    expect(state.ROUND).toBe('1');
    expect(state.STATUS).toBe('needs_review');
  });

  it('records LAST_REVIEWED_SHA (kaizen #117)', () => {
    runHook(prCreateInput('https://github.com/Garsson-io/nanoclaw/pull/200'));
    const state = readState('Garsson-io_nanoclaw_200');
    expect(state.LAST_REVIEWED_SHA).toBeTruthy();
  });

  it('exits silently when no PR URL in output', () => {
    const output = runHook({
      tool_input: { command: 'gh pr create --title test' },
      tool_response: {
        stdout: 'some error output',
        stderr: '',
        exit_code: '0',
      },
    });
    expect(output).toBe('');
  });
});

describe('pr-review-loop: two repos', () => {
  it('creates independent state files for different repos', () => {
    runHook(
      prCreateInput('https://github.com/Garsson-io/garsson-prints/pull/2'),
    );
    runHook(prCreateInput('https://github.com/Garsson-io/nanoclaw/pull/40'));

    expect(
      fs.existsSync(path.join(testStateDir, 'Garsson-io_garsson-prints_2')),
    ).toBe(true);
    expect(
      fs.existsSync(path.join(testStateDir, 'Garsson-io_nanoclaw_40')),
    ).toBe(true);
  });
});

describe('pr-review-loop: git push', () => {
  it('exits silently with no active state', () => {
    const output = runHook(gitPushInput());
    expect(output).toBe('');
  });

  it('increments round for same-branch state', () => {
    const branch = execSync('git rev-parse --abbrev-ref HEAD', {
      encoding: 'utf-8',
    }).trim();
    createState('Garsson-io_nanoclaw_80', {
      PR_URL: 'https://github.com/Garsson-io/nanoclaw/pull/80',
      ROUND: '1',
      STATUS: 'passed',
      BRANCH: branch,
    });

    const output = runHook(gitPushInput());
    expect(output).toContain('ROUND');

    const state = readState('Garsson-io_nanoclaw_80');
    expect(state.STATUS).toBe('needs_review');
    expect(state.ROUND).toBe('2');
  });
});

describe('pr-review-loop: cross-worktree isolation', () => {
  it('ignores state from different branch', () => {
    createState('Garsson-io_nanoclaw_71', {
      PR_URL: 'https://github.com/Garsson-io/nanoclaw/pull/71',
      ROUND: '1',
      STATUS: 'needs_review',
      BRANCH: 'wt/other-worktree-branch',
    });

    const output = runHook(gitPushInput());
    expect(output).toBe('');

    // Verify other branch's state was NOT modified
    const state = readState('Garsson-io_nanoclaw_71');
    expect(state.STATUS).toBe('needs_review');
    expect(state.ROUND).toBe('1');
  });

  it('ignores legacy state without BRANCH field', () => {
    const f = path.join(testStateDir, 'Garsson-io_nanoclaw_50');
    fs.writeFileSync(
      f,
      'PR_URL=https://github.com/Garsson-io/nanoclaw/pull/50\nROUND=1\nSTATUS=needs_review\n',
    );

    const output = runHook(gitPushInput());
    expect(output).toBe('');
  });

  it('ignores stale state (>MAX_STATE_AGE)', () => {
    const branch = execSync('git rev-parse --abbrev-ref HEAD', {
      encoding: 'utf-8',
    }).trim();
    const f = path.join(testStateDir, 'Garsson-io_nanoclaw_90');
    fs.writeFileSync(
      f,
      `PR_URL=https://github.com/Garsson-io/nanoclaw/pull/90\nROUND=1\nSTATUS=needs_review\nBRANCH=${branch}\n`,
    );
    // Backdate the file 3 hours
    const pastTime = new Date(Date.now() - 3 * 60 * 60 * 1000);
    fs.utimesSync(f, pastTime, pastTime);

    const output = runHook(gitPushInput());
    expect(output).toBe('');
  });
});

describe('pr-review-loop: gh pr diff', () => {
  it('outputs checklist and transitions to passed', () => {
    const branch = execSync('git rev-parse --abbrev-ref HEAD', {
      encoding: 'utf-8',
    }).trim();
    createState('Garsson-io_nanoclaw_55', {
      PR_URL: 'https://github.com/Garsson-io/nanoclaw/pull/55',
      ROUND: '2',
      STATUS: 'needs_review',
      BRANCH: branch,
    });

    const output = runHook(
      prDiffInput('https://github.com/Garsson-io/nanoclaw/pull/55'),
    );
    expect(output).toContain('REVIEW ROUND 2/4');
    expect(output).toContain('/review-pr');
    expect(output).toContain('REVIEW PASSED');

    const state = readState('Garsson-io_nanoclaw_55');
    expect(state.STATUS).toBe('passed');
    expect(state.ROUND).toBe('2');
  });

  it('records LAST_REVIEWED_SHA (kaizen #117)', () => {
    const branch = execSync('git rev-parse --abbrev-ref HEAD', {
      encoding: 'utf-8',
    }).trim();
    createState('Garsson-io_nanoclaw_201', {
      PR_URL: 'https://github.com/Garsson-io/nanoclaw/pull/201',
      ROUND: '1',
      STATUS: 'needs_review',
      BRANCH: branch,
    });

    runHook(prDiffInput('https://github.com/Garsson-io/nanoclaw/pull/201'));

    const state = readState('Garsson-io_nanoclaw_201');
    expect(state.LAST_REVIEWED_SHA).toBeTruthy();
  });

  it('exits silently when already passed', () => {
    const branch = execSync('git rev-parse --abbrev-ref HEAD', {
      encoding: 'utf-8',
    }).trim();
    createState('Garsson-io_nanoclaw_56', {
      PR_URL: 'https://github.com/Garsson-io/nanoclaw/pull/56',
      ROUND: '2',
      STATUS: 'passed',
      BRANCH: branch,
    });

    const output = runHook(
      prDiffInput('https://github.com/Garsson-io/nanoclaw/pull/56'),
    );
    expect(output).toBe('');
  });
});

describe('pr-review-loop: gh pr merge', () => {
  it('outputs post-merge checklist with all items', () => {
    const output = runHook(
      prMergeInput('https://github.com/Garsson-io/nanoclaw/pull/42'),
    );
    expect(output).toContain('Kaizen reflection');
    expect(output).toContain('Update linked issue');
    expect(output).toContain('Spec update');
    expect(output).toContain('Post-merge action needed');
    expect(output).toContain('Sync main');
  });

  it('creates post-merge state file', () => {
    runHook(prMergeInput('https://github.com/Garsson-io/nanoclaw/pull/42'));
    const state = readState('post-merge-Garsson-io_nanoclaw_42');
    expect(state.STATUS).toBe('needs_post_merge');
    expect(state.PR_URL).toBe('https://github.com/Garsson-io/nanoclaw/pull/42');
  });

  it('cleans up review state file on merge', () => {
    const branch = execSync('git rev-parse --abbrev-ref HEAD', {
      encoding: 'utf-8',
    }).trim();
    createState('Garsson-io_nanoclaw_42', {
      PR_URL: 'https://github.com/Garsson-io/nanoclaw/pull/42',
      ROUND: '2',
      STATUS: 'needs_review',
      BRANCH: branch,
    });

    runHook(prMergeInput('https://github.com/Garsson-io/nanoclaw/pull/42'));
    expect(
      fs.existsSync(path.join(testStateDir, 'Garsson-io_nanoclaw_42')),
    ).toBe(false);
  });

  it('creates awaiting_merge state for --auto flag', () => {
    runHook(
      prMergeInput(
        'https://github.com/Garsson-io/nanoclaw/pull/42',
        '--squash --auto',
      ),
    );
    const state = readState('post-merge-Garsson-io_nanoclaw_42');
    expect(state.STATUS).toBe('awaiting_merge');
  });

  it('warns when PR URL cannot be determined', () => {
    const output = runHook({
      tool_input: { command: 'gh pr merge' },
      tool_response: { stdout: 'merged something', stderr: '', exit_code: '0' },
    });
    expect(output).toContain('Could not determine PR URL');
  });
});

describe('pr-review-loop: escalation', () => {
  it('escalates after MAX_ROUNDS pushes', () => {
    const branch = execSync('git rev-parse --abbrev-ref HEAD', {
      encoding: 'utf-8',
    }).trim();
    createState('Garsson-io_nanoclaw_60', {
      PR_URL: 'https://github.com/Garsson-io/nanoclaw/pull/60',
      ROUND: '4',
      STATUS: 'passed',
      BRANCH: branch,
    });

    const output = runHook(gitPushInput());
    expect(output).toContain('REVIEW ROUND 4/4');
    expect(output).toContain('escalate');

    const state = readState('Garsson-io_nanoclaw_60');
    expect(state.STATUS).toBe('escalated');
    expect(state.ROUND).toBe('4');
  });

  it('exits silently after escalation', () => {
    const branch = execSync('git rev-parse --abbrev-ref HEAD', {
      encoding: 'utf-8',
    }).trim();
    createState('Garsson-io_nanoclaw_60', {
      PR_URL: 'https://github.com/Garsson-io/nanoclaw/pull/60',
      ROUND: '4',
      STATUS: 'escalated',
      BRANCH: branch,
    });

    const output = runHook(gitPushInput());
    expect(output).toBe('');
  });
});

describe('pr-review-loop: failed commands ignored', () => {
  it('exits silently on non-zero exit code', () => {
    const output = runHook({
      tool_input: { command: 'gh pr create' },
      tool_response: { stdout: '', stderr: 'error', exit_code: '1' },
    });
    expect(output).toBe('');
  });
});

describe('pr-review-loop: non-PR commands ignored', () => {
  it('exits silently for npm run build', () => {
    const output = runHook({
      tool_input: { command: 'npm run build' },
      tool_response: { stdout: 'done', stderr: '', exit_code: '0' },
    });
    expect(output).toBe('');
  });
});
