import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = process.cwd();

describe('worker connectivity shell compatibility', () => {
  it('avoids bash-4-only mapfile usage in connectivity scripts', () => {
    const files = [
      'scripts/jarvis-worker-probe.sh',
      'scripts/jarvis-verify-worker-connectivity.sh',
    ];

    for (const relPath of files) {
      const absPath = path.join(repoRoot, relPath);
      const content = fs.readFileSync(absPath, 'utf8');
      expect(content).not.toMatch(/\bmapfile\b/);
    }
  });
});

describe('slop inventory workflow hardening', () => {
  it('does not flag jarvis-ops routed scripts as unreferenced', () => {
    const output = execFileSync(
      'bash',
      ['scripts/workflow/slop-inventory.sh', '--list-unreferenced-scripts'],
      { cwd: repoRoot, encoding: 'utf8' },
    );

    expect(output).not.toContain('scripts/jarvis-message-timeline.sh');
  });

  it('passes tooling governance checks after slop pruning', () => {
    const output = execFileSync('bash', ['scripts/check-tooling-governance.sh'], {
      cwd: repoRoot,
      encoding: 'utf8',
    });

    expect(output).toContain('tooling-governance-check: PASS');
  });
});
