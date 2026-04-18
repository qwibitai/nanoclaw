import type { MessageMeta, MessageCategory, MessageUrgency } from './types.js';

export interface ClassificationRule {
  patterns: RegExp[];
  category: MessageCategory;
  urgency: MessageUrgency;
  batchable: boolean;
}

const RULES: ClassificationRule[] = [
  // Financial — wires, deposits, payments, billing
  {
    patterns: [
      /incoming wire/i,
      /direct deposit/i,
      /wire transfer/i,
      /chase.*activity/i,
      /billing statement/i,
      /payment.*received/i,
      /were.*expected\??/i,
      /all expected\??/i,
    ],
    category: 'financial',
    urgency: 'action-required',
    batchable: false,
  },
  // Security — Spamhaus, abuse, compromise, vulnerability
  {
    patterns: [
      /spamhaus/i,
      /listed.*abuse/i,
      /compromis/i,
      /security.*alert/i,
      /vulnerability/i,
      /unauthorized.*access/i,
    ],
    category: 'security',
    urgency: 'urgent',
    batchable: false,
  },
  // Auto-handled — AUTO, no action, marketing, receipts
  {
    patterns: [
      /AUTO[,.]?\s*no action/i,
      /\bAUTO\b.*handled/i,
      /marketing email/i,
      /newsletter.*AUTO/i,
      /receipt\s*—.*AUTO/i,
      /already processed/i,
      /promo.*AUTO/i,
    ],
    category: 'auto-handled',
    urgency: 'info',
    batchable: true,
  },
  // Team — acknowledged, team update, no action needed (not AUTO)
  {
    patterns: [
      /acknowledged.*request/i,
      /team is aligned/i,
      /no action needed(?!.*AUTO)/i,
      /FYI\b/i,
    ],
    category: 'team',
    urgency: 'info',
    batchable: true,
  },
  // Account management — signup, verification, activation
  {
    patterns: [
      /signup\s*#?\d/i,
      /verification.*link/i,
      /account.*activation/i,
      /proxy.*signup/i,
      /welcome.*email/i,
    ],
    category: 'account',
    urgency: 'info',
    batchable: false,
  },
  // Email — draft enrichment, SuperPilot
  {
    patterns: [/enriched.*draft/i, /SuperPilot.*draft/i, /draft.*enriched/i],
    category: 'email',
    urgency: 'attention',
    batchable: false,
  },
];

export function classifyMessage(
  text: string,
  dynamicRules?: ClassificationRule[],
): MessageMeta {
  const rules = dynamicRules ?? RULES;
  for (const rule of rules) {
    if (rule.patterns.some((p) => p.test(text))) {
      return {
        category: rule.category,
        urgency: rule.urgency,
        actions: [],
        batchable: rule.batchable,
      };
    }
  }

  // Default: email + info
  return {
    category: 'email',
    urgency: 'info',
    actions: [],
    batchable: false,
  };
}
