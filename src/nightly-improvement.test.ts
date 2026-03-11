import { describe, expect, it } from 'vitest';

import {
  applyNightlyRecord,
  buildEvaluationKey,
  pruneEvaluatedKeys,
  shouldProcessEvaluation,
} from '../scripts/workflow/nightly-improvement.js';

describe('nightly-improvement helpers', () => {
  it('builds stable evaluation keys', () => {
    expect(buildEvaluationKey('upstream', 'abc123')).toBe('upstream:abc123');
    expect(buildEvaluationKey('claude_code', '1.2.3')).toBe(
      'tool:claude_code@1.2.3',
    );
  });

  it('skips already evaluated keys unless forced', () => {
    const evaluatedKeys = {
      'tool:claude_code@1.2.3': {
        evaluatedAt: '2026-03-09T00:30:00.000Z',
      },
    };

    expect(
      shouldProcessEvaluation({
        evaluatedKeys,
        evaluationKey: 'tool:claude_code@1.2.3',
        sourceKey: 'claude_code',
      }),
    ).toBe(false);

    expect(
      shouldProcessEvaluation({
        evaluatedKeys,
        evaluationKey: 'tool:claude_code@1.2.3',
        sourceKey: 'claude_code',
        forceSources: ['claude_code'],
      }),
    ).toBe(true);
  });

  it('records processed work but preserves deferred tooling versions', () => {
    const nextState = applyNightlyRecord(
      {
        schema_version: 1,
        last_run_at: null,
        last_upstream_sha: 'oldsha',
        tool_versions: {
          claude_code: '1.0.0',
          claude_agent_sdk: '0.4.0',
          opencode: '0.9.0',
        },
        context_refs: {},
        evaluated_keys: {},
      },
      {
        upstream: {
          toSha: 'newsha',
          pending: true,
          evaluationKey: 'upstream:newsha',
        },
        tooling: {
          currentVersions: {
            claude_code: '1.1.0',
            claude_agent_sdk: '0.5.0',
            opencode: '1.0.0',
          },
          candidates: [
            {
              key: 'claude_code',
              currentVersion: '1.1.0',
              pending: true,
              evaluationKey: 'tool:claude_code@1.1.0',
            },
          ],
          deferredCandidates: [
            {
              key: 'opencode',
              currentVersion: '1.0.0',
            },
          ],
        },
      },
      {
        upstreamPageId: 'page-upstream',
        upstreamPageUrl: 'https://notion.so/upstream',
        toolingPageId: 'page-tooling',
        toolingPageUrl: 'https://notion.so/tooling',
      },
      '2026-03-10T00:30:00.000Z',
    );

    expect(nextState.last_upstream_sha).toBe('newsha');
    expect(nextState.tool_versions).toEqual({
      claude_code: '1.1.0',
      claude_agent_sdk: '0.5.0',
      opencode: '0.9.0',
    });
    expect(nextState.context_refs).toEqual({
      upstream: {
        kind: 'upstream',
        pageId: 'page-upstream',
        updatedAt: '2026-03-10T00:30:00.000Z',
        url: 'https://notion.so/upstream',
      },
      tooling: {
        kind: 'tooling',
        pageId: 'page-tooling',
        updatedAt: '2026-03-10T00:30:00.000Z',
        url: 'https://notion.so/tooling',
      },
    });
    expect(nextState.evaluated_keys['upstream:newsha']).toMatchObject({
      pageId: 'page-upstream',
    });
    expect(nextState.evaluated_keys['tool:claude_code@1.1.0']).toMatchObject({
      pageId: 'page-tooling',
    });
    expect(nextState.evaluated_keys['tool:opencode@1.0.0']).toBeUndefined();
  });

  it('keeps only the newest tracked evaluation keys', () => {
    const evaluatedKeys = Object.fromEntries(
      Array.from({ length: 105 }, (_, index) => [
        `tool:test@${index}`,
        {
          evaluatedAt: `2026-03-10T00:${String(index).padStart(2, '0')}:00.000Z`,
        },
      ]),
    );

    const pruned = pruneEvaluatedKeys(evaluatedKeys);

    expect(Object.keys(pruned)).toHaveLength(100);
    expect(pruned['tool:test@104']).toBeDefined();
    expect(pruned['tool:test@0']).toBeUndefined();
  });
});
