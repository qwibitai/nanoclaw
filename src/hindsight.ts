/**
 * Hindsight — auto post-mortem on failed conversations.
 *
 * Detects frustration/failure signals across the full conversation
 * (not single corrections — that's auto-learner's job).
 * Runs a deeper LLM analysis to extract actionable learnings.
 *
 * Host-side module. Single LLM call per detection (step budget: 1).
 * Appends to {groupPath}/learnings/LEARNINGS.md.
 */
import fs from 'node:fs';
import path from 'node:path';

import { logger } from './logger.js';
import { scrubCredentials } from './redaction.js';
import { HindsightReportSchema } from './schemas.js';
import { validateLLMOutput } from './validate-llm.js';
import type { HindsightReport } from './schemas.js';

// ---------------------------------------------------------------------------
// In-memory state
// ---------------------------------------------------------------------------

const cooldowns = new Map<string, number>();
let consecutiveFailures = 0;

const COOLDOWN_MS = 10 * 60 * 1000; // 10 minutes (longer than auto-learner — heavier analysis)
const MAX_CONSECUTIVE_FAILURES = 3;
const MAX_MESSAGE_LENGTH = 2000;
const MAX_FILE_SIZE = 200 * 1024; // 200 KB
const LLM_TIMEOUT_MS = 30_000;
const CIRCUIT_BREAKER_RESET_MS = 15 * 60 * 1000;
const MIN_FRUSTRATION_SIGNALS = 2; // require >= 2 signals to trigger

let circuitBreakerTrippedAt = 0;

// ---------------------------------------------------------------------------
// Frustration detection — regex heuristics (gate before LLM)
// ---------------------------------------------------------------------------

/** Explicit frustration patterns. */
const FRUSTRATION_PATTERNS = [
  /\b(frustrat|annoy|irritat)\w*/i,
  /\byou keep (getting|doing|saying)\b/i,
  /\bthat'?s not what I (asked|wanted|meant|said)\b/i,
  /\bstill (wrong|incorrect|broken|not working)\b/i,
  /\b(useless|terrible|awful|horrible)\b/i,
  /\bwhy (can'?t|won'?t|don'?t) you\b/i,
  /\bhow many times\b/i,
];

/** Abandonment patterns. */
const ABANDONMENT_PATTERNS = [
  /\bforget it\b/i,
  /\bnever ?mind\b/i,
  /\bi'?ll do it myself\b/i,
  /\bdon'?t (bother|worry about it)\b/i,
  /\bjust stop\b/i,
  /\bgive up\b/i,
  /\bthis (isn'?t|is not) (working|helping)\b/i,
];

/** Repeated correction — counted, not pattern-matched like auto-learner. */
const CORRECTION_INDICATORS = [
  /\bno[,.]?\s+(?:it'?s|that'?s|i said|i meant)\b/i,
  /\bactually[,.]?\s/i,
  /\bthat'?s (?:not right|not correct|incorrect|wrong)\b/i,
  /\bi (?:meant|said|asked for)\b/i,
];

export interface FrustrationResult {
  detected: boolean;
  signals: string[];
  correctionCount: number;
}

/**
 * Detect frustration/failure signals across user messages.
 * Returns detected: true only when >= MIN_FRUSTRATION_SIGNALS found.
 */
export function detectFrustration(
  userMessages: Array<{ content: string }>,
): FrustrationResult {
  const signals: string[] = [];
  let correctionCount = 0;

  for (const msg of userMessages) {
    for (const pattern of FRUSTRATION_PATTERNS) {
      if (pattern.test(msg.content)) {
        signals.push(`frustration: "${msg.content.slice(0, 80)}"`);
        break; // one signal per message
      }
    }

    for (const pattern of ABANDONMENT_PATTERNS) {
      if (pattern.test(msg.content)) {
        signals.push(`abandonment: "${msg.content.slice(0, 80)}"`);
        break;
      }
    }

    for (const pattern of CORRECTION_INDICATORS) {
      if (pattern.test(msg.content)) {
        correctionCount++;
        break;
      }
    }
  }

  // Multiple corrections also count as a frustration signal
  if (correctionCount >= 2) {
    signals.push(`repeated corrections: ${correctionCount} found`);
  }

  return {
    detected: signals.length >= MIN_FRUSTRATION_SIGNALS,
    signals,
    correctionCount,
  };
}

// ---------------------------------------------------------------------------
// Hindsight → Markdown serializer
// ---------------------------------------------------------------------------

const SEVERITY_EMOJI: Record<HindsightReport['severity'], string> = {
  critical: '\uD83D\uDD34',
  moderate: '\uD83D\uDFE1',
  minor: '\uD83D\uDFE2',
};

function hindsightToMarkdown(report: HindsightReport, dateStr: string): string {
  const emoji = SEVERITY_EMOJI[report.severity];
  return [
    `### ${dateStr} \u2014 Hindsight (${emoji} ${report.severity})`,
    `- **Failure type:** ${report.failureType}`,
    `- **What went wrong:** ${report.whatWentWrong}`,
    `- **What should have been:** ${report.whatShouldHaveBeen}`,
    `- **Actionable learning:** ${report.actionableLearning}`,
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

export async function processHindsight(
  groupFolder: string,
  userMessages: Array<{
    sender_name: string;
    content: string;
    timestamp: string;
  }>,
  botResponses: string[],
): Promise<void> {
  try {
    // Kill switch
    if (process.env.HINDSIGHT_ENABLED === 'false') return;

    // Need messages
    if (!userMessages || userMessages.length === 0) return;

    // Frustration gate — only call LLM if sufficient signals detected
    const frustration = detectFrustration(userMessages);
    if (!frustration.detected) return;

    // Circuit breaker (with time-based auto-reset)
    if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
      if (
        circuitBreakerTrippedAt > 0 &&
        Date.now() - circuitBreakerTrippedAt >= CIRCUIT_BREAKER_RESET_MS
      ) {
        consecutiveFailures = 0;
        circuitBreakerTrippedAt = 0;
        logger.info('Hindsight circuit breaker reset \u2014 probing');
      } else {
        logger.warn(
          { consecutiveFailures },
          'Hindsight circuit breaker engaged \u2014 skipping',
        );
        return;
      }
    }

    // Per-group cooldown
    const lastSuccess = cooldowns.get(groupFolder);
    if (lastSuccess && Date.now() - lastSuccess < COOLDOWN_MS) {
      return;
    }

    // Resolve path
    const { resolveGroupFolderPath } = await import('./group-folder.js');
    const groupPath = resolveGroupFolderPath(groupFolder);

    const now = new Date();
    const dateStr = now.toISOString().split('T')[0];

    // Check file size cap
    const learningsDir = path.join(groupPath, 'learnings');
    const filePath = path.join(learningsDir, 'LEARNINGS.md');

    if (fs.existsSync(filePath)) {
      try {
        const stat = fs.statSync(filePath);
        if (stat && stat.size >= MAX_FILE_SIZE) {
          logger.warn(
            { filePath, size: stat.size, maxSize: MAX_FILE_SIZE },
            'LEARNINGS.md exceeds 200KB \u2014 skipping hindsight append',
          );
          return;
        }
      } catch {
        // proceed
      }
    }

    // Build conversation text for LLM (scrubbed, truncated)
    const conversationText =
      userMessages
        .map(
          (m) =>
            `[${m.sender_name}] ${scrubCredentials(m.content.slice(0, MAX_MESSAGE_LENGTH))}`,
        )
        .join('\n') +
      '\n' +
      botResponses
        .map((r) => `[bot] ${scrubCredentials(r.slice(0, MAX_MESSAGE_LENGTH))}`)
        .join('\n');

    // LLM call to extract hindsight report
    const systemPrompt = [
      'You are a post-mortem analysis agent. Given a conversation where the user became frustrated or the bot failed, analyze what went wrong and extract actionable learnings.',
      '',
      'Respond with ONLY a JSON object in this exact format (no markdown, no explanation):',
      '{',
      '  "failureType": "category of failure (e.g., hallucination, misunderstanding, wrong tool, repeated error)",',
      '  "whatWentWrong": "specific description of what the bot did wrong",',
      '  "whatShouldHaveBeen": "what the bot should have done instead",',
      '  "actionableLearning": "concrete, reusable lesson for future conversations",',
      '  "severity": "critical" | "moderate" | "minor"',
      '}',
      '',
      'IMPORTANT: Only analyze failures actually present in the conversation. Do not fabricate.',
      'Use "critical" for data loss, wrong actions taken, or security issues.',
      'Use "moderate" for repeated misunderstandings or user frustration.',
      'Use "minor" for minor inconveniences or style issues.',
    ].join('\n');

    const userPrompt = [
      '=== BEGIN UNTRUSTED CONVERSATION ===',
      conversationText,
      '=== END UNTRUSTED CONVERSATION ===',
      '',
      `Detected frustration signals: ${frustration.signals.join('; ')}`,
      'Analyze what went wrong in this conversation and extract a post-mortem learning.',
    ].join('\n');

    // Read secrets
    const { resolveAnthropicApiConfig } = await import('./env.js');
    const { baseUrl, authToken } = resolveAnthropicApiConfig();

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), LLM_TIMEOUT_MS);

    let response: Response;
    try {
      response = await fetch(`${baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${authToken}`,
        },
        body: JSON.stringify({
          model: 'anthropic/claude-sonnet-4-6',
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
          ],
          max_tokens: 1024,
        }),
        signal: controller.signal,
      });
    } catch (err) {
      consecutiveFailures++;
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES)
        circuitBreakerTrippedAt = Date.now();
      logger.warn({ err, consecutiveFailures }, 'Hindsight LLM call failed');
      return;
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) {
      consecutiveFailures++;
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES)
        circuitBreakerTrippedAt = Date.now();
      logger.warn(
        { status: response.status, consecutiveFailures },
        'Hindsight LLM returned non-ok',
      );
      return;
    }

    let rawContent: string;
    try {
      const json = (await response.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      rawContent = json.choices?.[0]?.message?.content ?? '';
    } catch (err) {
      consecutiveFailures++;
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES)
        circuitBreakerTrippedAt = Date.now();
      logger.warn(
        { err, consecutiveFailures },
        'Hindsight failed to parse LLM response',
      );
      return;
    }

    if (!rawContent) {
      consecutiveFailures++;
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES)
        circuitBreakerTrippedAt = Date.now();
      logger.warn(
        { consecutiveFailures },
        'Hindsight received empty LLM response',
      );
      return;
    }

    // Validate against Zod schema
    const validated = await validateLLMOutput({
      raw: rawContent,
      schema: HindsightReportSchema,
      label: 'hindsight',
    });

    if (!validated) {
      consecutiveFailures++;
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES)
        circuitBreakerTrippedAt = Date.now();
      logger.warn({ consecutiveFailures }, 'Hindsight Zod validation failed');
      return;
    }

    // Scrub credentials from validated fields
    validated.failureType = scrubCredentials(validated.failureType);
    validated.whatWentWrong = scrubCredentials(validated.whatWentWrong);
    validated.whatShouldHaveBeen = scrubCredentials(
      validated.whatShouldHaveBeen,
    );
    validated.actionableLearning = scrubCredentials(
      validated.actionableLearning,
    );

    // Serialize to markdown
    const hindsightText = hindsightToMarkdown(validated, dateStr);

    // Reset circuit breaker on success
    consecutiveFailures = 0;

    // Update cooldown
    cooldowns.set(groupFolder, Date.now());

    // Write to file
    fs.mkdirSync(learningsDir, { recursive: true });

    let fileContent: string;
    if (fs.existsSync(filePath)) {
      const existing = fs.readFileSync(filePath, 'utf-8');
      fileContent = existing + '\n' + hindsightText + '\n';
    } else {
      const header = `<!-- source: hindsight -->\n## Learnings\n`;
      fileContent = header + '\n' + hindsightText + '\n';
    }

    fs.writeFileSync(filePath, fileContent, 'utf-8');

    logger.info(
      { groupFolder, filePath, severity: validated.severity },
      'Hindsight logged post-mortem',
    );
  } catch (err) {
    logger.error({ err }, 'Hindsight unexpected error (caught at top level)');
  }
}

// ---------------------------------------------------------------------------
// Test helper — reset in-memory state
// ---------------------------------------------------------------------------

export function _resetForTesting(): void {
  cooldowns.clear();
  consecutiveFailures = 0;
  circuitBreakerTrippedAt = 0;
}
