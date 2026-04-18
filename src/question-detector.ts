import type { Action } from './types.js';

export interface DetectedQuestion {
  type: 'yes-no' | 'financial-confirm' | 'multi-option';
  questionId: string;
  actions: Action[];
}

let questionCounter = 0;

function nextQuestionId(): string {
  return `q_${Date.now()}_${++questionCounter}`;
}

const YES_NO_PATTERNS = [
  /want me to\b.*\?$/im,
  /should I\b.*\?$/im,
  /shall I\b.*\?$/im,
  /do you want\b.*\?$/im,
  /would you like\b.*\?$/im,
  /can I\b.*\?$/im,
  /okay to\b.*\?$/im,
  /approve this\??$/im,
  /is this correct\??$/im,
  /handle this\??$/im,
];

const FINANCIAL_CONFIRM_PATTERNS = [
  /(?:were|was).*expected\?$/im,
  /all expected\?$/im,
  /confirm.*(?:wire|deposit|payment|transfer)/im,
  /expected.*\?$/im,
];

/**
 * Detect if outbound text contains a question and return appropriate button config.
 * Returns null if no question is detected.
 */
export function detectQuestion(text: string): DetectedQuestion | null {
  // Only look at the last 200 characters for the question
  const tail = text.slice(-200);

  // Check financial first (more specific)
  if (FINANCIAL_CONFIRM_PATTERNS.some((p) => p.test(tail))) {
    const qid = nextQuestionId();
    return {
      type: 'financial-confirm',
      questionId: qid,
      actions: [
        {
          label: 'Yes, all expected',
          callbackData: `answer:${qid}:yes`,
          style: 'primary',
        },
        {
          label: 'Not all — review',
          callbackData: `answer:${qid}:review`,
          style: 'destructive-safe',
        },
        {
          label: 'Details ↗',
          callbackData: `answer:${qid}:details`,
          style: 'secondary',
        },
      ],
    };
  }

  // Check yes/no
  if (YES_NO_PATTERNS.some((p) => p.test(tail))) {
    const qid = nextQuestionId();
    return {
      type: 'yes-no',
      questionId: qid,
      actions: [
        {
          label: '✅ Yes',
          callbackData: `answer:${qid}:yes`,
          style: 'primary',
        },
        {
          label: '❌ No',
          callbackData: `answer:${qid}:no`,
          style: 'destructive-safe',
        },
        {
          label: '⏳ Let me think…',
          callbackData: `answer:${qid}:defer`,
          style: 'secondary',
        },
      ],
    };
  }

  return null;
}
