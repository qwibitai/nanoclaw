#!/usr/bin/env node
/**
 * Claude Code PreToolUse hook: block `gh` CLI subcommands that use GraphQL
 * (incompatible with fine-grained PATs) and instruct the agent to use
 * `gh api` (REST) instead.
 */
const chunks = [];
process.stdin.on('data', (c) => chunks.push(c));
process.stdin.on('end', () => {
  const data = JSON.parse(Buffer.concat(chunks).toString());
  const cmd = data.tool_input?.command || '';

  // Match: gh pr create, gh pr merge, gh issue create, etc.
  if (/\bgh\s+(pr|issue)\s+(create|merge|close|edit|comment)\b/.test(cmd)) {
    console.log(JSON.stringify({
      decision: 'block',
      reason: [
        'gh CLI subcommands (pr create, issue create, etc.) use GraphQL which fails with fine-grained PATs.',
        'Use `gh api` (REST) instead. Examples:',
        '',
        '  # Create PR',
        "  gh api repos/{owner}/{repo}/pulls --method POST -f title='...' -f head='branch' -f base='main' -f body='...'",
        '',
        '  # Update PR',
        "  gh api repos/{owner}/{repo}/pulls/{number} --method PATCH -f title='...' -f body='...'",
        '',
        '  # Merge PR',
        "  gh api repos/{owner}/{repo}/pulls/{number}/merge --method PUT -f merge_method='squash'",
        '',
        '  # Close PR',
        "  gh api repos/{owner}/{repo}/pulls/{number} --method PATCH -f state='closed'",
        '',
        '  # Create issue',
        "  gh api repos/{owner}/{repo}/issues --method POST -f title='...' -f body='...'",
      ].join('\n'),
    }));
  } else {
    console.log('{"decision":"allow"}');
  }
});
