/**
 * Tests for regenerate-recall-eval.ts (E1).
 * TDD: write tests before implementation (RED → GREEN).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import type { EvalEntry } from './regenerate-recall-eval.js';
import {
  synthesizeQueryForFact,
  loadEvalSet,
  saveEvalSet,
  setEvalSynthesizerBackendForTest,
  _resetEvalSynthesizerBackendForTest,
  EVAL_SYNTHESIZER_DEFAULT_BACKEND,
} from './regenerate-recall-eval.js';

beforeEach(() => {
  _resetEvalSynthesizerBackendForTest();
});

afterEach(() => {
  _resetEvalSynthesizerBackendForTest();
});

describe('synthesizeQueryForFact', () => {
  it('returns synthesized query from backend', async () => {
    setEvalSynthesizerBackendForTest(async () => 'who manages the budget');
    const result = await synthesizeQueryForFact('the finance team is led by Alice');
    expect(result).toBe('who manages the budget');
  });

  it('strips null bytes from fact content before calling backend', async () => {
    let capturedInput = '';
    setEvalSynthesizerBackendForTest(async (_sys, user) => {
      capturedInput = user;
      return 'result';
    });
    await synthesizeQueryForFact('has\0null');
    expect(capturedInput).toBe('hasnull');
    expect(capturedInput).not.toContain('\0');
  });

  it('propagates abort signal', async () => {
    const controller = new AbortController();
    setEvalSynthesizerBackendForTest(
      () =>
        new Promise<string>((_, reject) => {
          controller.signal.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    );
    const promise = synthesizeQueryForFact('fact', { signal: controller.signal });
    controller.abort();
    await expect(promise).rejects.toThrow();
  });
});

describe('synthesizeQueryForFact default backend config', () => {
  it('has default backend provider=codex model=gpt-5.5 effort=medium', () => {
    expect(EVAL_SYNTHESIZER_DEFAULT_BACKEND.provider).toBe('codex');
    expect(EVAL_SYNTHESIZER_DEFAULT_BACKEND.model).toBe('gpt-5.5');
    expect(EVAL_SYNTHESIZER_DEFAULT_BACKEND.effort).toBe('medium');
  });
});

describe('saveEvalSet / loadEvalSet', () => {
  let tmpFile: string;

  beforeEach(() => {
    tmpFile = path.join(os.tmpdir(), `recall-eval-test-${Date.now()}.json`);
  });

  afterEach(() => {
    try {
      fs.unlinkSync(tmpFile);
    } catch {
      // ignore
    }
  });

  it('round-trips entries', () => {
    const entries: EvalEntry[] = [
      {
        fact_id: 'f1',
        agent_group_id: 'g1',
        expected_query: 'who manages the budget',
        expected_fact_content: 'the finance team is led by Alice',
        source: 'synthesized',
      },
      {
        fact_id: 'f2',
        agent_group_id: 'g1',
        expected_query: 'project deadline',
        expected_fact_content: 'the project ships Q3 2026',
        source: 'manual',
      },
    ];
    saveEvalSet(entries, tmpFile);
    const loaded = loadEvalSet(tmpFile);
    expect(loaded).toEqual(entries);
  });

  it('saveEvalSet writes valid JSON', () => {
    const entries: EvalEntry[] = [
      {
        fact_id: 'f1',
        agent_group_id: 'g1',
        expected_query: 'test query',
        expected_fact_content: 'test fact',
        source: 'manual',
      },
    ];
    saveEvalSet(entries, tmpFile);
    const raw = fs.readFileSync(tmpFile, 'utf8');
    expect(() => JSON.parse(raw)).not.toThrow();
  });
});
