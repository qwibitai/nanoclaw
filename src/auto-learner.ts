/**
 * Auto-Learner — detects corrections in conversation and logs learnings.
 *
 * Host-side module. Single LLM call per detection (step budget: 1).
 * Appends to {groupPath}/learnings/LEARNINGS.md.
 */
import fs from 'node:fs';
import path from 'node:path';

import { logger } from './logger.js';
import { scrubCredentials } from './redaction.js';
import { LearningEntrySchema } from './schemas.js';
import { validateLLMOutput } from './validate-llm.js';
import type { LearningEntry } from './schemas.js';

// ---------------------------------------------------------------------------
// In-memory state
// ---------------------------------------------------------------------------

/** Per-group cooldown: last successful learning time (epoch ms). */
const cooldowns = new Map<string, number>();

/** Consecutive LLM failure count (circuit breaker). */
let consecutiveFailures = 0;

const COOLDOWN_MS = 2 * 60 * 1000; // 2 minutes (shorter than observer — corrections are rarer)
const MAX_CONSECUTIVE_FAILURES = 3;
const MAX_MESSAGE_LENGTH = 2000;
const MAX_FILE_SIZE = 200 * 1024; // 200 KB
const LLM_TIMEOUT_MS = 30_000;
const CIRCUIT_BREAKER_RESET_MS = 15 * 60 * 1000;

let circuitBreakerTrippedAt = 0;

// ---------------------------------------------------------------------------
// Correction detection — regex heuristic (gate before LLM call)
// ---------------------------------------------------------------------------

const CORRECTION_PATTERNS = [
  /\bno[,.]?\s+(?:it'?s|that'?s|the|my|his|her|its|their)\b/i,
  /\bactually[,.]?\s+(?:it'?s|that'?s|the|i|we|my)\b/i,
  /\bwrong[,.]?\s+(?:it'?s|that'?s|the)\b/i,
  /\bthat'?s (?:not right|not correct|incorrect|wrong)\b/i,
  /\bi (?:meant|said|asked for)\b/i,
  /\bnot\s+\w+[,.]?\s+(?:it'?s|it is)\b/i,
  /\byou (?:got it wrong|misunderstood|confused)\b/i,
  /\bno[,.]?\s+(?:i said|i meant|i want)\b/i,
  /\bcorrection:/i,
  /\blet me correct\b/i,
  /\bto clarify[,:]\b/i,
];

/**
 * Check if any user message contains a correction pattern.
 * Returns the first matching message, or null if none.
 */
export function detectCorrection(
  userMessages: Array<{ content: string }>,
): { message: string; pattern: string } | null {
  for (const msg of userMessages) {
    for (const pattern of CORRECTION_PATTERNS) {
      if (pattern.test(msg.content)) {
        return {
          message: msg.content,
          pattern: pattern.source,
        };
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Learning → Markdown serializer
// ---------------------------------------------------------------------------

function learningToMarkdown(entry: LearningEntry, dateStr: string): string {
  return [
    `### ${dateStr} — Correction logged`,
    `- **Wrong:** ${entry.correction.wrong}`,
    `- **Right:** ${entry.correction.right}`,
    `- **Source:** ${entry.source}`,
    `- **Knowledge file:** ${entry.knowledgeFile}`,
    `- **Context:** ${entry.context}`,
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

export async function processLearning(
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
    if (process.env.AUTO_LEARNER_ENABLED === 'false') return;

    // Need at least 1 user message
    if (!userMessages || userMessages.length === 0) return;

    // Regex gate — only call LLM if correction detected
    const correction = detectCorrection(userMessages);
    if (!correction) return;

    // Circuit breaker (with time-based auto-reset)
    if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
      if (
        circuitBreakerTrippedAt > 0 &&
        Date.now() - circuitBreakerTrippedAt >= CIRCUIT_BREAKER_RESET_MS
      ) {
        consecutiveFailures = 0;
        circuitBreakerTrippedAt = 0;
        logger.info('Auto-learner circuit breaker reset — probing');
      } else {
        logger.warn(
          { consecutiveFailures },
          'Auto-learner circuit breaker engaged — skipping',
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
            'LEARNINGS.md exceeds 200KB — skipping append',
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

    // LLM call to extract structured learning
    const systemPrompt = [
      'You are a correction extraction agent. Given a conversation where a user corrected a bot, extract what was wrong and what is right.',
      '',
      'Respond with ONLY a JSON object in this exact format (no markdown, no explanation):',
      '{',
      '  "correction": { "wrong": "what the bot said/assumed incorrectly", "right": "the correct information" },',
      '  "source": "conversation",',
      '  "knowledgeFile": "which file to update (e.g. people.md, operational.md, preferences.md)",',
      '  "context": "brief surrounding context for this correction"',
      '}',
      '',
      'IMPORTANT: Only extract corrections actually present in the conversation. Do not fabricate.',
      'Choose knowledgeFile from: people.md, operational.md, preferences.md, decisions.md',
    ].join('\n');

    const userPrompt = [
      '=== BEGIN UNTRUSTED CONVERSATION ===',
      conversationText,
      '=== END UNTRUSTED CONVERSATION ===',
      '',
      `Detected correction pattern in: "${correction.message.slice(0, 200)}"`,
      'Extract the correction from the conversation above.',
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
      logger.warn({ err, consecutiveFailures }, 'Auto-learner LLM call failed');
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
        'Auto-learner LLM returned non-ok',
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
        'Auto-learner failed to parse LLM response',
      );
      return;
    }

    if (!rawContent) {
      consecutiveFailures++;
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES)
        circuitBreakerTrippedAt = Date.now();
      logger.warn(
        { consecutiveFailures },
        'Auto-learner received empty LLM response',
      );
      return;
    }

    // Validate against Zod schema
    const validated = await validateLLMOutput({
      raw: rawContent,
      schema: LearningEntrySchema,
      label: 'auto-learner',
    });

    if (!validated) {
      consecutiveFailures++;
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES)
        circuitBreakerTrippedAt = Date.now();
      logger.warn(
        { consecutiveFailures },
        'Auto-learner Zod validation failed',
      );
      return;
    }

    // Scrub credentials from validated fields
    validated.correction.wrong = scrubCredentials(validated.correction.wrong);
    validated.correction.right = scrubCredentials(validated.correction.right);
    validated.context = scrubCredentials(validated.context);

    // Serialize to markdown
    const learningText = learningToMarkdown(validated, dateStr);

    // Reset circuit breaker on success
    consecutiveFailures = 0;

    // Update cooldown
    cooldowns.set(groupFolder, Date.now());

    // Write to file
    fs.mkdirSync(learningsDir, { recursive: true });

    let fileContent: string;
    if (fs.existsSync(filePath)) {
      const existing = fs.readFileSync(filePath, 'utf-8');
      fileContent = existing + '\n' + learningText + '\n';
    } else {
      const header = `<!-- source: auto-learner -->\n## Learnings\n`;
      fileContent = header + '\n' + learningText + '\n';
    }

    fs.writeFileSync(filePath, fileContent, 'utf-8');

    logger.info(
      { groupFolder, filePath, knowledgeFile: validated.knowledgeFile },
      'Auto-learner logged correction',
    );
  } catch (err) {
    logger.error(
      { err },
      'Auto-learner unexpected error (caught at top level)',
    );
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
