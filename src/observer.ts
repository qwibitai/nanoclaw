/**
 * Observer — compresses conversations into prioritized observations via LLM.
 *
 * Host-side module. Single LLM call per observation (step budget: 1).
 * Appends to daily/observer/{date}.md with priority markers and timestamps.
 */
import fs from 'node:fs';
import path from 'node:path';

import { logger } from './logger.js';
import { ObservationOutputSchema, observationToMarkdown } from './schemas.js';
import { validateLLMOutput } from './validate-llm.js';

// ---------------------------------------------------------------------------
// In-memory state
// ---------------------------------------------------------------------------

/** Per-group cooldown: last successful observation time (epoch ms). */
const cooldowns = new Map<string, number>();

/** Consecutive LLM failure count (circuit breaker). */
let consecutiveFailures = 0;

const COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes
const MAX_CONSECUTIVE_FAILURES = 3;
const MAX_MESSAGES = 50;
const MAX_MESSAGE_LENGTH = 2000; // chars per message (P1-1: prevent cost spiral)
const MAX_TOTAL_CHARS = 50_000; // total conversation text cap (P1-1)
const MAX_FILE_SIZE = 200 * 1024; // 200 KB
const LLM_TIMEOUT_MS = 30_000;
const CIRCUIT_BREAKER_RESET_MS = 15 * 60 * 1000; // 15 min auto-reset (P1-2)

/** Epoch ms when circuit breaker tripped (0 = never tripped). */
let circuitBreakerTrippedAt = 0;

// ---------------------------------------------------------------------------
// Credential scrubbing (reused pattern from container-runner.ts + additions)
// ---------------------------------------------------------------------------

function scrubCredentials(text: string): string {
  return text
    // GitHub personal access tokens (before generic patterns)
    .replace(/\bghp_[a-zA-Z0-9]+/g, 'ghp_***REDACTED***')
    // AWS access key IDs
    .replace(/\bAKIA[0-9A-Z]{16}/g, 'AKIA***REDACTED***')
    // Slack bot tokens
    .replace(/\bxoxb-[a-zA-Z0-9_-]+/g, 'xoxb-***REDACTED***')
    // Google OAuth tokens
    .replace(/\bya29\.[a-zA-Z0-9_-]+/g, 'ya29.***REDACTED***')
    // Anthropic API keys (sk-ant-apiNN-...)
    .replace(/\bsk-ant-api\d{2}-[a-zA-Z0-9_-]+/g, 'sk-ant-***REDACTED***')
    // OpenRouter / Anthropic prefix keys (or-..., ant-...)
    .replace(/\b(or-|ant-)[a-zA-Z0-9_-]{10,}/g, '$1***REDACTED***')
    // sk- and pk- prefixed API keys (OpenAI, Stripe, etc.)
    .replace(/\bsk-[a-zA-Z0-9_-]{10,}/g, 'sk-***REDACTED***')
    .replace(/\bpk-[a-zA-Z0-9_-]{10,}/g, 'pk-***REDACTED***')
    // API keys (xai-..., gsk-..., eyJ...)
    .replace(/\b(xai|gsk|eyJ)[a-zA-Z0-9_-]{20,}/g, '$1***REDACTED***')
    // Bearer tokens
    .replace(/(Bearer\s+)[a-zA-Z0-9._-]{20,}/gi, '$1***REDACTED***')
    // Discord bot tokens (base64.base64.base64)
    .replace(
      /[A-Za-z0-9]{24}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{27,}/g,
      '***DISCORD_TOKEN_REDACTED***',
    )
    // Private keys (hex, 64 chars)
    .replace(/\b0x[a-fA-F0-9]{64}\b/g, '0x***PRIVATE_KEY_REDACTED***')
    // Generic long hex secrets (32+ chars)
    .replace(/\b[a-fA-F0-9]{40,}\b/g, '***HEX_REDACTED***')
    // Password patterns
    .replace(
      /(password|passwd|pwd|secret|token|apikey|api_key)\s*[=:]\s*\S+/gi,
      '$1=***REDACTED***',
    );
}

// ---------------------------------------------------------------------------
// Output validation (prompt injection defense)
// ---------------------------------------------------------------------------

const INJECTION_PATTERNS = [
  /ignore previous/i,
  /\bsystem:/i,
  /\[ADMIN\]/i,
];

function containsInjection(text: string): boolean {
  return INJECTION_PATTERNS.some((p) => p.test(text));
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

export async function observeConversation(
  groupFolder: string,
  userMessages: Array<{ sender_name: string; content: string; timestamp: string }>,
  botResponses: string[],
): Promise<void> {
  try {
    // Kill switch
    if (process.env.OBSERVER_ENABLED === 'false') return;

    // Reject empty / no-user-message conversations
    if (!userMessages || userMessages.length === 0) return;

    // Circuit breaker (with time-based auto-reset — P1-2)
    if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
      if (circuitBreakerTrippedAt > 0 && Date.now() - circuitBreakerTrippedAt >= CIRCUIT_BREAKER_RESET_MS) {
        consecutiveFailures = 0;
        circuitBreakerTrippedAt = 0;
        logger.info('Observer circuit breaker reset — probing');
      } else {
        logger.warn({ consecutiveFailures }, 'Observer circuit breaker engaged — skipping');
        return;
      }
    }

    // Per-group cooldown (only successful observations update it)
    const lastSuccess = cooldowns.get(groupFolder);
    if (lastSuccess && Date.now() - lastSuccess < COOLDOWN_MS) {
      return;
    }

    // Resolve safe path (lazy import to avoid module-load cascade in tests)
    const { resolveGroupFolderPath } = await import('./group-folder.js');
    const groupPath = resolveGroupFolderPath(groupFolder);

    // Build today's date from Node.js (never from LLM)
    const now = new Date();
    const dateStr = now.toISOString().split('T')[0]; // YYYY-MM-DD

    // Check file size cap BEFORE calling LLM
    const observerDir = path.join(groupPath, 'daily', 'observer');
    const filePath = path.join(observerDir, `${dateStr}.md`);

    if (fs.existsSync(filePath)) {
      try {
        const stat = fs.statSync(filePath);
        if (stat && stat.size >= MAX_FILE_SIZE) {
          logger.warn(
            { filePath, size: stat.size, maxSize: MAX_FILE_SIZE },
            'Daily observer file exceeds 200KB — skipping append',
          );
          return;
        }
      } catch {
        // statSync failed — proceed (don't block on stat errors)
      }
    }

    // Build conversation payload (truncate to MAX_MESSAGES, drop oldest first)
    type MsgEntry = { role: 'user' | 'bot'; text: string; timestamp?: string };
    const allMessages: MsgEntry[] = [];

    for (const m of userMessages) {
      allMessages.push({ role: 'user', text: m.content.slice(0, MAX_MESSAGE_LENGTH), timestamp: m.timestamp });
    }
    for (const r of botResponses) {
      allMessages.push({ role: 'bot', text: r.slice(0, MAX_MESSAGE_LENGTH) });
    }

    // Truncate oldest if exceeds MAX_MESSAGES
    const truncated =
      allMessages.length > MAX_MESSAGES
        ? allMessages.slice(allMessages.length - MAX_MESSAGES)
        : allMessages;

    // Scrub credentials from conversation text, then cap total size (P1-1)
    let conversationText = truncated
      .map((m) => `[${m.role}] ${scrubCredentials(m.text)}`)
      .join('\n');
    if (conversationText.length > MAX_TOTAL_CHARS) {
      conversationText = conversationText.slice(-MAX_TOTAL_CHARS);
    }

    // Build LLM prompt with hard delimiters — request JSON for Zod validation
    const systemPrompt = [
      'You are an observation extraction agent. Given a conversation between a user and a bot assistant, extract key observations.',
      'Assign priorities:',
      '  "critical" — decisions, commitments, errors, action items',
      '  "useful" — preferences, context, ongoing topics',
      '  "noise" — pleasantries, trivial exchanges',
      'For each observation, note any referenced dates (dates mentioned in the conversation).',
      '',
      'IMPORTANT: Only report what is actually in the conversation. Do not fabricate information.',
      '',
      'Respond with ONLY a JSON object in this exact format (no markdown, no explanation):',
      '{',
      '  "observations": [',
      '    {',
      '      "time": "HH:MM",',
      '      "topic": "Brief topic summary",',
      '      "priority": "critical" | "useful" | "noise",',
      '      "points": ["Key observation 1", "Key observation 2"],',
      '      "referencedDates": ["YYYY-MM-DD"]',
      '    }',
      '  ]',
      '}',
    ].join('\n');

    const userPrompt = [
      '=== BEGIN UNTRUSTED CONVERSATION ===',
      conversationText,
      '=== END UNTRUSTED CONVERSATION ===',
      '',
      `Observation date: ${dateStr}`,
      'Extract observations from the conversation above.',
    ].join('\n');

    // Read secrets from .env file (P1-3: consistent with project security model)
    const { readEnvFile } = await import('./env.js');
    const secrets = readEnvFile(['ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN']);
    const baseUrl = secrets.ANTHROPIC_BASE_URL || process.env.ANTHROPIC_BASE_URL || 'https://openrouter.ai/api';
    const authToken = secrets.ANTHROPIC_AUTH_TOKEN || process.env.ANTHROPIC_AUTH_TOKEN || '';

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
          max_tokens: 2048,
        }),
        signal: controller.signal,
      });
    } catch (err) {
      consecutiveFailures++;
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) circuitBreakerTrippedAt = Date.now();
      logger.warn({ err, consecutiveFailures }, 'Observer LLM call failed');
      return;
    } finally {
      clearTimeout(timeout);
    }

    // Handle non-ok responses
    if (!response.ok) {
      consecutiveFailures++;
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) circuitBreakerTrippedAt = Date.now();
      logger.warn(
        { status: response.status, consecutiveFailures },
        'Observer LLM returned non-ok status',
      );
      return;
    }

    // Parse LLM response — extract content string
    let rawContent: string;
    try {
      const json = await response.json() as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      rawContent = json.choices?.[0]?.message?.content ?? '';
    } catch (err) {
      consecutiveFailures++;
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) circuitBreakerTrippedAt = Date.now();
      logger.warn({ err, consecutiveFailures }, 'Observer failed to parse LLM response');
      return;
    }

    if (!rawContent) {
      consecutiveFailures++;
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) circuitBreakerTrippedAt = Date.now();
      logger.warn({ consecutiveFailures }, 'Observer received empty LLM response');
      return;
    }

    // Validate output — reject injection patterns (check raw text before parsing)
    if (containsInjection(rawContent)) {
      logger.warn('Observer rejected LLM output containing instruction patterns');
      return;
    }

    // Validate against Zod schema FIRST (raw JSON must be structurally valid)
    const validated = await validateLLMOutput({
      raw: rawContent,
      schema: ObservationOutputSchema,
      label: 'observer',
    });

    if (!validated) {
      consecutiveFailures++;
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) circuitBreakerTrippedAt = Date.now();
      logger.warn({ consecutiveFailures }, 'Observer Zod validation failed after retry');
      return;
    }

    // Scrub credentials from validated fields (NOT raw JSON — regex breaks JSON structure)
    for (const obs of validated.observations) {
      obs.topic = scrubCredentials(obs.topic);
      obs.points = obs.points.map((p) => scrubCredentials(p));
    }

    // Serialize validated + scrubbed data to markdown (backwards-compatible format)
    const observationText = observationToMarkdown(validated, dateStr);

    // Reset circuit breaker on success
    consecutiveFailures = 0;

    // Update cooldown for this group
    cooldowns.set(groupFolder, Date.now());

    // Build file content
    fs.mkdirSync(observerDir, { recursive: true });

    let fileContent: string;
    if (fs.existsSync(filePath)) {
      const existing = fs.readFileSync(filePath, 'utf-8');
      fileContent = existing + '\n' + observationText + '\n';
    } else {
      const header = `<!-- source: observer -->\n## Observations \u2014 ${dateStr}\n`;
      fileContent = header + '\n' + observationText + '\n';
    }

    fs.writeFileSync(filePath, fileContent, 'utf-8');

    logger.info({ groupFolder, filePath }, 'Observer appended observations');
  } catch (err) {
    logger.error({ err }, 'Observer unexpected error (caught at top level)');
  }
}

// ---------------------------------------------------------------------------
// Test helper — reset in-memory state
// ---------------------------------------------------------------------------

export function _resetCooldownsForTesting(): void {
  cooldowns.clear();
  consecutiveFailures = 0;
  circuitBreakerTrippedAt = 0;
}
