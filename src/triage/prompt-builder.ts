import fs from 'fs';
import path from 'path';
import { getRecentExamples } from './examples.js';
import { TRIAGE_DEFAULTS } from './config.js';

export interface PromptBlock {
  type: 'text';
  text: string;
  cache_control?: { type: 'ephemeral' };
}

export interface BuildPromptInput {
  emailBody: string;
  sender: string;
  subject: string;
  superpilotLabel: string | null;
  threadId: string;
  account: string;
  rulesPath?: string; // override for tests
  memoryDir?: string;
}

export interface BuiltPrompt {
  system: string; // joined convenience
  systemBlocks: PromptBlock[];
  userMessage: string;
}

const SYSTEM_CORE = `You are the NanoClaw email triage classifier.

You will classify one email into a strict JSON decision matching this output schema:

{
  "queue": "attention" | "archive_candidate" | "action" | "ignore",
  "confidence": number in [0,1],
  "reasons": string[] (AT LEAST 2 entries, concrete observations, not vibes),
  "action_intent": "bug_report" | "sentry_alert" | "dependabot" |
                   "security_alert" | "deadline" | "receipt" |
                   "knowledge_extract" | "none",
  "facts_extracted": [{"key": string, "value": string, "source_span": string}],
  "repo_candidates": [{"repo": string, "score": number, "signal": string}],
  "attention_reason": string (REQUIRED when queue=attention),
  "archive_category": string (REQUIRED when queue=archive_candidate)
}

Hard rules:
- If queue=attention you MUST include attention_reason.
- If queue=archive_candidate you MUST include archive_category.
- reasons MUST contain at least 2 strings.
- Output JSON only. No prose. No markdown fences.

You will be given stable context first, then the specific email.`;

function readIfExists(p: string): string | null {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return null;
  }
}

function renderExamples(
  examples: ReturnType<typeof getRecentExamples>,
  header: string,
): string {
  if (examples.length === 0) return '';
  const rendered = examples
    .map(
      (ex, i) =>
        `#${i + 1} summary: ${ex.emailSummary}\n` +
        `   agent chose: ${ex.agentQueue} | user corrected to: ${ex.userQueue}\n` +
        `   reasons: ${ex.reasons.join('; ')}`,
    )
    .join('\n');
  return `\n\n${header}\n${rendered}`;
}

export function buildPrompt(input: BuildPromptInput): BuiltPrompt {
  const memoryDir = input.memoryDir ?? path.resolve(process.cwd(), 'memory');
  const rulesPath = input.rulesPath ?? path.join(memoryDir, 'triage_rules.md');
  const rules = readIfExists(rulesPath) ?? '';

  const negatives = getRecentExamples(
    'negative',
    TRIAGE_DEFAULTS.negativeExamplesRetained,
  );
  const positives = getRecentExamples(
    'positive',
    TRIAGE_DEFAULTS.positiveExamplesRetained,
  );

  // Stable blocks (cached, in order). We use 3 cache breakpoints total.
  const stable1: PromptBlock = {
    type: 'text',
    text: SYSTEM_CORE,
    cache_control: { type: 'ephemeral' },
  };
  const stable2: PromptBlock = {
    type: 'text',
    text: `USER STANDING RULES (hard constraints):\n\n${rules || '(none)'}`,
    cache_control: { type: 'ephemeral' },
  };
  const stable3: PromptBlock = {
    type: 'text',
    text:
      `NEGATIVE EXAMPLES — user corrected the agent. Avoid repeating these mistakes:` +
      (renderExamples(negatives, '') || '\n(none yet)'),
    cache_control: { type: 'ephemeral' },
  };
  const rotating: PromptBlock = {
    type: 'text',
    text:
      `RECENT POSITIVE EXAMPLES — user confirmed these were correct:` +
      (renderExamples(positives, '') || '\n(none yet)'),
  };

  const systemBlocks: PromptBlock[] = [stable1, stable2, stable3, rotating];

  const userMessage = [
    `Email to classify:`,
    `From: ${input.sender}`,
    `Subject: ${input.subject}`,
    `Account: ${input.account}`,
    `Thread-ID: ${input.threadId}`,
    `SuperPilot label: ${input.superpilotLabel ?? '(none)'}`,
    ``,
    `--- body ---`,
    input.emailBody,
    `--- /body ---`,
    ``,
    `Return the JSON decision now.`,
  ].join('\n');

  const system = systemBlocks.map((b) => b.text).join('\n\n');
  return { system, systemBlocks, userMessage };
}
