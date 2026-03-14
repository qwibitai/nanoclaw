/**
 * Smart memory extractor: LLM-powered extraction → vector dedup → persist.
 * Handles create/merge/skip/support/supersede/contradict decisions.
 *
 * Ported from memory-lancedb-pro.
 */

import { llmJsonCompletion, isExtractionAvailable } from './llm-client.js';
import {
  EXTRACTION_SYSTEM_PROMPT,
  buildExtractionUserPrompt,
  DEDUP_SYSTEM_PROMPT,
  buildDedupUserPrompt,
  MERGE_SYSTEM_PROMPT,
  buildMergeUserPrompt,
} from './extraction-prompts.js';
import type { ExtractionResult, DedupDecision, MergeResult, ExtractedMemory } from './extraction-prompts.js';
import { memoryStore, memorySearch, memoryUpdate } from './memory.js';
import { normalizeCategory, toLegacyCategory } from './memory-categories.js';
import { buildSmartMetadata, stringifySmartMetadata, parseSmartMetadata } from './smart-metadata.js';

// ============================================================================
// Types
// ============================================================================

export interface ExtractionStats {
  extracted: number;
  created: number;
  merged: number;
  skipped: number;
  supported: number;
  superseded: number;
  contradicted: number;
  errors: number;
}

// ============================================================================
// Smart Extractor
// ============================================================================

export class SmartExtractor {
  private static instance: SmartExtractor | null = null;

  static getInstance(): SmartExtractor {
    if (!SmartExtractor.instance) {
      SmartExtractor.instance = new SmartExtractor();
    }
    return SmartExtractor.instance;
  }

  /**
   * Check if extraction is available (LLM provider configured).
   */
  isAvailable(): boolean {
    return isExtractionAvailable();
  }

  /**
   * Extract memories from conversation text and persist them.
   * Full pipeline: LLM extract → vector dedup → LLM dedup decision → persist.
   */
  async extractAndPersist(
    conversationText: string,
    scope: string = 'global',
  ): Promise<ExtractionStats> {
    const stats: ExtractionStats = {
      extracted: 0, created: 0, merged: 0, skipped: 0,
      supported: 0, superseded: 0, contradicted: 0, errors: 0,
    };

    if (!this.isAvailable()) {
      console.log('[smart-extractor] Extraction not available (no provider configured)');
      return stats;
    }

    // Step 1: Extract candidates from conversation
    const candidates = await this.extractCandidates(conversationText, scope);
    if (!candidates || candidates.length === 0) {
      console.log('[smart-extractor] No memories extracted from conversation');
      return stats;
    }

    stats.extracted = candidates.length;
    console.log(`[smart-extractor] Extracted ${candidates.length} candidate memories`);

    // Step 2: Process each candidate (dedup + persist)
    for (const candidate of candidates) {
      try {
        await this.processCandidate(candidate, scope, stats);
      } catch (err) {
        stats.errors++;
        console.warn(`[smart-extractor] Error processing candidate: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    console.log(`[smart-extractor] Results: created=${stats.created}, merged=${stats.merged}, skipped=${stats.skipped}, supported=${stats.supported}, superseded=${stats.superseded}, contradicted=${stats.contradicted}, errors=${stats.errors}`);
    return stats;
  }

  /**
   * Step 1: Extract memory candidates from conversation text using LLM.
   */
  private async extractCandidates(
    conversationText: string,
    scope: string,
  ): Promise<ExtractedMemory[] | null> {
    const result = await llmJsonCompletion<ExtractionResult>(
      EXTRACTION_SYSTEM_PROMPT,
      buildExtractionUserPrompt(conversationText, scope),
      { temperature: 0.1, maxTokens: 4096 },
    );

    if (!result?.memories || !Array.isArray(result.memories)) return null;

    // Validate and normalize candidates
    return result.memories
      .filter(m => m.text && typeof m.text === 'string' && m.text.length > 5)
      .map(m => ({
        text: m.text.trim(),
        category: m.category || 'cases',
        importance: typeof m.importance === 'number' ? Math.max(0, Math.min(1, m.importance)) : 0.7,
        fact_key: m.fact_key || '',
      }));
  }

  /**
   * Step 2: Process a single candidate — find duplicates, decide, persist.
   */
  private async processCandidate(
    candidate: ExtractedMemory,
    scope: string,
    stats: ExtractionStats,
  ): Promise<void> {
    // Search for potential duplicates
    const existing = await memorySearch(candidate.text, 3, undefined, scope);

    // If no existing memories or low similarity, just create
    if (existing.length === 0 || existing[0]._distance > 0.5) {
      await this.handleCreate(candidate, scope);
      stats.created++;
      return;
    }

    // Use LLM to decide dedup action
    const topMatch = existing[0];
    const decision = await llmJsonCompletion<DedupDecision>(
      DEDUP_SYSTEM_PROMPT,
      buildDedupUserPrompt(
        candidate.text,
        candidate.category,
        topMatch.text,
        topMatch.category,
      ),
      { temperature: 0.0, maxTokens: 1024 },
    );

    if (!decision?.action) {
      // Fallback: create if LLM fails
      await this.handleCreate(candidate, scope);
      stats.created++;
      return;
    }

    switch (decision.action) {
      case 'create':
        await this.handleCreate(candidate, scope);
        stats.created++;
        break;

      case 'merge':
        await this.handleMerge(candidate, topMatch, decision.merged_text, scope);
        stats.merged++;
        break;

      case 'skip':
        stats.skipped++;
        break;

      case 'support':
        await this.handleSupport(candidate, topMatch, scope);
        stats.supported++;
        break;

      case 'supersede':
        await this.handleSupersede(candidate, topMatch, scope);
        stats.superseded++;
        break;

      case 'contradict':
        await this.handleContradict(candidate, topMatch, scope);
        stats.contradicted++;
        break;

      default:
        await this.handleCreate(candidate, scope);
        stats.created++;
    }
  }

  /**
   * Create a new memory entry.
   */
  private async handleCreate(
    candidate: ExtractedMemory,
    scope: string,
  ): Promise<void> {
    const cat = normalizeCategory(candidate.category);
    await memoryStore(
      candidate.text,
      cat,
      candidate.importance,
      {
        fact_key: candidate.fact_key,
        source: 'extraction',
      },
      scope,
    );
  }

  /**
   * Merge candidate into existing memory.
   */
  private async handleMerge(
    candidate: ExtractedMemory,
    existing: { id: string; text: string; metadata: string },
    mergedText: string | undefined,
    scope: string,
  ): Promise<void> {
    let finalText = mergedText;

    if (!finalText) {
      // Ask LLM to merge
      const result = await llmJsonCompletion<MergeResult>(
        MERGE_SYSTEM_PROMPT,
        buildMergeUserPrompt(existing.text, candidate.text),
        { temperature: 0.1, maxTokens: 1024 },
      );
      finalText = result?.merged_text || `${existing.text}. ${candidate.text}`;
    }

    await memoryUpdate(existing.id, {
      text: finalText,
      importance: candidate.importance,
    }, scope);
  }

  /**
   * Add support slice to existing memory.
   */
  private async handleSupport(
    candidate: ExtractedMemory,
    existing: { id: string; metadata: string },
    scope: string,
  ): Promise<void> {
    const meta = parseSmartMetadata(existing.metadata);
    const slices = meta.support_slices || [];
    slices.push({
      text: candidate.text,
      source: 'extraction',
      added_at: Date.now(),
    });

    await memoryUpdate(existing.id, {
      metadata: { support_slices: slices, confidence: Math.min(1.0, (meta.confidence || 0.8) + 0.05) },
    }, scope);
  }

  /**
   * Supersede existing memory with new one.
   */
  private async handleSupersede(
    candidate: ExtractedMemory,
    existing: { id: string; metadata: string },
    scope: string,
  ): Promise<void> {
    // Create new entry
    const cat = normalizeCategory(candidate.category);
    const newId = await memoryStore(
      candidate.text,
      cat,
      candidate.importance,
      {
        fact_key: candidate.fact_key,
        source: 'extraction',
        supersedes: existing.id,
      },
      scope,
    );

    // Mark old entry as superseded
    await memoryUpdate(existing.id, {
      metadata: { superseded_by: newId, valid_until: Date.now() },
    }, scope);
  }

  /**
   * Handle contradiction: create new entry and note the conflict.
   */
  private async handleContradict(
    candidate: ExtractedMemory,
    existing: { id: string },
    scope: string,
  ): Promise<void> {
    const cat = normalizeCategory(candidate.category);
    await memoryStore(
      candidate.text,
      cat,
      candidate.importance,
      {
        fact_key: candidate.fact_key,
        source: 'extraction',
        relations: [existing.id],
      },
      scope,
    );
  }
}
