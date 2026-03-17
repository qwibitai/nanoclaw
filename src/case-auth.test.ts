import { describe, it, expect } from 'vitest';

import { authorizeCaseCreation, looksLikeCodeWork } from './case-auth.js';

describe('looksLikeCodeWork', () => {
  // INVARIANT: Descriptions mentioning code artifacts should be detected
  it.each([
    'fix the bug in router.ts',
    'implement new webhook endpoint',
    'refactor the auth middleware',
    'add function to handle retries',
    'update the Dockerfile for node 22',
    'create a PR for the attachment fix',
    'patch the hotfix for message coalescing',
    'update config in package.json',
    'remove test for deprecated endpoint',
    'rename handler in src/ipc.ts',
    'code change to support new format',
  ])('detects code work: "%s"', (desc) => {
    expect(looksLikeCodeWork(desc)).toBe(true);
  });

  // INVARIANT: Non-code descriptions should NOT be detected
  it.each([
    'research competitor pricing',
    'write a summary of customer feedback',
    'analyze the sales data for Q1',
    'convert this image to PDF',
    'translate the document to Hebrew',
    'schedule a reminder for tomorrow',
    'send Nir the invoice',
  ])('does not detect code work: "%s"', (desc) => {
    expect(looksLikeCodeWork(desc)).toBe(false);
  });
});

describe('authorizeCaseCreation', () => {
  const mainParams = {
    sourceGroup: 'telegram_main',
    isMain: true,
  };

  const nonMainParams = {
    sourceGroup: 'telegram_client',
    isMain: false,
  };

  // INVARIANT: Work cases from any source go active immediately
  it('work case from main group → active', () => {
    const result = authorizeCaseCreation({
      ...mainParams,
      requestedType: 'work',
      description: 'analyze customer data',
    });
    expect(result.caseType).toBe('work');
    expect(result.status).toBe('active');
    expect(result.autoPromoted).toBe(false);
  });

  it('work case from non-main group → active', () => {
    const result = authorizeCaseCreation({
      ...nonMainParams,
      requestedType: 'work',
      description: 'write a report on sales',
    });
    expect(result.caseType).toBe('work');
    expect(result.status).toBe('active');
    expect(result.autoPromoted).toBe(false);
  });

  // INVARIANT: Explicit dev case from main group → active immediately
  it('explicit dev case from main group → active', () => {
    const result = authorizeCaseCreation({
      ...mainParams,
      requestedType: 'dev',
      description: 'improve the kaizen hook',
    });
    expect(result.caseType).toBe('dev');
    expect(result.status).toBe('active');
    expect(result.autoPromoted).toBe(false);
  });

  // INVARIANT: Explicit dev case from non-main group → suggested (needs approval)
  it('explicit dev case from non-main group → suggested', () => {
    const result = authorizeCaseCreation({
      ...nonMainParams,
      requestedType: 'dev',
      description: 'improve the kaizen hook',
    });
    expect(result.caseType).toBe('dev');
    expect(result.status).toBe('suggested');
    expect(result.autoPromoted).toBe(false);
  });

  // INVARIANT: Auto-promotion from work→dev when description looks like code
  it('auto-promotes work→dev for code descriptions from main → active', () => {
    const result = authorizeCaseCreation({
      ...mainParams,
      requestedType: 'work',
      description: 'fix the bug in router.ts where messages are dropped',
    });
    expect(result.caseType).toBe('dev');
    expect(result.status).toBe('active');
    expect(result.autoPromoted).toBe(true);
  });

  it('auto-promotes work→dev for code descriptions from non-main → suggested', () => {
    const result = authorizeCaseCreation({
      ...nonMainParams,
      requestedType: 'work',
      description: 'fix the bug in router.ts where messages are dropped',
    });
    expect(result.caseType).toBe('dev');
    expect(result.status).toBe('suggested');
    expect(result.autoPromoted).toBe(true);
  });

  // INVARIANT: Non-code work descriptions stay as work even from main
  it('does not promote non-code work descriptions', () => {
    const result = authorizeCaseCreation({
      ...mainParams,
      requestedType: 'work',
      description: 'research competitor pricing and write a summary',
    });
    expect(result.caseType).toBe('work');
    expect(result.status).toBe('active');
    expect(result.autoPromoted).toBe(false);
  });
});
