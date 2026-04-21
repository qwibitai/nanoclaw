// src/docs-freshness.test.ts
import path from 'node:path';
import { describe, it, expect } from 'vitest';

import { scanDocs } from '../scripts/docs-scan.js';

const repoRoot = path.resolve(process.cwd());
const scan = scanDocs(repoRoot);

describe('docs freshness', () => {
  it('all skills in .claude/skills/ are listed in CLAUDE.md', () => {
    const failures = scan.failures.filter((f) => f.startsWith("Skill '"));
    expect(failures, failures.join('\n')).toHaveLength(0);
  });

  it('all src/channels/*.ts have an active import in src/channels/index.ts', () => {
    const failures = scan.failures.filter((f) => f.startsWith("Channel '"));
    expect(failures, failures.join('\n')).toHaveLength(0);
  });

  it('all container/skills/* are mentioned in CLAUDE.md', () => {
    const failures = scan.failures.filter((f) =>
      f.startsWith("Container skill '"),
    );
    expect(failures, failures.join('\n')).toHaveLength(0);
  });

  it('all v* git tags have an entry in CHANGELOG.md', () => {
    const failures = scan.failures.filter((f) => f.startsWith("Git tag '"));
    expect(failures, failures.join('\n')).toHaveLength(0);
  });

  it('all spec and plan YAML headers have valid cross-reference paths', () => {
    const failures = scan.failures.filter(
      (f) => f.includes("'spec'") || f.includes("'plan'"),
    );
    expect(failures, failures.join('\n')).toHaveLength(0);
  });

  it('INDEX.md links all resolve to existing files', () => {
    const failures = scan.failures.filter((f) =>
      f.startsWith('INDEX.md references'),
    );
    expect(failures, failures.join('\n')).toHaveLength(0);
  });
});
