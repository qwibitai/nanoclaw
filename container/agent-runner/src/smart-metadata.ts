/**
 * Smart metadata for memory entries — multi-level abstraction,
 * temporal versioning, relations, and lifecycle management.
 *
 * Ported from memory-lancedb-pro's SmartMemoryMetadata system.
 */

// ============================================================================
// Types
// ============================================================================

export interface SmartMemoryMetadata {
  /** One-line abstract of the memory */
  l0_abstract: string;
  /** Bullet-point overview (markdown) */
  l1_overview: string;
  /** Full content with context */
  l2_content: string;
  /** Memory category (profile, preferences, entities, events, cases, patterns) */
  memory_category: string;
  /** Confidence score 0–1 */
  confidence: number;
  /** Number of times this memory was accessed */
  access_count: number;
  /** Timestamp of last access (epoch ms), 0 if never */
  last_accessed_at: number;
  /** Timestamp from which this memory is valid (epoch ms) */
  valid_from: number;
  /** Timestamp until which this memory is valid (epoch ms), 0 = indefinite */
  valid_until: number;
  /** Memory tier: core, working, peripheral */
  tier: MemoryTier;
  /** Stable key for deduplication across temporal versions */
  fact_key: string;
  /** ID of the memory this one supersedes (temporal versioning) */
  supersedes: string;
  /** ID of the memory that supersedes this one */
  superseded_by: string;
  /** Related memory IDs */
  relations: string[];
  /** Source of this memory (user, extraction, reflection, migration) */
  source: string;
  /** Contextual support slices — evidence or context that backs this memory */
  support_slices: SupportSlice[];
}

export interface SupportSlice {
  /** The supporting text */
  text: string;
  /** Source of the support (conversation, extraction, user) */
  source: string;
  /** When this support was added (epoch ms) */
  added_at: number;
}

export type MemoryTier = 'core' | 'working' | 'peripheral';

// ============================================================================
// Builder
// ============================================================================

export interface BuildSmartMetadataInput {
  text: string;
  category: string;
  importance?: number;
  existingMeta?: Partial<SmartMemoryMetadata>;
  source?: string;
}

/**
 * Build a complete SmartMemoryMetadata object from input text and optional
 * existing metadata. Fills in defaults for any missing fields.
 */
export function buildSmartMetadata(input: BuildSmartMetadataInput): SmartMemoryMetadata {
  const { text, category, importance = 0.7, existingMeta = {}, source = 'user' } = input;

  // Generate l0/l1/l2 from text if not provided
  const l0 = existingMeta.l0_abstract || generateL0(text);
  const l1 = existingMeta.l1_overview || generateL1(text);
  const l2 = existingMeta.l2_content || text;

  return {
    l0_abstract: l0,
    l1_overview: l1,
    l2_content: l2,
    memory_category: category,
    confidence: existingMeta.confidence ?? 1.0,
    access_count: existingMeta.access_count ?? 0,
    last_accessed_at: existingMeta.last_accessed_at ?? 0,
    valid_from: existingMeta.valid_from ?? Date.now(),
    valid_until: existingMeta.valid_until ?? 0,
    tier: existingMeta.tier ?? (importance >= 0.8 ? 'working' : 'peripheral'),
    fact_key: existingMeta.fact_key || deriveFactKey(text),
    supersedes: existingMeta.supersedes ?? '',
    superseded_by: existingMeta.superseded_by ?? '',
    relations: existingMeta.relations ?? [],
    source,
    support_slices: existingMeta.support_slices ?? [],
  };
}

// ============================================================================
// Parse / Stringify
// ============================================================================

/**
 * Parse a metadata JSON string into a typed SmartMemoryMetadata object.
 * Returns defaults for any missing fields.
 */
export function parseSmartMetadata(metadataStr?: string): SmartMemoryMetadata {
  if (!metadataStr) return buildSmartMetadata({ text: '', category: 'other' });

  try {
    const parsed = JSON.parse(metadataStr);
    return {
      l0_abstract: parsed.l0_abstract ?? '',
      l1_overview: parsed.l1_overview ?? '',
      l2_content: parsed.l2_content ?? '',
      memory_category: parsed.memory_category ?? 'other',
      confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 1.0,
      access_count: typeof parsed.access_count === 'number' ? parsed.access_count : 0,
      last_accessed_at: typeof parsed.last_accessed_at === 'number' ? parsed.last_accessed_at : 0,
      valid_from: typeof parsed.valid_from === 'number' ? parsed.valid_from : 0,
      valid_until: typeof parsed.valid_until === 'number' ? parsed.valid_until : 0,
      tier: isValidTier(parsed.tier) ? parsed.tier : 'working',
      fact_key: parsed.fact_key ?? '',
      supersedes: parsed.supersedes ?? '',
      superseded_by: parsed.superseded_by ?? '',
      relations: Array.isArray(parsed.relations) ? parsed.relations : [],
      source: parsed.source ?? 'unknown',
      support_slices: Array.isArray(parsed.support_slices) ? parsed.support_slices : [],
    };
  } catch {
    return buildSmartMetadata({ text: '', category: 'other' });
  }
}

/**
 * Serialize SmartMemoryMetadata to a JSON string,
 * preserving any extra fields from the original metadata.
 */
export function stringifySmartMetadata(
  meta: SmartMemoryMetadata,
  existingMetadataStr?: string,
): string {
  let base: Record<string, unknown> = {};
  if (existingMetadataStr) {
    try { base = JSON.parse(existingMetadataStr); } catch { /* ignore */ }
  }
  return JSON.stringify({ ...base, ...meta });
}

// ============================================================================
// Temporal Versioning
// ============================================================================

/**
 * Check if a memory is currently active (not superseded and within validity window).
 */
export function isMemoryActiveAt(metadata: SmartMemoryMetadata, atTime: number = Date.now()): boolean {
  // Superseded memories are inactive
  if (metadata.superseded_by) return false;

  // Check validity window
  if (metadata.valid_from && atTime < metadata.valid_from) return false;
  if (metadata.valid_until && metadata.valid_until > 0 && atTime > metadata.valid_until) return false;

  return true;
}

/**
 * Derive a stable fact key from memory text for deduplication.
 * The key captures the semantic essence: strips filler words,
 * normalizes whitespace, lowercases, and truncates to 128 chars.
 */
export function deriveFactKey(text: string): string {
  if (!text) return '';

  const normalized = text
    .toLowerCase()
    .replace(/\b(the|a|an|is|are|was|were|be|been|being|have|has|had|do|does|did|will|would|could|should|may|might|shall|can|must|i|me|my|we|our|you|your|he|she|it|they|them|their|this|that|these|those)\b/g, '')
    .replace(/[^\w\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  return normalized.slice(0, 128);
}

/**
 * Convert an existing memory entry to a lifecycle-aware memory
 * by ensuring it has all smart metadata fields populated.
 */
export function toLifecycleMemory(
  text: string,
  category: string,
  importance: number,
  existingMetadataStr?: string,
): SmartMemoryMetadata {
  const existing = existingMetadataStr ? parseSmartMetadata(existingMetadataStr) : undefined;
  return buildSmartMetadata({
    text,
    category,
    importance,
    existingMeta: existing,
    source: existing?.source || 'migration',
  });
}

// ============================================================================
// Helpers
// ============================================================================

function isValidTier(tier: unknown): tier is MemoryTier {
  return tier === 'core' || tier === 'working' || tier === 'peripheral';
}

/**
 * Generate a concise one-line abstract from text.
 */
function generateL0(text: string): string {
  if (!text) return '';
  // Take first sentence or first 120 chars
  const firstSentence = text.match(/^[^.!?\n]+[.!?]?/)?.[0] || text;
  return firstSentence.slice(0, 120).trim();
}

/**
 * Generate a bullet-point overview from text.
 */
function generateL1(text: string): string {
  if (!text) return '';
  // Split into sentences, format as bullets
  const sentences = text
    .split(/[.!?\n]+/)
    .map(s => s.trim())
    .filter(s => s.length > 5);
  if (sentences.length <= 1) return `- ${text.trim()}`;
  return sentences.slice(0, 5).map(s => `- ${s}`).join('\n');
}
