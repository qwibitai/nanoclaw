/**
 * Self-Improving Memory — reads LEARNINGS.md, proposes CLAUDE.md updates.
 *
 * Host-side module. Single LLM call per run (step budget: 1).
 * Append-only: never proposes deletions or modifications to CLAUDE.md.
 * Output: groups/{folder}/learnings/PROPOSED_UPDATES.md (staged, never auto-applied).
 */
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

import { MEMORY_IMPROVER_ENABLED } from './config.js';
import { logger } from './logger.js';
import { scrubCredentials } from './redaction.js';
import { validateLLMOutput } from './validate-llm.js';

// ---------------------------------------------------------------------------
// In-memory state
// ---------------------------------------------------------------------------

/** Per-group cooldown: last successful improvement time (epoch ms). */
const cooldowns = new Map<string, number>();

/** Consecutive LLM failure count (circuit breaker). */
let consecutiveFailures = 0;

const COOLDOWN_MS = 24 * 60 * 60 * 1000; // 24 hours
const MAX_CONSECUTIVE_FAILURES = 3;
const LLM_TIMEOUT_MS = 30_000;
const CIRCUIT_BREAKER_RESET_MS = 60 * 60 * 1000; // 1 hour auto-reset
const MAX_LEARNINGS_AGE_DAYS = 7;
const MAX_FILE_SIZE = 200 * 1024; // 200 KB
const MAX_TOTAL_CHARS = 50_000;

let circuitBreakerTrippedAt = 0;

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

export const MemoryProposalSchema = z.object({
  section: z.string().min(1).describe('Where in CLAUDE.md to append this'),
  content: z.string().min(1).describe('The line(s) to append'),
  reasoning: z.string().min(1).describe('Why this should be added'),
});

export const MemoryImproverOutputSchema = z.object({
  proposals: z.array(MemoryProposalSchema).max(5),
});

export type MemoryProposal = z.infer<typeof MemoryProposalSchema>;
export type MemoryImproverOutput = z.infer<typeof MemoryImproverOutputSchema>;

// ---------------------------------------------------------------------------
// File readers
// ---------------------------------------------------------------------------

/**
 * Read recent learnings (last 7 days of entries from LEARNINGS.md).
 */
export function readRecentLearnings(groupPath: string): string {
  const learningsPath = path.join(groupPath, 'learnings', 'LEARNINGS.md');

  if (!fs.existsSync(learningsPath)) return '';

  try {
    const stat = fs.statSync(learningsPath);
    if (stat.size > MAX_FILE_SIZE) {
      logger.warn(
        { path: learningsPath, size: stat.size },
        'LEARNINGS.md too large',
      );
      return '';
    }

    const content = fs.readFileSync(learningsPath, 'utf-8');

    // Filter to entries from the last 7 days based on date patterns
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - MAX_LEARNINGS_AGE_DAYS);
    const cutoffStr = cutoff.toISOString().split('T')[0];

    // Split by date headers (## YYYY-MM-DD or --- format)
    const sections = content.split(/(?=^(?:##\s+\d{4}-\d{2}-\d{2}|---\s*\n))/m);
    const recentSections: string[] = [];

    for (const section of sections) {
      const dateMatch = section.match(/(\d{4}-\d{2}-\d{2})/);
      if (dateMatch && dateMatch[1] >= cutoffStr) {
        recentSections.push(section.trim());
      }
    }

    // If no date-sectioned content, return the whole file (it might be unsectioned)
    return recentSections.length > 0 ? recentSections.join('\n\n') : content;
  } catch {
    return '';
  }
}

/**
 * Read current CLAUDE.md for a group.
 */
export function readClaudeMd(groupPath: string): string {
  const claudePath = path.join(groupPath, 'CLAUDE.md');

  if (!fs.existsSync(claudePath)) return '';

  try {
    const stat = fs.statSync(claudePath);
    if (stat.size > MAX_FILE_SIZE) return '';
    return fs.readFileSync(claudePath, 'utf-8');
  } catch {
    return '';
  }
}

// ---------------------------------------------------------------------------
// Proposal formatting
// ---------------------------------------------------------------------------

export function formatProposals(proposals: MemoryProposal[]): string {
  const lines = [
    '# Proposed CLAUDE.md Updates',
    '',
    `Generated: ${new Date().toISOString()}`,
    '',
    'Review these proposals and use `apply_memory_update` to accept individual items.',
    '',
    '---',
    '',
  ];

  for (let i = 0; i < proposals.length; i++) {
    const p = proposals[i];
    lines.push(`## Proposal ${i + 1}`);
    lines.push('');
    lines.push(`**Section:** ${p.section}`);
    lines.push(`**Reasoning:** ${p.reasoning}`);
    lines.push('');
    lines.push('```');
    lines.push(p.content);
    lines.push('```');
    lines.push('');
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

export async function improveMemory(groupFolder: string): Promise<void> {
  try {
    // Kill switch
    if (!MEMORY_IMPROVER_ENABLED) return;

    // Circuit breaker (with time-based auto-reset)
    if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
      if (
        circuitBreakerTrippedAt > 0 &&
        Date.now() - circuitBreakerTrippedAt >= CIRCUIT_BREAKER_RESET_MS
      ) {
        consecutiveFailures = 0;
        circuitBreakerTrippedAt = 0;
        logger.info('Memory improver circuit breaker reset — probing');
      } else {
        logger.warn(
          { consecutiveFailures },
          'Memory improver circuit breaker engaged — skipping',
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

    // Read inputs
    const learnings = readRecentLearnings(groupPath);
    if (!learnings.trim()) {
      logger.debug({ groupFolder }, 'No recent learnings to process');
      return;
    }

    const claudeMd = readClaudeMd(groupPath);

    // Scrub credentials and cap size
    let learningsText = scrubCredentials(learnings);
    if (learningsText.length > MAX_TOTAL_CHARS) {
      learningsText = learningsText.slice(0, MAX_TOTAL_CHARS);
    }

    let claudeMdText = scrubCredentials(claudeMd);
    if (claudeMdText.length > MAX_TOTAL_CHARS) {
      claudeMdText = claudeMdText.slice(0, MAX_TOTAL_CHARS);
    }

    // Build LLM prompt
    const systemPrompt = [
      'You are a memory improvement agent. Given recent learnings and the current CLAUDE.md (agent instructions),',
      'propose additions to CLAUDE.md that would help the agent avoid past mistakes and follow discovered patterns.',
      '',
      'Rules:',
      '- APPEND ONLY: propose new lines to add, never suggest removing or modifying existing content.',
      '- Each proposal should reference a specific learning.',
      '- Proposals should be actionable instructions, not observations.',
      '- Do not duplicate content already in CLAUDE.md.',
      '- Maximum 5 proposals.',
      '',
      'Respond with ONLY a JSON object in this exact format (no markdown, no explanation):',
      '{',
      '  "proposals": [',
      '    {',
      '      "section": "Section header where this should be appended (e.g., ## Patterns, ## Preferences)",',
      '      "content": "The exact line(s) to append",',
      '      "reasoning": "Why this should be added, referencing the specific learning"',
      '    }',
      '  ]',
      '}',
      '',
      'Return empty proposals array if no clear improvements can be made.',
    ].join('\n');

    const userPrompt = [
      '=== CURRENT CLAUDE.MD ===',
      claudeMdText || '(empty — no existing instructions)',
      '=== END CLAUDE.MD ===',
      '',
      '=== RECENT LEARNINGS (LAST 7 DAYS) ===',
      learningsText,
      '=== END LEARNINGS ===',
      '',
      'Propose additions to CLAUDE.md based on these learnings.',
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
          max_tokens: 2048,
        }),
        signal: controller.signal,
      });
    } catch (err) {
      consecutiveFailures++;
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES)
        circuitBreakerTrippedAt = Date.now();
      logger.warn(
        { err, consecutiveFailures },
        'Memory improver LLM call failed',
      );
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
        'Memory improver LLM returned error',
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
      logger.warn('Memory improver LLM returned empty content');
      return;
    }

    // Validate LLM output
    const validated = await validateLLMOutput({
      raw,
      schema: MemoryImproverOutputSchema,
      label: 'memory-improver',
    });

    if (!validated || validated.proposals.length === 0) {
      logger.info({ groupFolder }, 'Memory improver: no proposals generated');
      cooldowns.set(groupFolder, Date.now());
      consecutiveFailures = 0;
      return;
    }

    // Write proposals to staging file
    const learningsDir = path.join(groupPath, 'learnings');
    fs.mkdirSync(learningsDir, { recursive: true });

    const proposalsPath = path.join(learningsDir, 'PROPOSED_UPDATES.md');
    const formatted = formatProposals(validated.proposals);

    const tempPath = `${proposalsPath}.tmp`;
    fs.writeFileSync(tempPath, formatted);
    fs.renameSync(tempPath, proposalsPath);

    // Success — update cooldown and reset circuit breaker
    cooldowns.set(groupFolder, Date.now());
    consecutiveFailures = 0;

    logger.info(
      { groupFolder, proposalCount: validated.proposals.length },
      'Memory improver wrote proposals',
    );
  } catch (err) {
    logger.error({ err, groupFolder }, 'Memory improver unexpected error');
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
