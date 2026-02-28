/**
 * Zod schemas for all agent outputs.
 *
 * Single source of truth — every agent imports its schema from here.
 * Future agents start with placeholder schemas, refined when built.
 */
import { z } from 'zod';

// ---------------------------------------------------------------------------
// Observer (#1) — conversation compression
// ---------------------------------------------------------------------------

export const ObservationItemSchema = z.object({
  time: z.string().describe('HH:MM format timestamp'),
  topic: z.string().min(1).describe('Brief topic summary'),
  priority: z.enum(['critical', 'useful', 'noise']),
  points: z
    .array(z.string().min(1))
    .min(1)
    .describe('Key observations as bullet points'),
  referencedDates: z
    .array(z.string())
    .default([])
    .describe('Dates mentioned in conversation'),
});

export const ObservationOutputSchema = z.object({
  observations: z.array(ObservationItemSchema).min(1),
});

export type ObservationItem = z.infer<typeof ObservationItemSchema>;
export type ObservationOutput = z.infer<typeof ObservationOutputSchema>;

// ---------------------------------------------------------------------------
// Reflector (#2) — memory garbage collection
// ---------------------------------------------------------------------------

export const ReflectorActionSchema = z.object({
  action: z.enum(['prune', 'consolidate', 'keep']),
  targetPath: z.string().min(1),
  reason: z.string().min(1),
});

export const ReflectorOutputSchema = z.object({
  actions: z.array(ReflectorActionSchema),
  summary: z.string().describe('Brief summary of what was cleaned up'),
});

export type ReflectorAction = z.infer<typeof ReflectorActionSchema>;
export type ReflectorOutput = z.infer<typeof ReflectorOutputSchema>;

// ---------------------------------------------------------------------------
// Structured Memory (#3) — categorized memory entries
// ---------------------------------------------------------------------------

export const MemoryEntrySchema = z.object({
  category: z.enum(['operational', 'people', 'incidents', 'decisions']),
  content: z.string().min(1),
  source: z
    .string()
    .describe('Where this came from (conversation, observation, manual)'),
  timestamp: z.string(),
});

export type MemoryEntry = z.infer<typeof MemoryEntrySchema>;

// ---------------------------------------------------------------------------
// Auto-learning (#4) — correction detection
// ---------------------------------------------------------------------------

export const LearningEntrySchema = z.object({
  correction: z.object({
    wrong: z.string().min(1),
    right: z.string().min(1),
  }),
  source: z.enum(['conversation', 'observation', 'manual']),
  knowledgeFile: z.string().min(1).describe('Which knowledge file to update'),
  context: z.string().describe('Surrounding context for the correction'),
});

export type LearningEntry = z.infer<typeof LearningEntrySchema>;

// ---------------------------------------------------------------------------
// Hindsight (#5) — post-mortem on failed conversations
// ---------------------------------------------------------------------------

export const HindsightReportSchema = z.object({
  failureType: z.string().min(1),
  whatWentWrong: z.string().min(1),
  whatShouldHaveBeen: z.string().min(1),
  actionableLearning: z.string().min(1),
  severity: z.enum(['critical', 'moderate', 'minor']),
});

export type HindsightReport = z.infer<typeof HindsightReportSchema>;

// ---------------------------------------------------------------------------
// Quality Tracker (#6) — conversation quality signals
// ---------------------------------------------------------------------------

export const QualitySignalSchema = z.object({
  sessionId: z.string().min(1),
  turn: z.number().int().nonnegative(),
  signal: z.enum(['positive', 'negative', 'neutral']),
  evidence: z.string().min(1).describe('What triggered this signal'),
});

export type QualitySignal = z.infer<typeof QualitySignalSchema>;

export const ConversationLogEntrySchema = z.object({
  groupFolder: z.string().min(1),
  timestamp: z.string().min(1),
  userMessages: z.array(
    z.object({
      sender: z.string().min(1),
      content: z.string(),
      timestamp: z.string(),
    }),
  ),
  botResponses: z.array(z.string()),
  signal: z.enum(['positive', 'negative', 'neutral']),
  evidence: z.string().describe('What triggered this signal classification'),
});

export type ConversationLogEntry = z.infer<typeof ConversationLogEntrySchema>;

// ---------------------------------------------------------------------------
// Per-step Evaluation (#22) — step validation result
// ---------------------------------------------------------------------------

export const StepValidationSchema = z.object({
  stepName: z.string().min(1),
  valid: z.boolean(),
  issues: z.array(z.string()).default([]),
  retried: z.boolean().default(false),
});

export type StepValidation = z.infer<typeof StepValidationSchema>;

// ---------------------------------------------------------------------------
// Priority marker helpers (used by observer markdown serialization)
// ---------------------------------------------------------------------------

const PRIORITY_EMOJI: Record<ObservationItem['priority'], string> = {
  critical: '\uD83D\uDD34',
  useful: '\uD83D\uDFE1',
  noise: '\uD83D\uDFE2',
};

const PRIORITY_LABEL: Record<ObservationItem['priority'], string> = {
  critical: 'Critical',
  useful: 'Useful',
  noise: 'Noise',
};

export function observationToMarkdown(
  output: ObservationOutput,
  dateStr: string,
): string {
  return output.observations
    .map((obs) => {
      const emoji = PRIORITY_EMOJI[obs.priority];
      const label = PRIORITY_LABEL[obs.priority];
      const points = obs.points.map((p) => `- ${p}`).join('\n');
      const refs =
        obs.referencedDates.length > 0
          ? `\nReferenced: ${obs.referencedDates.join(', ')}`
          : `\nReferenced: ${dateStr}`;
      return `### ${obs.time} \u2014 ${obs.topic} (${emoji} ${label})\n${points}${refs}`;
    })
    .join('\n\n');
}
