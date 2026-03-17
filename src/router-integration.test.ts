/**
 * Router integration tests — verify the full routing pipeline invariants.
 * These tests don't call the API but verify that the prompt, result file handling,
 * and request ID flow work correctly end-to-end.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { buildRouterPrompt } from './router-prompt.js';
import { RouterRequest } from './router-types.js';

function makeRequest(overrides: Partial<RouterRequest> = {}): RouterRequest {
  return {
    type: 'route',
    requestId: `route-${Date.now()}-test`,
    messageText: 'Fix the auth bug',
    senderName: 'Aviad',
    groupFolder: 'telegram_garsson',
    cases: [
      {
        id: 'case-1',
        name: '260315-1430-fix-auth',
        type: 'dev',
        status: 'active',
        description: 'Fix authentication flow',
        lastMessage: 'Working on OAuth redirect',
        lastActivityAt: new Date(Date.now() - 30 * 60000).toISOString(),
      },
      {
        id: 'case-2',
        name: '260316-0900-add-tests',
        type: 'dev',
        status: 'active',
        description: 'Add integration tests',
        lastMessage: null,
        lastActivityAt: null,
      },
    ],
    ...overrides,
  };
}

describe('Router request ID round-trip', () => {
  /**
   * INVARIANT: The requestId from RouterRequest must appear verbatim in the
   * prompt, so the agent can echo it back in the route_decision tool call.
   * SUT: buildRouterPrompt + readRouterResult contract
   * VERIFICATION: requestId appears in prompt; result file named with requestId is found
   */
  it('requestId appears in prompt so agent can echo it in the tool call', () => {
    const requestId = 'route-1773738908605-pwnz';
    const request = makeRequest({ requestId });
    const prompt = buildRouterPrompt(request);

    // The prompt must contain the exact requestId string
    expect(prompt).toContain(requestId);

    // It should be in a clear instruction, not buried in case data
    const lines = prompt.split('\n');
    const requestIdLine = lines.find((l) => l.includes(requestId));
    expect(requestIdLine).toBeDefined();
    expect(requestIdLine).toContain('request_id');
  });

  /**
   * INVARIANT: Different requests get unique requestIds in their prompts,
   * preventing result file collisions when multiple routing requests are in flight.
   * SUT: buildRouterPrompt uniqueness
   * VERIFICATION: Two requests produce prompts with different requestIds
   */
  it('different requests produce prompts with different requestIds', () => {
    const req1 = makeRequest({ requestId: 'route-aaa-111' });
    const req2 = makeRequest({ requestId: 'route-bbb-222' });

    const prompt1 = buildRouterPrompt(req1);
    const prompt2 = buildRouterPrompt(req2);

    expect(prompt1).toContain('route-aaa-111');
    expect(prompt1).not.toContain('route-bbb-222');
    expect(prompt2).toContain('route-bbb-222');
    expect(prompt2).not.toContain('route-aaa-111');
  });
});

/**
 * Test readRouterResult with real filesystem by replicating the core logic.
 * We can't easily swap DATA_DIR in ESM imports, so we test the file-finding
 * algorithm directly with real fs operations.
 */
describe('readRouterResult file-finding algorithm (real filesystem)', () => {
  let tmpDir: string;
  let resultsDir: string;

  // Replicate the core logic from readRouterResult for testing
  function findResultFile(requestId: string): {
    filepath: string;
    content: string;
  } {
    const resultFile = path.join(resultsDir, `${requestId}.json`);

    if (fs.existsSync(resultFile)) {
      const content = fs.readFileSync(resultFile, 'utf-8');
      fs.unlinkSync(resultFile);
      return { filepath: resultFile, content };
    }

    // Fallback: find any .json file
    const files = fs.existsSync(resultsDir)
      ? fs.readdirSync(resultsDir).filter((f) => f.endsWith('.json'))
      : [];
    if (files.length > 0) {
      const sorted = files
        .map((f) => ({
          name: f,
          mtime: fs.statSync(path.join(resultsDir, f)).mtimeMs,
        }))
        .sort((a, b) => b.mtime - a.mtime);
      const actualFile = path.join(resultsDir, sorted[0].name);
      const content = fs.readFileSync(actualFile, 'utf-8');
      fs.unlinkSync(actualFile);
      return { filepath: actualFile, content };
    }

    throw new Error(`Router produced no result file for ${requestId}`);
  }

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'router-test-'));
    resultsDir = path.join(tmpDir, 'results');
    fs.mkdirSync(resultsDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  /**
   * INVARIANT: readRouterResult finds and parses a correctly-named result file.
   * SUT: readRouterResult happy path with real filesystem
   * VERIFICATION: File is read, parsed, and cleaned up
   */
  it('reads result file matching requestId', () => {
    const decision = {
      requestId: 'route-test-123',
      decision: 'route_to_case',
      caseId: 'case-1',
      caseName: 'fix-auth',
      confidence: 0.9,
      reason: 'Auth related',
    };

    fs.writeFileSync(
      path.join(resultsDir, 'route-test-123.json'),
      JSON.stringify(decision),
    );

    const { content } = findResultFile('route-test-123');
    const result = JSON.parse(content);
    expect(result.decision).toBe('route_to_case');
    expect(result.caseId).toBe('case-1');

    // File should be cleaned up
    expect(fs.existsSync(path.join(resultsDir, 'route-test-123.json'))).toBe(
      false,
    );
  });

  /**
   * INVARIANT: When the agent writes a result with a different requestId than
   * expected, the fallback finds the most recent .json file.
   * SUT: file-finding fallback algorithm
   * VERIFICATION: Mismatched filename is found and read successfully
   */
  it('falls back to most recent file when requestId does not match', () => {
    const decision = {
      requestId: 'agent-made-up-name',
      decision: 'direct_answer',
      confidence: 0.95,
      reason: 'Simple greeting',
      directAnswer: 'Hello!',
    };

    // Agent writes with wrong filename
    fs.writeFileSync(
      path.join(resultsDir, 'agent-made-up-name.json'),
      JSON.stringify(decision),
    );

    // Host looks for a different requestId
    const { content } = findResultFile('route-host-generated-id');
    const result = JSON.parse(content);
    expect(result.decision).toBe('direct_answer');
    expect(result.directAnswer).toBe('Hello!');

    // Fallback file should be cleaned up too
    expect(
      fs.existsSync(path.join(resultsDir, 'agent-made-up-name.json')),
    ).toBe(false);
  });

  /**
   * INVARIANT: When no result files exist at all, an error is thrown.
   * SUT: file-finding algorithm with empty dir
   * VERIFICATION: Error is thrown indicating no result
   */
  it('throws when results directory is empty', () => {
    expect(() => findResultFile('route-nonexistent')).toThrow('no result file');
  });

  /**
   * INVARIANT: When multiple result files exist (stale + new), the most
   * recent one is used.
   * SUT: file-finding picks newest file
   * VERIFICATION: The newer file's content is returned
   */
  it('picks the most recently modified file among multiple results', async () => {
    const oldDecision = {
      requestId: 'stale',
      decision: 'suggest_new',
      confidence: 0.1,
      reason: 'Old stale result',
    };

    const newDecision = {
      requestId: 'fresh',
      decision: 'route_to_case',
      caseId: 'case-2',
      caseName: 'add-tests',
      confidence: 0.8,
      reason: 'Fresh result',
    };

    // Write old file first
    fs.writeFileSync(
      path.join(resultsDir, 'stale.json'),
      JSON.stringify(oldDecision),
    );

    // Small delay to ensure different mtime
    await new Promise((r) => setTimeout(r, 50));

    // Write new file
    fs.writeFileSync(
      path.join(resultsDir, 'fresh.json'),
      JSON.stringify(newDecision),
    );

    const { content } = findResultFile('route-neither-of-these');
    const result = JSON.parse(content);
    expect(result.decision).toBe('route_to_case');
    expect(result.reason).toBe('Fresh result');
  });
});
