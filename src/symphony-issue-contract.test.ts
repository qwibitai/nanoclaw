import { describe, expect, it } from 'vitest';

import {
  buildSymphonyPrompt,
  missingSymphonySections,
  parseSymphonyIssueContract,
} from './symphony-issue-contract.js';

const BODY = `
## Problem Statement
Need a dispatcher.

## Scope
Implement one-shot orchestration.

## Acceptance Criteria
Dispatch works.

## Required Checks
- npm test

## Required Evidence
- test output

## Blocked If
- command template missing

## Symphony Routing
- Execution Lane: symphony
- Target Runtime: codex
- Work Class: nanoclaw-core
`;

describe('parseSymphonyIssueContract', () => {
  it('parses routing metadata from the issue body', () => {
    expect(parseSymphonyIssueContract(BODY)).toEqual({
      workClass: 'nanoclaw-core',
      executionLane: 'symphony',
      targetRuntime: 'codex',
      missingSections: [],
    });
  });

  it('reports missing required sections', () => {
    expect(missingSymphonySections('## Scope\nx')).toContain('Problem Statement');
    expect(() => parseSymphonyIssueContract('## Scope\nx')).toThrow(
      /missing required sections/i,
    );
  });
});

describe('buildSymphonyPrompt', () => {
  it('embeds issue identity and description', () => {
    const prompt = buildSymphonyPrompt({
      identifier: 'NCL-1',
      title: 'Test',
      url: 'https://linear.app',
      description: BODY,
    });

    expect(prompt).toContain('Implement Linear issue NCL-1: Test');
    expect(prompt).toContain('Issue URL: https://linear.app');
    expect(prompt).toContain('## Symphony Routing');
  });
});
