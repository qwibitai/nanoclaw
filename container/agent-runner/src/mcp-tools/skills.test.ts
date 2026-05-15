import { describe, expect, it } from 'bun:test';

import {
  isSafeSkillName,
  parseSkillDocument,
  scanSkillContent,
  validateSkillDocument,
} from './skills.js';

const GOOD_SKILL = `---
name: deploy-troubleshooting
description: Diagnose repeated deployment failures.
---

# Deployment Troubleshooting

Check the service logs, identify the failing dependency, and restart only the affected service.
`;

describe('skills helpers', () => {
  it('accepts safe skill names and rejects unsafe names', () => {
    expect(isSafeSkillName('deploy-troubleshooting')).toBe(true);
    expect(isSafeSkillName('a')).toBe(true);
    expect(isSafeSkillName('../escape')).toBe(false);
    expect(isSafeSkillName('BadName')).toBe(false);
    expect(isSafeSkillName('.hidden')).toBe(false);
  });

  it('parses valid SKILL.md frontmatter', () => {
    const parsed = parseSkillDocument(GOOD_SKILL);
    expect('error' in parsed).toBe(false);
    if (!('error' in parsed)) {
      expect(parsed.name).toBe('deploy-troubleshooting');
      expect(parsed.description).toBe('Diagnose repeated deployment failures.');
      expect(parsed.body).toContain('Deployment Troubleshooting');
    }
  });

  it('rejects missing frontmatter or mismatched names', () => {
    expect(validateSkillDocument('# No frontmatter').errors).toContain('SKILL.md must start with YAML frontmatter.');
    expect(validateSkillDocument(GOOD_SKILL, 'other-name').errors).toContain(
      'Frontmatter name "deploy-troubleshooting" must match skill directory "other-name".',
    );
  });

  it('flags risky skill content', () => {
    const risks = scanSkillContent(`${GOOD_SKILL}\nOPENAI_API_KEY=sk-1234567890abcdefghijklmnop\n`);
    expect(risks.some((r) => r.code === 'secret-token' && r.severity === 'block')).toBe(true);
    expect(risks.some((r) => r.code === 'secret-assignment' && r.severity === 'block')).toBe(true);
  });

  it('blocks shell code fences in skills', () => {
    const content = `${GOOD_SKILL}\n\n\`\`\`bash\nrm -rf /tmp/example\n\`\`\`\n`;
    const result = validateSkillDocument(content, 'deploy-troubleshooting');
    expect(result.errors.some((e) => e.includes('executable shell blocks'))).toBe(true);
  });
});
