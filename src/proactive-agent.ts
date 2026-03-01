/**
 * Proactive Agent — detects recurring patterns in observer data
 * and suggests automation opportunities.
 *
 * Host-side module. Single LLM call per detection (step budget: 1).
 * Reads last 7 days of observer files, pre-filters by frequency,
 * sends structured suggestions via IPC — never auto-creates routines.
 */
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

import { logger } from './logger.js';
import { validateLLMOutput } from './validate-llm.js';

// ---------------------------------------------------------------------------
// In-memory state
// ---------------------------------------------------------------------------

/** Per-group cooldown: last successful detection time (epoch ms). */
const cooldowns = new Map<string, number>();

/** Consecutive LLM failure count (circuit breaker). */
let consecutiveFailures = 0;

const COOLDOWN_MS = 24 * 60 * 60 * 1000; // 24 hours
const MAX_CONSECUTIVE_FAILURES = 3;
const LLM_TIMEOUT_MS = 30_000;
const CIRCUIT_BREAKER_RESET_MS = 60 * 60 * 1000; // 1 hour auto-reset
const MIN_OBSERVER_FILES = 3;
const MIN_TOPIC_FREQUENCY = 3; // topic must appear 3+ days
const MAX_SUGGESTIONS = 3;
const MAX_FILE_SIZE = 200 * 1024; // 200 KB per observer file
const MAX_TOTAL_CHARS = 50_000;

let circuitBreakerTrippedAt = 0;

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

export const ProactiveSuggestionSchema = z.object({
  pattern: z.string().min(1).describe('The recurring pattern detected'),
  suggestion: z.string().min(1).describe('What automation could handle this'),
  frequency: z.string().min(1).describe('How often this pattern appears'),
});

export const ProactiveOutputSchema = z.object({
  suggestions: z.array(ProactiveSuggestionSchema).max(MAX_SUGGESTIONS),
});

export type ProactiveSuggestion = z.infer<typeof ProactiveSuggestionSchema>;
export type ProactiveOutput = z.infer<typeof ProactiveOutputSchema>;

// ---------------------------------------------------------------------------
// Credential scrubbing (same pattern as observer.ts)
// ---------------------------------------------------------------------------

function scrubCredentials(text: string): string {
  return text
    .replace(/\bghp_[a-zA-Z0-9]+/g, 'ghp_***REDACTED***')
    .replace(/\bAKIA[0-9A-Z]{16}/g, 'AKIA***REDACTED***')
    .replace(/\bxoxb-[a-zA-Z0-9_-]+/g, 'xoxb-***REDACTED***')
    .replace(/\bya29\.[a-zA-Z0-9_-]+/g, 'ya29.***REDACTED***')
    .replace(/\bsk-ant-api\d{2}-[a-zA-Z0-9_-]+/g, 'sk-ant-***REDACTED***')
    .replace(/\b(or-|ant-)[a-zA-Z0-9_-]{10,}/g, '$1***REDACTED***')
    .replace(/\bsk-[a-zA-Z0-9_-]{10,}/g, 'sk-***REDACTED***')
    .replace(/\bpk-[a-zA-Z0-9_-]{10,}/g, 'pk-***REDACTED***')
    .replace(/\b(xai|gsk|eyJ)[a-zA-Z0-9_-]{20,}/g, '$1***REDACTED***')
    .replace(/(Bearer\s+)[a-zA-Z0-9._-]{20,}/gi, '$1***REDACTED***')
    .replace(
      /[A-Za-z0-9]{24}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{27,}/g,
      '***DISCORD_TOKEN_REDACTED***',
    )
    .replace(/\b0x[a-fA-F0-9]{64}\b/g, '0x***PRIVATE_KEY_REDACTED***')
    .replace(/\b[a-fA-F0-9]{40,}\b/g, '***HEX_REDACTED***')
    .replace(
      /(password|passwd|pwd|secret|token|apikey|api_key)\s*[=:]\s*\S+/gi,
      '$1=***REDACTED***',
    );
}

// ---------------------------------------------------------------------------
// Pre-filter: extract topic frequency map from observer files
// ---------------------------------------------------------------------------

interface ObserverFileContent {
  date: string;
  content: string;
}

/**
 * Read the last 7 days of observer files for a group.
 * Returns files that exist and are under the size cap.
 */
export function readRecentObserverFiles(groupPath: string): ObserverFileContent[] {
  const observerDir = path.join(groupPath, 'daily', 'observer');
  if (!fs.existsSync(observerDir)) return [];

  const now = new Date();
  const files: ObserverFileContent[] = [];

  for (let i = 0; i < 7; i++) {
    const date = new Date(now);
    date.setDate(date.getDate() - i);
    const dateStr = date.toISOString().split('T')[0];
    const filePath = path.join(observerDir, `${dateStr}.md`);

    if (!fs.existsSync(filePath)) continue;

    try {
      const stat = fs.statSync(filePath);
      if (stat.size > MAX_FILE_SIZE) continue;

      const content = fs.readFileSync(filePath, 'utf-8');
      files.push({ date: dateStr, content });
    } catch {
      // Skip unreadable files
    }
  }

  return files;
}

/**
 * Extract a frequency map of topics from observer files.
 * A topic is a repeated phrase/keyword that appears across 3+ different days.
 */
export function buildTopicFrequencyMap(
  files: ObserverFileContent[],
): Map<string, number> {
  // Extract words/phrases from each file, track which dates they appear on
  const topicDays = new Map<string, Set<string>>();

  // Common topic extraction patterns
  const TOPIC_PATTERNS = [
    /\*\*(.+?)\*\*/g, // Bold text (markdown topics)
    /(?:^|\n)##?\s+(.+)/gm, // Headers
    /topic:\s*"?(.+?)"?\s*$/gim, // "topic: X" lines
  ];

  for (const file of files) {
    const topics = new Set<string>();

    for (const pattern of TOPIC_PATTERNS) {
      let match;
      // Reset lastIndex for global patterns
      pattern.lastIndex = 0;
      while ((match = pattern.exec(file.content)) !== null) {
        const topic = match[1].trim().toLowerCase();
        if (topic.length >= 3 && topic.length <= 80) {
          topics.add(topic);
        }
      }
    }

    for (const topic of topics) {
      const existing = topicDays.get(topic) || new Set();
      existing.add(file.date);
      topicDays.set(topic, existing);
    }
  }

  // Return only topics that appear on 3+ different days
  const frequencyMap = new Map<string, number>();
  for (const [topic, days] of topicDays) {
    if (days.size >= MIN_TOPIC_FREQUENCY) {
      frequencyMap.set(topic, days.size);
    }
  }

  return frequencyMap;
}

// ---------------------------------------------------------------------------
// Suggestion formatting
// ---------------------------------------------------------------------------

export function formatSuggestionMessage(suggestions: ProactiveSuggestion[]): string {
  const lines = [
    '**Proactive Suggestions** — Based on recurring patterns in your conversations:',
    '',
  ];

  for (let i = 0; i < suggestions.length; i++) {
    const s = suggestions[i];
    lines.push(`**${i + 1}. ${s.pattern}** (${s.frequency})`);
    lines.push(`   → ${s.suggestion}`);
    lines.push('');
  }

  lines.push('_These are suggestions only — no routines were created. Reply if you want to act on any._');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

export async function detectProactiveOpportunities(
  groupFolder: string,
): Promise<void> {
  try {
    // Kill switch
    if (process.env.PROACTIVE_AGENT_ENABLED === 'false') return;

    // Circuit breaker (with time-based auto-reset)
    if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
      if (
        circuitBreakerTrippedAt > 0 &&
        Date.now() - circuitBreakerTrippedAt >= CIRCUIT_BREAKER_RESET_MS
      ) {
        consecutiveFailures = 0;
        circuitBreakerTrippedAt = 0;
        logger.info('Proactive agent circuit breaker reset — probing');
      } else {
        logger.warn(
          { consecutiveFailures },
          'Proactive agent circuit breaker engaged — skipping',
        );
        return;
      }
    }

    // Per-group cooldown (24h)
    const lastSuccess = cooldowns.get(groupFolder);
    if (lastSuccess && Date.now() - lastSuccess < COOLDOWN_MS) {
      return;
    }

    // Resolve safe path
    const { resolveGroupFolderPath } = await import('./group-folder.js');
    const groupPath = resolveGroupFolderPath(groupFolder);

    // Read recent observer files
    const files = readRecentObserverFiles(groupPath);

    // Gate: skip if < 3 observer files exist
    if (files.length < MIN_OBSERVER_FILES) {
      logger.debug(
        { groupFolder, fileCount: files.length },
        'Not enough observer files for proactive detection',
      );
      return;
    }

    // Pre-filter: build topic frequency map
    const frequencyMap = buildTopicFrequencyMap(files);

    if (frequencyMap.size === 0) {
      logger.debug({ groupFolder }, 'No recurring topics found in observer files');
      return;
    }

    // Build condensed context for LLM
    let observerContent = files
      .map((f) => `--- ${f.date} ---\n${scrubCredentials(f.content)}`)
      .join('\n\n');

    if (observerContent.length > MAX_TOTAL_CHARS) {
      observerContent = observerContent.slice(0, MAX_TOTAL_CHARS);
    }

    const recurringTopics = Array.from(frequencyMap.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([topic, days]) => `"${topic}" (${days} days)`)
      .join(', ');

    // Build LLM prompt
    const systemPrompt = [
      'You are a proactive automation advisor. Given observer notes from the past week and a list of recurring topics,',
      'identify patterns that could be automated with scheduled tasks or routines.',
      '',
      'Focus on:',
      '- Tasks the user repeats manually (e.g., checking something daily)',
      '- Questions that come up repeatedly',
      '- Workflows that follow predictable patterns',
      '',
      'IMPORTANT: Only suggest automations based on clear evidence in the data. Do not fabricate patterns.',
      '',
      'Respond with ONLY a JSON object in this exact format (no markdown, no explanation):',
      '{',
      '  "suggestions": [',
      '    {',
      '      "pattern": "Brief description of the recurring pattern",',
      '      "suggestion": "What automation could handle this",',
      '      "frequency": "How often this appears (e.g., daily, 3x/week)"',
      '    }',
      '  ]',
      '}',
      '',
      `Return at most ${MAX_SUGGESTIONS} suggestions. Return empty suggestions array if no clear patterns exist.`,
    ].join('\n');

    const userPrompt = [
      '=== BEGIN OBSERVER NOTES (LAST 7 DAYS) ===',
      observerContent,
      '=== END OBSERVER NOTES ===',
      '',
      `Recurring topics detected: ${recurringTopics}`,
      '',
      'Identify automation opportunities from these patterns.',
    ].join('\n');

    // Read secrets
    const { readEnvFile } = await import('./env.js');
    const secrets = readEnvFile(['ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN']);
    const baseUrl =
      secrets.ANTHROPIC_BASE_URL ||
      process.env.ANTHROPIC_BASE_URL ||
      'https://openrouter.ai/api';
    const authToken =
      secrets.ANTHROPIC_AUTH_TOKEN || process.env.ANTHROPIC_AUTH_TOKEN || '';

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
      logger.warn({ err, consecutiveFailures }, 'Proactive agent LLM call failed');
      return;
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) {
      consecutiveFailures++;
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES)
        circuitBreakerTrippedAt = Date.now();
      const body = await response.text().catch(() => 'unknown');
      logger.warn(
        { status: response.status, body: body.slice(0, 200) },
        'Proactive agent LLM returned error',
      );
      return;
    }

    const data = (await response.json()) as {
      choices: Array<{ message: { content: string } }>;
    };

    const raw = data.choices?.[0]?.message?.content;
    if (!raw) {
      consecutiveFailures++;
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES)
        circuitBreakerTrippedAt = Date.now();
      logger.warn('Proactive agent LLM returned empty content');
      return;
    }

    // Validate LLM output
    const validated = await validateLLMOutput({
      raw,
      schema: ProactiveOutputSchema,
      label: 'proactive-agent',
    });

    if (!validated || validated.suggestions.length === 0) {
      logger.info({ groupFolder }, 'Proactive agent: no actionable suggestions');
      // Still count as success for cooldown purposes
      cooldowns.set(groupFolder, Date.now());
      consecutiveFailures = 0;
      return;
    }

    // Write suggestion to IPC for the agent to pick up
    const { DATA_DIR } = await import('./config.js');
    const ipcDir = path.join(DATA_DIR, 'ipc', groupFolder, 'proactive-suggestions');
    fs.mkdirSync(ipcDir, { recursive: true });

    const suggestionFile = path.join(ipcDir, `${Date.now()}.json`);
    const tempPath = `${suggestionFile}.tmp`;
    fs.writeFileSync(
      tempPath,
      JSON.stringify(
        {
          suggestions: validated.suggestions,
          formattedMessage: formatSuggestionMessage(validated.suggestions),
          timestamp: new Date().toISOString(),
        },
        null,
        2,
      ),
    );
    fs.renameSync(tempPath, suggestionFile);

    // Success — update cooldown and reset circuit breaker
    cooldowns.set(groupFolder, Date.now());
    consecutiveFailures = 0;

    logger.info(
      { groupFolder, suggestionCount: validated.suggestions.length },
      'Proactive agent generated suggestions',
    );
  } catch (err) {
    logger.error({ err, groupFolder }, 'Proactive agent unexpected error');
  }
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** @internal — reset for testing */
export function _resetForTests(): void {
  cooldowns.clear();
  consecutiveFailures = 0;
  circuitBreakerTrippedAt = 0;
}
