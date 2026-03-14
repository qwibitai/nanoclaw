/**
 * Full reflection lifecycle: build payloads, store, load, rank, dedup.
 * Integrates LanceDB storage with file-based .learnings/ persistence.
 *
 * Adapted for NanoClaw's container model:
 * - Session = one container invocation
 * - Agent ID = group folder name
 * - Workspace = /workspace/group/
 * - Reflections stored in LanceDB with `reflection` category + in .learnings/
 *
 * Ported from memory-lancedb-pro.
 */

import { memoryStore, memorySearch } from './memory.js';
import { inferReflectionKind } from './reflection-metadata.js';
import type { ReflectionKind } from './reflection-metadata.js';
import { getReflectionDecayConfig } from './reflection-mapped-metadata.js';
import { computeReflectionScore, normalizeAndRank } from './reflection-ranking.js';
import { extractSlices } from './reflection-slices.js';
import type { ReflectionSlice } from './reflection-slices.js';
import { createReflectionItem, listReflectionItems } from './reflection-item-store.js';
import { recordReflectionEvent } from './reflection-event-store.js';
import { logLearning } from './self-improvement-files.js';
import { withRetry } from './reflection-retry.js';
import { llmJsonCompletion, isExtractionAvailable } from './llm-client.js';

// ============================================================================
// Types
// ============================================================================

export interface ReflectionPayload {
  /** Reflection text */
  text: string;
  /** Inferred kind */
  kind: ReflectionKind;
  /** Extracted slices (structured data) */
  slices: ReflectionSlice[];
  /** Importance score */
  importance: number;
  /** Source trigger */
  source: 'precompact' | 'session_end' | 'manual';
}

export interface ReflectionResult {
  /** Number of reflections generated */
  generated: number;
  /** Number stored (after dedup) */
  stored: number;
  /** Number deduplicated (skipped) */
  deduped: number;
  /** Reflections stored */
  reflections: ReflectionPayload[];
}

// ============================================================================
// Reflection System Prompt
// ============================================================================

const REFLECTION_SYSTEM_PROMPT = `You are a reflection system for an AI assistant. Given a conversation transcript, extract key reflections that would help the assistant work better in future sessions.

Focus on:
1. Decisions made and their reasoning
2. User preferences and communication style observed
3. Lessons learned from mistakes or successes
4. Patterns in user behavior or requests
5. Self-improvement insights about approach or strategy

For each reflection, provide:
- "text": A clear, actionable statement
- "kind": One of: decision, user-model, agent-model, lesson, pattern, meta
- "importance": 0.0-1.0

Respond with JSON: { "reflections": [{ "text": "...", "kind": "...", "importance": 0.0-1.0 }, ...] }
If no meaningful reflections, respond: { "reflections": [] }`;

function buildReflectionUserPrompt(conversationText: string): string {
  return `Extract reflections from this conversation:

${conversationText.slice(0, 6000)}

Respond with JSON: { "reflections": [{ "text": "...", "kind": "...", "importance": 0.0-1.0 }, ...] }`;
}

interface LLMReflection {
  text: string;
  kind: string;
  importance: number;
}

interface LLMReflectionResult {
  reflections: LLMReflection[];
}

// ============================================================================
// Core Functions
// ============================================================================

/**
 * Build reflection payloads from conversation text.
 * Uses LLM if available, otherwise falls back to heuristic extraction.
 */
export async function buildReflectionPayloads(
  conversationText: string,
  source: ReflectionPayload['source'] = 'session_end',
): Promise<ReflectionPayload[]> {
  if (!conversationText || conversationText.length < 50) return [];

  // Try LLM-powered extraction first
  if (isExtractionAvailable()) {
    const result = await llmJsonCompletion<LLMReflectionResult>(
      REFLECTION_SYSTEM_PROMPT,
      buildReflectionUserPrompt(conversationText),
      { temperature: 0.2, maxTokens: 2048 },
    );

    if (result?.reflections && Array.isArray(result.reflections) && result.reflections.length > 0) {
      return result.reflections
        .filter((r: LLMReflection) => r.text && typeof r.text === 'string' && r.text.length > 10)
        .map((r: LLMReflection) => {
          const kind = isValidKind(r.kind) ? r.kind : inferReflectionKind(r.text);
          const slices = extractSlices(r.text);
          return {
            text: r.text.trim(),
            kind,
            slices,
            importance: typeof r.importance === 'number' ? Math.max(0, Math.min(1, r.importance)) : 0.6,
            source,
          };
        });
    }
  }

  // Fallback: heuristic extraction from slices
  const slices = extractSlices(conversationText);
  if (slices.length === 0) return [];

  return slices
    .filter(s => s.confidence >= 0.4)
    .slice(0, 10)
    .map(s => ({
      text: s.text,
      kind: inferReflectionKind(s.text),
      slices: [s],
      importance: s.confidence * 0.8,
      source,
    }));
}

/**
 * Store reflections with deduplication.
 * Stores in both LanceDB (for semantic retrieval) and .learnings/ (for file-based access).
 */
export async function storeReflections(
  payloads: ReflectionPayload[],
  agentId: string,
  sessionId: string,
  scope: string = 'global',
): Promise<ReflectionResult> {
  const result: ReflectionResult = {
    generated: payloads.length,
    stored: 0,
    deduped: 0,
    reflections: [],
  };

  for (const payload of payloads) {
    try {
      // Check for duplicates
      const existing = await memorySearch(payload.text, 3, 'reflection', scope);
      const isDuplicate = existing.some(e => e._distance < 0.2);

      if (isDuplicate) {
        result.deduped++;
        continue;
      }

      // Store in LanceDB
      const memId = await withRetry(
        () => memoryStore(
          payload.text,
          'patterns', // reflections map to patterns category
          payload.importance,
          {
            source: 'reflection',
            reflection_kind: payload.kind,
            slice_count: payload.slices.length,
          } as Record<string, unknown>,
          scope,
        ),
        `store reflection "${payload.text.slice(0, 50)}"`,
      );

      // Store in reflection item store
      createReflectionItem(payload.text, sessionId, agentId, payload.kind);

      // Record event
      recordReflectionEvent('reflection_created', memId, agentId, sessionId, {
        source: payload.source,
        trigger: 'reflection_store',
        context: { kind: payload.kind, importance: payload.importance },
      });

      // Also log to .learnings/ file
      await logLearning(payload.text, 'insight', `kind=${payload.kind}, session=${sessionId}`);

      result.stored++;
      result.reflections.push(payload);
    } catch (err) {
      console.warn(`[reflection-store] Failed to store reflection: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return result;
}

/**
 * Load and rank reflections for an agent.
 * Returns the most relevant active reflections sorted by score.
 */
export async function loadAndRankReflections(
  agentId: string,
  topN: number = 10,
  scope: string = 'global',
): Promise<Array<{ text: string; kind: ReflectionKind; score: number }>> {
  const now = Date.now();

  // Load from in-memory store
  const items = listReflectionItems(agentId);

  // Score each item
  const scored = items.map(item => {
    const decayConfig = getReflectionDecayConfig(item.kind);
    const ranking = computeReflectionScore({
      ageMs: now - item.createdAt,
      accessCount: item.accessCount,
      importance: item.importance,
      halfLifeDays: decayConfig.halfLifeDays,
    });

    return {
      text: item.text,
      kind: item.kind,
      score: ranking.score,
    };
  });

  // Normalize and return top N
  return normalizeAndRank(scored, topN);
}

/**
 * Run the full reflection pipeline: extract → dedup → store.
 * Called at session end or during PreCompact hook.
 */
export async function runReflectionPipeline(
  conversationText: string,
  agentId: string,
  sessionId: string,
  source: ReflectionPayload['source'] = 'session_end',
  scope: string = 'global',
): Promise<ReflectionResult> {
  console.log(`[reflection-store] Running reflection pipeline for agent=${agentId}, source=${source}`);

  const payloads = await buildReflectionPayloads(conversationText, source);
  if (payloads.length === 0) {
    console.log('[reflection-store] No reflections extracted');
    return { generated: 0, stored: 0, deduped: 0, reflections: [] };
  }

  console.log(`[reflection-store] Generated ${payloads.length} reflection payloads`);
  const result = await storeReflections(payloads, agentId, sessionId, scope);
  console.log(`[reflection-store] Stored ${result.stored}, deduped ${result.deduped}`);

  return result;
}

// ============================================================================
// Helpers
// ============================================================================

function isValidKind(kind: unknown): kind is ReflectionKind {
  return typeof kind === 'string' && ['decision', 'user-model', 'agent-model', 'lesson', 'pattern', 'meta'].includes(kind);
}
