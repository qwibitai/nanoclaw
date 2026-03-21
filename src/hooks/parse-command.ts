/**
 * parse-command.ts — TypeScript port of .claude/kaizen/hooks/lib/parse-command.sh
 *
 * Shared utilities for parsing hook command inputs. Replaces fragile sed/grep
 * pipelines with proper string handling.
 */

/**
 * Strip heredoc body from a command string.
 * Heredocs (<<'EOF' ... EOF) can contain arbitrary text that causes
 * false positives when grepping for command patterns.
 * Returns the command text before the first heredoc delimiter.
 */
export function stripHeredocBody(command: string): string {
  const lines = command.split('\n');
  // Match heredoc operators: <<EOF, <<'EOF', <<"EOF", <<-EOF, etc.
  const heredocPattern = /<<\s*-?\s*['"]?[A-Za-z_][A-Za-z_0-9]*['"]?/;
  for (let i = 0; i < lines.length; i++) {
    if (heredocPattern.test(lines[i])) {
      // Return everything up to (and including) this line
      return lines.slice(0, i + 1).join('\n');
    }
  }
  return command;
}

/**
 * Split a command line by pipe/chain operators (|, &&, ||, ;)
 * and return individual segments trimmed.
 */
function splitCommandSegments(cmdLine: string): string[] {
  return cmdLine
    .split(/[|;&]{1,2}/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Check if a command line contains an actual `gh pr <subcommand>` invocation,
 * not just the text inside a string argument.
 */
export function isGhPrCommand(cmdLine: string, subcommand: string): boolean {
  const segments = splitCommandSegments(cmdLine);
  const pattern = new RegExp(`^gh\\s+pr\\s+(${subcommand})`);
  return segments.some((seg) => pattern.test(seg));
}

/**
 * Check if a command line contains an actual `git <subcommand>` invocation.
 * Handles `git -C <path> <subcommand>` by skipping the -C flag and its argument.
 */
export function isGitCommand(cmdLine: string, subcommand: string): boolean {
  const segments = splitCommandSegments(cmdLine);
  const pattern = new RegExp(`^git\\s+(-C\\s+\\S+\\s+)?${subcommand}`);
  return segments.some((seg) => pattern.test(seg));
}

/**
 * Extract PR number from a gh pr <subcommand> invocation.
 * Returns the number if present, undefined otherwise.
 */
export function extractPrNumber(
  cmdLine: string,
  subcommand: string,
): string | undefined {
  const match = cmdLine.match(
    new RegExp(`gh\\s+pr\\s+${subcommand}\\s+(\\d+)`),
  );
  return match?.[1];
}

/**
 * Extract --repo flag value from a command line.
 */
export function extractRepoFlag(cmdLine: string): string | undefined {
  const match = cmdLine.match(/--repo\s+(\S+)/);
  return match?.[1];
}

/**
 * Extract a GitHub PR URL from text (stdout, stderr, or command args).
 */
export function extractPrUrl(text: string): string | undefined {
  const match = text.match(
    /https:\/\/github\.com\/[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+\/pull\/\d+/,
  );
  return match?.[0];
}

/**
 * Reconstruct a full PR URL from a gh pr command line.
 * Fallback chain:
 *   1. Extract URL from stdout/stderr
 *   2. Extract URL from command args
 *   3. Parse --repo + bare PR number from command, construct URL
 *   4. Parse bare PR number + detect repo from git remote (requires repoFromGit)
 */
export function reconstructPrUrl(
  cmdLine: string,
  stdout: string,
  stderr: string,
  subcommand: string,
  repoFromGit?: string,
): string | undefined {
  // Try stdout
  let url = extractPrUrl(stdout);
  if (url) return url;

  // Try stderr
  url = extractPrUrl(stderr);
  if (url) return url;

  // Try command args (full URL in the command)
  url = extractPrUrl(cmdLine);
  if (url) return url;

  // Reconstruct from --repo + bare PR number
  const prNum = extractPrNumber(cmdLine, subcommand);
  if (prNum) {
    const repo = extractRepoFlag(cmdLine) ?? repoFromGit;
    if (repo) {
      return `https://github.com/${repo}/pull/${prNum}`;
    }
  }

  return undefined;
}
