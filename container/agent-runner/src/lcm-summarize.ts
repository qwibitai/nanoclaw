/**
 * LCM Summarization Logic
 * Leaf summaries from raw messages, condensation of leaf summaries,
 * and deterministic fallback when API is unavailable.
 */

import crypto from 'crypto';

// --- Configuration ---

const LCM_SUMMARY_MODEL = process.env.LCM_SUMMARY_MODEL || 'claude-haiku-4-5-20251001';
const LCM_SUMMARIZE_TIMEOUT_MS = parseInt(process.env.LCM_SUMMARIZE_TIMEOUT_MS || '15000', 10);
const LCM_CONDENSE_THRESHOLD = parseInt(process.env.LCM_CONDENSE_THRESHOLD || '8', 10);
const MAX_CONDENSE_DEPTH = 3;

export { LCM_CONDENSE_THRESHOLD };

// --- Types ---

export interface ParsedMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface SummaryResult {
  id: string;
  content: string;
  sourceMessageIds: string[];
  minSequence: number;
  maxSequence: number;
}

export interface CondensedResult {
  id: string;
  content: string;
  childSummaryIds: string[];
  minSequence: number;
  maxSequence: number;
  depth: number;
}

// --- Deterministic fallback ---

function deterministicSummary(messages: ParsedMessage[]): string {
  const lines: string[] = ['[Deterministic summary — API unavailable]'];
  for (const msg of messages) {
    const msgLines = msg.content.split('\n').filter(l => l.trim());
    const first3 = msgLines.slice(0, 3).join('\n');
    const last3 = msgLines.length > 6 ? msgLines.slice(-3).join('\n') : '';
    lines.push(`[${msg.role}]: ${first3}${last3 ? '\n...\n' + last3 : ''}`);
  }
  return lines.join('\n\n');
}

function deterministicCondensation(summaryContents: string[]): string {
  const lines: string[] = ['[Deterministic condensation — API unavailable]'];
  for (const content of summaryContents) {
    // Take first 5 and last 3 lines of each summary
    const cLines = content.split('\n').filter(l => l.trim());
    const first5 = cLines.slice(0, 5).join('\n');
    const last3 = cLines.length > 8 ? cLines.slice(-3).join('\n') : '';
    lines.push(first5 + (last3 ? '\n...\n' + last3 : ''));
  }
  return lines.join('\n---\n');
}

// --- API-based summarization ---

function hasApiCredentials(): boolean {
  return !!(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
}

async function callAnthropicAPI(systemPrompt: string, userContent: string): Promise<string | null> {
  if (!hasApiCredentials()) {
    console.error('[lcm-summarize] No API key or auth token available, skipping API call');
    return null;
  }

  const baseUrl = process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com';
  const apiKey = process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN || '';

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), LCM_SUMMARIZE_TIMEOUT_MS);

  try {
    const response = await fetch(`${baseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: LCM_SUMMARY_MODEL,
        max_tokens: 2048,
        system: systemPrompt,
        messages: [{ role: 'user', content: userContent }],
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      console.error(`[lcm-summarize] API error: ${response.status} ${response.statusText}`);
      return null;
    }

    const data = await response.json() as { content: Array<{ type: string; text: string }> };
    const textParts = data.content?.filter(c => c.type === 'text').map(c => c.text);
    return textParts?.join('') || null;
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      console.error(`[lcm-summarize] API call timed out after ${LCM_SUMMARIZE_TIMEOUT_MS}ms`);
    } else {
      console.error(`[lcm-summarize] API call failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

function generateSummaryId(): string {
  return `sum_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;
}

// --- Public API ---

/**
 * Create a leaf summary (depth 0) from raw messages.
 */
export async function createLeafSummary(
  messages: ParsedMessage[],
  messageIds: string[],
  minSequence: number,
  maxSequence: number,
): Promise<SummaryResult> {
  const id = generateSummaryId();

  const systemPrompt = `You are a conversation summarizer. Create a concise but comprehensive summary of the following conversation segment. Preserve:
- Key decisions and conclusions
- Important facts, names, and numbers
- Action items and commitments
- Technical details that may be referenced later
Keep the summary under 500 words. Be factual and precise.`;

  const transcript = messages
    .map(m => `[${m.role}]: ${m.content}`)
    .join('\n\n');

  const apiResult = await callAnthropicAPI(systemPrompt, transcript);
  const content = apiResult || deterministicSummary(messages);

  return { id, content, sourceMessageIds: messageIds, minSequence, maxSequence };
}

/**
 * Create a condensed summary (depth 1+) from existing summaries.
 */
export async function createCondensedSummary(
  summaries: Array<{ id: string; content: string; min_sequence: number | null; max_sequence: number | null; depth: number }>,
): Promise<CondensedResult> {
  const id = generateSummaryId();
  const maxChildDepth = Math.max(...summaries.map(s => s.depth));
  const newDepth = maxChildDepth + 1;

  // Cap at MAX_CONDENSE_DEPTH — still summarize (or truncate) rather than
  // concatenating unbounded content.
  if (newDepth > MAX_CONDENSE_DEPTH) {
    const TOKEN_CAP = 10000; // ~40KB of text
    const charCap = TOKEN_CAP * 4;

    // Try API summarization first, fall back to truncated concatenation
    const userContent = summaries
      .map((s, i) => `--- Summary ${i + 1} ---\n${s.content}`)
      .join('\n\n');

    const apiResult = await callAnthropicAPI(
      'You are condensing multiple conversation summaries into one. Be comprehensive but concise. Under 400 words.',
      userContent,
    );

    let content: string;
    if (apiResult) {
      content = apiResult;
    } else {
      // Deterministic fallback with token cap
      const joined = summaries.map(s => s.content).join('\n\n---\n\n');
      content = joined.length > charCap
        ? joined.slice(0, charCap) + '\n\n[Truncated — exceeded token cap]'
        : joined;
    }

    return {
      id,
      content,
      childSummaryIds: summaries.map(s => s.id),
      minSequence: Math.min(...summaries.map(s => s.min_sequence ?? Infinity)),
      maxSequence: Math.max(...summaries.map(s => s.max_sequence ?? -Infinity)),
      depth: MAX_CONDENSE_DEPTH,
    };
  }

  const systemPrompt = `You are a conversation summarizer performing hierarchical condensation. You are given multiple summaries of conversation segments. Create a higher-level summary that captures the essential information from all of them. Preserve:
- Overall narrative arc and progression
- Key decisions and their rationale
- Important facts and commitments
- Anything that might be referenced in future conversation
Keep the condensed summary under 400 words. Be comprehensive but concise.`;

  const userContent = summaries
    .map((s, i) => `--- Summary ${i + 1} ---\n${s.content}`)
    .join('\n\n');

  const apiResult = await callAnthropicAPI(systemPrompt, userContent);
  const content = apiResult || deterministicCondensation(summaries.map(s => s.content));

  return {
    id,
    content,
    childSummaryIds: summaries.map(s => s.id),
    minSequence: Math.min(...summaries.map(s => s.min_sequence ?? Infinity)),
    maxSequence: Math.max(...summaries.map(s => s.max_sequence ?? -Infinity)),
    depth: newDepth,
  };
}
