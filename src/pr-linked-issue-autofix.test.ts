import { describe, expect, it } from 'vitest';

import {
  applyMaintenanceFallback,
  hasLinkedIssue,
  isMaintenanceOnlyChange,
  planPrLinkedIssueAutofix,
} from '../scripts/workflow/pr-linked-issue-autofix.js';

describe('pr-linked-issue autofix helpers', () => {
  it('detects linked issues and maintenance fallbacks', () => {
    expect(hasLinkedIssue('Fixes #42')).toBe(true);
    expect(hasLinkedIssue('Related work lives in #42')).toBe(true);
    expect(hasLinkedIssue('No issue: maintenance')).toBe(true);
    expect(hasLinkedIssue('No issue yet')).toBe(false);
  });

  it('treats governance/docs/workflow-only diffs as maintenance-safe', () => {
    expect(
      isMaintenanceOnlyChange([
        '.github/workflows/multi-agent-governance.yml',
        'docs/workflow/github/nanoclaw-github-control-plane.md',
        '.claude/skills/foo/SKILL.md',
      ]),
    ).toBe(true);

    expect(
      isMaintenanceOnlyChange([
        '.github/workflows/multi-agent-governance.yml',
        'src/index.ts',
      ]),
    ).toBe(false);
  });

  it('replaces the template placeholder with the maintenance fallback', () => {
    const body = [
      '## Linked Work Item',
      '',
      '- Fixes #<issue-id>',
      '- No issue later',
      '',
      '## Summary',
      '',
      'Example',
    ].join('\n');

    const updated = applyMaintenanceFallback(body);

    expect(updated).toContain('- No issue: maintenance');
    expect(updated).toContain('<!-- pr-linked-issue-autofix: maintenance -->');
    expect(updated).not.toContain('- Fixes #<issue-id>');
  });

  it('inserts the maintenance fallback into an existing linked-work-item section', () => {
    const body = ['## Linked Work Item', '', '## Summary', '', 'Example'].join(
      '\n',
    );

    const updated = applyMaintenanceFallback(body);

    expect(updated).toContain(
      '## Linked Work Item\n\n- No issue: maintenance\n<!-- pr-linked-issue-autofix: maintenance -->',
    );
  });

  it('prepends a linked-work-item section when the body is missing one', () => {
    const updated = applyMaintenanceFallback('## Summary\n\nExample');

    expect(updated.startsWith('## Linked Work Item')).toBe(true);
    expect(updated).toContain('- No issue: maintenance');
  });

  it('plans an autofix only for maintenance-only diffs with no existing link', () => {
    const plan = planPrLinkedIssueAutofix({
      title: 'docs: tighten governance docs',
      body: '## Summary\n\nExample',
      files: ['docs/workflow/github/nanoclaw-github-control-plane.md'],
    });

    expect(plan.shouldFix).toBe(true);
    expect(plan.reason).toBe('maintenance_fallback');
    expect(plan.updatedBody).toContain('- No issue: maintenance');

    const ambiguous = planPrLinkedIssueAutofix({
      title: 'feat: add new runtime path',
      body: '## Summary\n\nExample',
      files: ['src/index.ts'],
    });

    expect(ambiguous.shouldFix).toBe(false);
    expect(ambiguous.reason).toBe('ambiguous_scope');
  });
});
