import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { encodingForModel } from 'js-tiktoken';

const GROUPS_DIR = join(process.cwd(), 'groups');
const GLOBAL_CLAUDE_MD = join(GROUPS_DIR, 'global', 'CLAUDE.md');
const CONTAINER_SKILLS = join(process.cwd(), 'container', 'skills');

// Token budgets — raise these deliberately, not accidentally
// CLAUDE.md = identity + core rules + lazy-load pointers. Everything else → reference files or scripts.
const BUDGETS = {
  globalClaudeMd: 1000,
  groupClaudeMd: 1_000,
  containerSkill: 800,
};

const enc = encodingForModel('gpt-4o');

function tokenCount(path: string): number {
  return enc.encode(readFileSync(path, 'utf8')).length;
}

describe('prompt budget', () => {
  it(`global/CLAUDE.md stays under ${BUDGETS.globalClaudeMd} tokens`, () => {
    const tokens = tokenCount(GLOBAL_CLAUDE_MD);
    expect(tokens).toBeLessThanOrEqual(BUDGETS.globalClaudeMd);
  });

  it(`per-group CLAUDE.md files stay under ${BUDGETS.groupClaudeMd} tokens`, () => {
    const violations: string[] = [];
    for (const dir of readdirSync(GROUPS_DIR)) {
      if (dir === 'global') continue;
      const claudeMd = join(GROUPS_DIR, dir, 'CLAUDE.md');
      if (!existsSync(claudeMd)) continue;
      const tokens = tokenCount(claudeMd);
      if (tokens > BUDGETS.groupClaudeMd) {
        violations.push(`${dir}/CLAUDE.md: ${tokens} tokens (budget: ${BUDGETS.groupClaudeMd})`);
      }
    }
    expect(violations).toEqual([]);
  });

  it(`container skill SKILL.md files stay under ${BUDGETS.containerSkill} tokens`, () => {
    if (!existsSync(CONTAINER_SKILLS)) return;
    const violations: string[] = [];
    for (const dir of readdirSync(CONTAINER_SKILLS)) {
      const skillMd = join(CONTAINER_SKILLS, dir, 'SKILL.md');
      if (!existsSync(skillMd)) continue;
      const tokens = tokenCount(skillMd);
      if (tokens > BUDGETS.containerSkill) {
        violations.push(`${dir}/SKILL.md: ${tokens} tokens (budget: ${BUDGETS.containerSkill})`);
      }
    }
    expect(violations).toEqual([]);
  });
});
