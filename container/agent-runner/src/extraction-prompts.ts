/**
 * LLM prompts for smart memory extraction, deduplication, and merging.
 * Ported from memory-lancedb-pro.
 */

// ============================================================================
// Extraction Prompt
// ============================================================================

export const EXTRACTION_SYSTEM_PROMPT = `You are a memory extraction system. Your job is to extract memorable facts, preferences, and entities from a conversation between a user and an assistant.

Extract ONLY information that would be valuable to remember for future conversations. Focus on:
- User preferences and settings
- Personal facts about the user (name, role, location, etc.)
- Named entities (people, projects, tools, organizations)
- Important events and decisions
- Problem-solution patterns
- Recurring behaviors and workflows

For each extracted memory, provide:
- "text": A clear, self-contained statement (not a question)
- "category": One of: profile, preferences, entities, events, cases, patterns
- "importance": 0.0-1.0 (how important to remember)
- "fact_key": A short normalized key for deduplication (lowercase, no filler words, max 80 chars)

Respond with a JSON object: { "memories": [...] }
If nothing worth remembering, respond: { "memories": [] }`;

export function buildExtractionUserPrompt(conversationText: string, scope: string): string {
  return `Extract memorable information from this conversation.
Scope: ${scope}

--- CONVERSATION ---
${conversationText.slice(0, 8000)}
--- END CONVERSATION ---

Respond with JSON: { "memories": [{ "text": "...", "category": "...", "importance": 0.0-1.0, "fact_key": "..." }, ...] }`;
}

// ============================================================================
// Dedup Prompt
// ============================================================================

export const DEDUP_SYSTEM_PROMPT = `You are a memory deduplication system. Given a candidate memory and an existing memory, decide what to do.

Possible actions:
- "create": The candidate is new information, not a duplicate. Create it.
- "merge": The candidate adds to or updates the existing memory. Provide merged text.
- "skip": The candidate is a duplicate of the existing memory. Skip it.
- "support": The candidate provides supporting evidence for the existing memory.
- "supersede": The candidate contradicts or updates the existing memory. The old one should be superseded.
- "contradict": The candidate contradicts the existing memory but both might be valid (temporal).

Respond with JSON: { "action": "...", "reason": "...", "merged_text": "..." (only for merge action) }`;

export function buildDedupUserPrompt(
  candidateText: string,
  candidateCategory: string,
  existingText: string,
  existingCategory: string,
): string {
  return `Compare these memories:

CANDIDATE (new):
Category: ${candidateCategory}
Text: ${candidateText}

EXISTING (stored):
Category: ${existingCategory}
Text: ${existingText}

Decide: create, merge, skip, support, supersede, or contradict?
Respond with JSON: { "action": "...", "reason": "...", "merged_text": "..." }`;
}

// ============================================================================
// Merge Prompt
// ============================================================================

export const MERGE_SYSTEM_PROMPT = `You are a memory merging system. Given two memory texts, produce a single merged text that captures all information from both. The result should be a clear, self-contained statement.

Respond with JSON: { "merged_text": "..." }`;

export function buildMergeUserPrompt(text1: string, text2: string): string {
  return `Merge these two memories into one comprehensive statement:

Memory 1: ${text1}
Memory 2: ${text2}

Respond with JSON: { "merged_text": "..." }`;
}

// ============================================================================
// Types
// ============================================================================

export interface ExtractedMemory {
  text: string;
  category: string;
  importance: number;
  fact_key: string;
}

export interface ExtractionResult {
  memories: ExtractedMemory[];
}

export interface DedupDecision {
  action: 'create' | 'merge' | 'skip' | 'support' | 'supersede' | 'contradict';
  reason: string;
  merged_text?: string;
}

export interface MergeResult {
  merged_text: string;
}
