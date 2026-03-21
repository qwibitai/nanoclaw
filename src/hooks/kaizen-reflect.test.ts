import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HookInput } from './hook-io.js';
import {
  generateCreateReflection,
  generateMergeReflection,
  processHookInput,
} from './kaizen-reflect.js';

const TEST_STATE_DIR = '/tmp/.test-kaizen-reflect-ts';

beforeEach(() => {
  if (existsSync(TEST_STATE_DIR)) {
    rmSync(TEST_STATE_DIR, { recursive: true });
  }
  mkdirSync(TEST_STATE_DIR, { recursive: true });
});

afterEach(() => {
  if (existsSync(TEST_STATE_DIR)) {
    rmSync(TEST_STATE_DIR, { recursive: true });
  }
});

function makeInput(overrides: {
  command?: string;
  stdout?: string;
  stderr?: string;
  exit_code?: number;
}): HookInput {
  return {
    tool_name: 'Bash',
    tool_input: { command: overrides.command ?? 'echo test' },
    tool_response: {
      stdout: overrides.stdout ?? '',
      stderr: overrides.stderr ?? '',
      exit_code: overrides.exit_code ?? 0,
    },
  };
}

const defaultOpts = {
  stateDir: TEST_STATE_DIR,
  branch: 'feat-test',
  repoFromGit: 'Garsson-io/nanoclaw',
  mainCheckout: '/home/user/projects/nanoclaw',
  changedFiles: 'src/hooks/kaizen-reflect.ts',
  sendNotification: vi.fn(),
};

describe('processHookInput', () => {
  describe('gh pr create', () => {
    it('creates state file and returns reflection output', () => {
      const input = makeInput({
        command: 'gh pr create --title "test" --body "test"',
        stdout: 'https://github.com/Garsson-io/nanoclaw/pull/42',
      });

      const output = processHookInput(input, defaultOpts);

      expect(output).not.toBeNull();
      expect(output).toContain('KAIZEN REFLECTION');
      expect(output).toContain('Post-PR Creation');
      expect(output).toContain('kaizen-bg');
      expect(output).toContain('run_in_background');
      expect(output).toContain('pull/42');

      // State file should be created
      const stateFiles = readdirSync(TEST_STATE_DIR).filter((f) =>
        f.startsWith('pr-kaizen-'),
      );
      expect(stateFiles).toHaveLength(1);
    });

    it('includes KAIZEN_IMPEDIMENTS format', () => {
      const input = makeInput({
        command: 'gh pr create --title "test"',
        stdout: 'https://github.com/Garsson-io/nanoclaw/pull/42',
      });

      const output = processHookInput(input, defaultOpts);
      expect(output).toContain('KAIZEN_IMPEDIMENTS');
    });

    it('includes Agent tool instructions', () => {
      const input = makeInput({
        command: 'gh pr create --title "test"',
        stdout: 'https://github.com/Garsson-io/nanoclaw/pull/42',
      });

      const output = processHookInput(input, defaultOpts);
      expect(output).toContain('Agent');
      expect(output).toContain('background');
    });
  });

  describe('gh pr merge', () => {
    it('creates state file and returns merge reflection output', () => {
      const sendNotification = vi.fn();
      const input = makeInput({
        command:
          'gh pr merge https://github.com/Garsson-io/nanoclaw/pull/42 --squash --delete-branch --auto',
        stdout: '✓ Pull request merged',
      });

      const output = processHookInput(input, {
        ...defaultOpts,
        sendNotification,
      });

      expect(output).not.toBeNull();
      expect(output).toContain('KAIZEN REFLECTION');
      expect(output).toContain('Post-Merge');
      expect(output).toContain('kaizen-bg');
      expect(output).toContain('post-merge steps');
    });

    it('sends Telegram notification on merge', () => {
      const sendNotification = vi.fn();
      const input = makeInput({
        command:
          'gh pr merge https://github.com/Garsson-io/nanoclaw/pull/42 --squash',
        stdout: '✓ Pull request merged',
      });

      processHookInput(input, { ...defaultOpts, sendNotification });

      expect(sendNotification).toHaveBeenCalledTimes(1);
      expect(sendNotification).toHaveBeenCalledWith(
        expect.stringContaining('PR merged'),
      );
    });
  });

  describe('non-PR commands', () => {
    it('returns null for non-PR commands', () => {
      const input = makeInput({
        command: 'npm run build',
        stdout: 'done',
      });

      expect(processHookInput(input, defaultOpts)).toBeNull();
    });

    it('returns null for echo containing gh pr', () => {
      const input = makeInput({
        command: 'echo "gh pr create --title test"',
        stdout: '',
      });

      expect(processHookInput(input, defaultOpts)).toBeNull();
    });
  });

  describe('failed commands', () => {
    it('returns null for failed pr create', () => {
      const input = makeInput({
        command: 'gh pr create --title test',
        exit_code: 1,
        stderr: 'error',
      });

      expect(processHookInput(input, defaultOpts)).toBeNull();
    });
  });

  describe('empty PR URL', () => {
    it('returns null when PR URL cannot be extracted', () => {
      const input = makeInput({
        command: 'gh pr create --title test',
        stdout: 'Created pull request',
      });

      const output = processHookInput(input, {
        ...defaultOpts,
        repoFromGit: undefined,
      });

      expect(output).toBeNull();
    });
  });

  describe('duplicate reflection prevention', () => {
    it('skips reflection when already done for this PR', async () => {
      const prUrl = 'https://github.com/Garsson-io/nanoclaw/pull/42';
      const input = makeInput({
        command: 'gh pr create --title "test"',
        stdout: prUrl,
      });

      // First call should produce output
      const output1 = processHookInput(input, defaultOpts);
      expect(output1).not.toBeNull();

      // Simulate marking reflection done
      const { markReflectionDone } = await import('./state-utils.js');
      markReflectionDone(prUrl, 'feat-test', TEST_STATE_DIR);

      // Second call should be skipped
      const output2 = processHookInput(input, defaultOpts);
      expect(output2).toBeNull();
    });
  });
});

describe('generateCreateReflection', () => {
  it('includes PR URL and branch', () => {
    const output = generateCreateReflection(
      'https://github.com/test/repo/pull/1',
      'feat-branch',
      'file1.ts\nfile2.ts',
    );
    expect(output).toContain('pull/1');
    expect(output).toContain('feat-branch');
    expect(output).toContain('file1.ts');
  });

  it('mentions waived disposition elimination (#198)', () => {
    const output = generateCreateReflection('url', 'branch', 'files');
    expect(output).toContain('#198');
    expect(output).toContain('eliminated');
  });

  it('includes KAIZEN_NO_ACTION categories', () => {
    const output = generateCreateReflection('url', 'branch', 'files');
    expect(output).toContain('docs-only');
    expect(output).toContain('trivial-refactor');
  });
});

describe('generateMergeReflection', () => {
  it('includes post-merge steps', () => {
    const output = generateMergeReflection('url', 'branch', 'files', '/main');
    expect(output).toContain('post-merge steps');
    expect(output).toContain('Sync main');
    expect(output).toContain('/main');
  });
});
