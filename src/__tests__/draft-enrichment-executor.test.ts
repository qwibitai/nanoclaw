import { describe, it, expect, vi, beforeEach } from 'vitest';
import { parseEnrichmentResponse } from '../draft-enrichment.js';

describe('parseEnrichmentResponse', () => {
  it('should return null for NO_CHANGE', () => {
    expect(parseEnrichmentResponse('NO_CHANGE')).toBeNull();
    expect(parseEnrichmentResponse('no_change')).toBeNull();
    expect(parseEnrichmentResponse('  NO_CHANGE  ')).toBeNull();
  });

  it('should return enriched body from agent response', () => {
    const body =
      'Thank you for your email. I would be happy to discuss further.';
    expect(parseEnrichmentResponse(body)).toBe(body);
  });

  it('should return null for empty response', () => {
    expect(parseEnrichmentResponse('')).toBeNull();
    expect(parseEnrichmentResponse('   ')).toBeNull();
  });
});

describe('draft enrichment evaluator', () => {
  it('should skip drafts with body > 200 chars', async () => {
    const evaluateEnrichment = buildEvaluator({ enqueueTask: vi.fn() });
    const result = await evaluateEnrichment({
      draftId: 'd1',
      subject: 'Re: Test',
      body: 'x'.repeat(201),
      createdAt: new Date().toISOString(),
      threadId: 'thread-1',
    });
    expect(result).toBeNull();
  });

  it('should skip drafts older than 30 minutes', async () => {
    const evaluateEnrichment = buildEvaluator({ enqueueTask: vi.fn() });
    const oldDate = new Date(Date.now() - 31 * 60 * 1000).toISOString();
    const result = await evaluateEnrichment({
      draftId: 'd2',
      subject: 'Re: Old',
      body: 'Short reply',
      createdAt: oldDate,
      threadId: 'thread-2',
    });
    expect(result).toBeNull();
  });

  it('should enqueue a proactive task for eligible drafts', async () => {
    const enqueueTask = vi.fn();
    const evaluateEnrichment = buildEvaluator({ enqueueTask });
    const draft = {
      draftId: 'd3',
      subject: 'Re: Quick question',
      body: 'Sure, sounds good.',
      createdAt: new Date().toISOString(),
      threadId: 'thread-3',
    };

    // Start evaluation (it enqueues but never completes since mock doesn't run fn)
    const promise = evaluateEnrichment(draft);

    // Verify enqueueTask was called with proactive priority
    expect(enqueueTask).toHaveBeenCalledWith(
      expect.any(String),
      expect.stringContaining('draft-enrich-d3'),
      expect.any(Function),
      'proactive',
    );
    expect(enqueueTask.mock.calls[0][3]).toBe('proactive');
  });

  it('should return null on timeout', async () => {
    vi.useFakeTimers();
    const enqueueTask = vi.fn();
    const evaluateEnrichment = buildEvaluator({ enqueueTask, timeoutMs: 100 });
    const draft = {
      draftId: 'd4',
      subject: 'Re: Timeout',
      body: 'Ok',
      createdAt: new Date().toISOString(),
      threadId: 'thread-4',
    };

    const promise = evaluateEnrichment(draft);
    vi.advanceTimersByTime(150);
    const result = await promise;
    expect(result).toBeNull();
    vi.useRealTimers();
  });
});

// Helper that mimics the evaluateEnrichment shape from index.ts
interface EvaluatorOpts {
  enqueueTask: ReturnType<typeof vi.fn>;
  timeoutMs?: number;
  groupJid?: string;
}

function buildEvaluator(opts: EvaluatorOpts) {
  const { enqueueTask, timeoutMs = 60_000, groupJid = 'tg:12345' } = opts;

  return async (draft: {
    draftId: string;
    subject: string;
    body: string;
    createdAt: string;
    threadId: string;
  }): Promise<string | null> => {
    if (draft.body.length > 200) return null;
    const ageMs = Date.now() - new Date(draft.createdAt).getTime();
    if (ageMs > 30 * 60 * 1000) return null;

    return new Promise<string | null>((resolve) => {
      const timer = setTimeout(() => resolve(null), timeoutMs);
      const taskId = `draft-enrich-${draft.draftId}-${Date.now()}`;
      enqueueTask(
        groupJid,
        taskId,
        async () => {
          clearTimeout(timer);
        },
        'proactive',
      );
    });
  };
}
