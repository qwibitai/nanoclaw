import { describe, expect, it } from 'vitest';
import {
  extractPrNumber,
  extractPrUrl,
  extractRepoFlag,
  isGhPrCommand,
  isGitCommand,
  reconstructPrUrl,
  stripHeredocBody,
} from './parse-command.js';

describe('stripHeredocBody', () => {
  it('returns command unchanged when no heredoc', () => {
    expect(stripHeredocBody('gh pr create --title "test"')).toBe(
      'gh pr create --title "test"',
    );
  });

  it('strips heredoc body with single-quoted delimiter', () => {
    const cmd = `gh pr create --body "$(cat <<'EOF'\nsome body\nEOF\n)"`;
    const result = stripHeredocBody(cmd);
    expect(result).toContain('gh pr create');
    expect(result).toContain("<<'EOF'");
    expect(result).not.toContain('some body');
  });

  it('strips heredoc body with unquoted delimiter', () => {
    const cmd = `echo test\ncat <<HEREDOC\nline1\nline2\nHEREDOC`;
    const result = stripHeredocBody(cmd);
    expect(result).toContain('<<HEREDOC');
  });

  it('strips heredoc body with dash operator', () => {
    const cmd = `cat <<-EOF\n\tindented\nEOF`;
    const result = stripHeredocBody(cmd);
    expect(result).toContain('<<-EOF');
  });
});

describe('isGhPrCommand', () => {
  it('detects gh pr create', () => {
    expect(isGhPrCommand('gh pr create --title "test"', 'create')).toBe(true);
  });

  it('detects gh pr merge', () => {
    expect(isGhPrCommand('gh pr merge 42 --squash', 'merge')).toBe(true);
  });

  it('detects either create or merge with alternation', () => {
    expect(isGhPrCommand('gh pr create --title "x"', 'create|merge')).toBe(
      true,
    );
    expect(isGhPrCommand('gh pr merge 42', 'create|merge')).toBe(true);
  });

  it('rejects non-PR commands', () => {
    expect(isGhPrCommand('npm run build', 'create')).toBe(false);
    expect(isGhPrCommand('echo "gh pr create"', 'create')).toBe(false);
  });

  it('handles piped commands', () => {
    expect(isGhPrCommand('echo test | gh pr create --title x', 'create')).toBe(
      true,
    );
  });

  it('handles chained commands', () => {
    expect(
      isGhPrCommand('npm run build && gh pr create --title x', 'create'),
    ).toBe(true);
  });
});

describe('isGitCommand', () => {
  it('detects git push', () => {
    expect(isGitCommand('git push -u origin main', 'push')).toBe(true);
  });

  it('detects git -C <path> push', () => {
    expect(isGitCommand('git -C /some/path push origin main', 'push')).toBe(
      true,
    );
  });

  it('rejects non-git commands', () => {
    expect(isGitCommand('npm run build', 'push')).toBe(false);
  });
});

describe('extractPrNumber', () => {
  it('extracts PR number from merge command', () => {
    expect(extractPrNumber('gh pr merge 42 --squash', 'merge')).toBe('42');
  });

  it('extracts PR number from merge with URL', () => {
    expect(
      extractPrNumber('gh pr merge 123 --repo Garsson-io/nanoclaw', 'merge'),
    ).toBe('123');
  });

  it('returns undefined when no PR number', () => {
    expect(extractPrNumber('gh pr merge --squash', 'merge')).toBeUndefined();
  });
});

describe('extractRepoFlag', () => {
  it('extracts --repo flag', () => {
    expect(
      extractRepoFlag('gh pr create --repo Garsson-io/nanoclaw --title test'),
    ).toBe('Garsson-io/nanoclaw');
  });

  it('returns undefined when no --repo flag', () => {
    expect(extractRepoFlag('gh pr create --title test')).toBeUndefined();
  });
});

describe('extractPrUrl', () => {
  it('extracts GitHub PR URL from text', () => {
    expect(
      extractPrUrl(
        'Created PR: https://github.com/Garsson-io/nanoclaw/pull/42',
      ),
    ).toBe('https://github.com/Garsson-io/nanoclaw/pull/42');
  });

  it('returns undefined for text without PR URL', () => {
    expect(extractPrUrl('No URL here')).toBeUndefined();
  });
});

describe('reconstructPrUrl', () => {
  it('extracts from stdout first', () => {
    expect(
      reconstructPrUrl(
        'gh pr create',
        'https://github.com/Garsson-io/nanoclaw/pull/42',
        '',
        'create',
      ),
    ).toBe('https://github.com/Garsson-io/nanoclaw/pull/42');
  });

  it('falls back to stderr', () => {
    expect(
      reconstructPrUrl(
        'gh pr create',
        '',
        'https://github.com/Garsson-io/nanoclaw/pull/42',
        'create',
      ),
    ).toBe('https://github.com/Garsson-io/nanoclaw/pull/42');
  });

  it('falls back to command args', () => {
    expect(
      reconstructPrUrl(
        'gh pr merge https://github.com/Garsson-io/nanoclaw/pull/42 --squash',
        '✓ Merged',
        '',
        'merge',
      ),
    ).toBe('https://github.com/Garsson-io/nanoclaw/pull/42');
  });

  it('reconstructs from --repo + PR number', () => {
    expect(
      reconstructPrUrl(
        'gh pr merge 42 --repo Garsson-io/nanoclaw --squash',
        '✓ Merged',
        '',
        'merge',
      ),
    ).toBe('https://github.com/Garsson-io/nanoclaw/pull/42');
  });

  it('reconstructs from PR number + git remote', () => {
    expect(
      reconstructPrUrl(
        'gh pr merge 42 --squash',
        '✓ Merged',
        '',
        'merge',
        'Garsson-io/nanoclaw',
      ),
    ).toBe('https://github.com/Garsson-io/nanoclaw/pull/42');
  });

  it('returns undefined when no URL can be reconstructed', () => {
    expect(
      reconstructPrUrl('gh pr merge --squash', '✓ Merged', '', 'merge'),
    ).toBeUndefined();
  });
});
