import { describe, it, expect } from 'vitest';
import {
  ObservationOutputSchema,
  ObservationItemSchema,
  ReflectorOutputSchema,
  LearningEntrySchema,
  QualitySignalSchema,
  HindsightReportSchema,
  StepValidationSchema,
  MemoryEntrySchema,
  observationToMarkdown,
} from './schemas.js';

describe('ObservationItemSchema', () => {
  it('should validate correct observation item', () => {
    const item = {
      time: '14:32',
      topic: 'Decided to use Sonnet',
      priority: 'critical',
      points: ['Switched model for quality'],
      referencedDates: ['2026-02-27'],
    };
    const result = ObservationItemSchema.safeParse(item);
    expect(result.success).toBe(true);
  });

  it('should reject observation missing required fields', () => {
    const bad = { time: '14:32' }; // missing topic, priority, points
    const result = ObservationItemSchema.safeParse(bad);
    expect(result.success).toBe(false);
  });

  it('should reject empty points array', () => {
    const bad = {
      time: '14:32',
      topic: 'Something',
      priority: 'useful',
      points: [],
    };
    const result = ObservationItemSchema.safeParse(bad);
    expect(result.success).toBe(false);
  });

  it('should reject invalid priority value', () => {
    const bad = {
      time: '14:32',
      topic: 'Something',
      priority: 'urgent', // not in enum
      points: ['point'],
    };
    const result = ObservationItemSchema.safeParse(bad);
    expect(result.success).toBe(false);
  });

  it('should default referencedDates to empty array', () => {
    const item = {
      time: '14:32',
      topic: 'Something',
      priority: 'noise',
      points: ['trivial'],
    };
    const result = ObservationItemSchema.safeParse(item);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.referencedDates).toEqual([]);
    }
  });
});

describe('ObservationOutputSchema', () => {
  it('should validate correct observation output', () => {
    const output = {
      observations: [
        {
          time: '14:32',
          topic: 'Decided to use Sonnet',
          priority: 'critical',
          points: ['Quality matters for memory'],
          referencedDates: ['2026-02-27'],
        },
        {
          time: '15:10',
          topic: 'Email check',
          priority: 'noise',
          points: ['No urgent emails'],
        },
      ],
    };
    const result = ObservationOutputSchema.safeParse(output);
    expect(result.success).toBe(true);
  });

  it('should reject empty observations array', () => {
    const result = ObservationOutputSchema.safeParse({ observations: [] });
    expect(result.success).toBe(false);
  });
});

describe('observationToMarkdown', () => {
  it('should produce markdown with priority emoji and timestamps', () => {
    const output = {
      observations: [
        {
          time: '14:32',
          topic: 'Decided to use Sonnet',
          priority: 'critical' as const,
          points: ['Switched model', 'Better quality'],
          referencedDates: ['2026-02-27'],
        },
      ],
    };
    const md = observationToMarkdown(output, '2026-02-27');
    expect(md).toContain('### 14:32');
    expect(md).toContain('Decided to use Sonnet');
    expect(md).toContain('\uD83D\uDD34 Critical');
    expect(md).toContain('- Switched model');
    expect(md).toContain('- Better quality');
    expect(md).toContain('Referenced: 2026-02-27');
  });

  it('should use dateStr as default reference when none provided', () => {
    const output = {
      observations: [
        {
          time: '10:00',
          topic: 'Chat',
          priority: 'noise' as const,
          points: ['Hello'],
          referencedDates: [],
        },
      ],
    };
    const md = observationToMarkdown(output, '2026-03-01');
    expect(md).toContain('Referenced: 2026-03-01');
  });
});

describe('Future agent schemas (placeholder validation)', () => {
  it('should validate ReflectorOutput', () => {
    const result = ReflectorOutputSchema.safeParse({
      actions: [{ action: 'prune', targetPath: 'daily/observer/old.md', reason: 'Stale noise' }],
      summary: 'Pruned 1 stale file',
    });
    expect(result.success).toBe(true);
  });

  it('should validate LearningEntry', () => {
    const result = LearningEntrySchema.safeParse({
      correction: { wrong: 'meeting at 2pm', right: 'meeting at 3pm' },
      source: 'conversation',
      knowledgeFile: 'knowledge/people.md',
      context: 'User corrected meeting time',
    });
    expect(result.success).toBe(true);
  });

  it('should validate QualitySignal', () => {
    const result = QualitySignalSchema.safeParse({
      sessionId: 'abc-123',
      turn: 3,
      signal: 'positive',
      evidence: 'User said thanks',
    });
    expect(result.success).toBe(true);
  });

  it('should validate HindsightReport', () => {
    const result = HindsightReportSchema.safeParse({
      failureType: 'hallucination',
      whatWentWrong: 'Agent claimed file was saved but it was not',
      whatShouldHaveBeen: 'Agent should have verified file exists after write',
      actionableLearning: 'Always verify state after claiming an action',
      severity: 'critical',
    });
    expect(result.success).toBe(true);
  });

  it('should validate StepValidation', () => {
    const result = StepValidationSchema.safeParse({
      stepName: 'observer',
      valid: true,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.issues).toEqual([]);
      expect(result.data.retried).toBe(false);
    }
  });

  it('should validate MemoryEntry', () => {
    const result = MemoryEntrySchema.safeParse({
      category: 'people',
      content: 'Brandon prefers Sonnet over Haiku',
      source: 'conversation',
      timestamp: '2026-02-28T10:00:00Z',
    });
    expect(result.success).toBe(true);
  });
});

describe('Schema exports', () => {
  it('should export all agent schemas from single module', () => {
    expect(ObservationOutputSchema).toBeDefined();
    expect(ReflectorOutputSchema).toBeDefined();
    expect(LearningEntrySchema).toBeDefined();
    expect(QualitySignalSchema).toBeDefined();
    expect(HindsightReportSchema).toBeDefined();
    expect(StepValidationSchema).toBeDefined();
    expect(MemoryEntrySchema).toBeDefined();
  });
});
