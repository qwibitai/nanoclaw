/**
 * Supermemory REST API client.
 *
 * Provides recall (profile + search) and capture (add document) for
 * persistent agent memory across conversations. Pure fetch() — no SDK.
 *
 * All calls are non-fatal: if Supermemory is unreachable or unconfigured,
 * functions return null/false and the agent continues without memory.
 */

import { SUPERMEMORY_API_KEY, SUPERMEMORY_CONTAINER_TAG } from './config.ts';
import { logger } from './logger.ts';

const API_BASE = 'https://api.supermemory.ai';

// --- Types ---

export interface MemoryResult {
  id: string;
  content: string;
  score: number;
  createdAt?: string;
}

export interface MemoryContext {
  profile: { static: string[]; dynamic: string[] };
  searchResults: MemoryResult[];
}

// --- Public API ---

/**
 * Check if memory is configured (API key present).
 */
export function isMemoryEnabled(): boolean {
  return SUPERMEMORY_API_KEY.length > 0;
}

/**
 * Recall relevant memories and user profile for a given query.
 * Uses the /v4/profile endpoint which returns profile + search in one call.
 *
 * Returns null if memory is not configured or the call fails.
 */
export async function recall(
  query?: string,
): Promise<MemoryContext | null> {
  if (!isMemoryEnabled()) return null;

  try {
    const body: Record<string, unknown> = {
      containerTag: SUPERMEMORY_CONTAINER_TAG,
    };
    if (query) body.q = query;

    const res = await apiRequest('/v4/profile', body);
    if (!res.ok) {
      logger.warn({ status: res.status }, 'Supermemory recall failed');
      return null;
    }

    const data = await res.json();

    // Profile is nested: { profile: { static: [], dynamic: [] }, searchResults: { results: [] } }
    const profile = data.profile || {};
    const rawResults = data.searchResults?.results || data.results || [];

    return {
      profile: {
        static: Array.isArray(profile.static) ? profile.static : [],
        dynamic: Array.isArray(profile.dynamic) ? profile.dynamic : [],
      },
      searchResults: parseSearchResults(rawResults),
    };
  } catch (err) {
    logger.warn({ err }, 'Supermemory recall error');
    return null;
  }
}

/**
 * Capture a conversation exchange for memory extraction.
 * Supermemory's backend extracts facts, deduplicates, and builds profiles.
 *
 * Returns true if captured successfully, false otherwise.
 */
export async function capture(
  content: string,
  metadata?: Record<string, string>,
): Promise<boolean> {
  if (!isMemoryEnabled()) return false;

  try {
    const body: Record<string, unknown> = {
      content,
      containerTag: SUPERMEMORY_CONTAINER_TAG,
    };
    if (metadata) body.metadata = metadata;

    const res = await apiRequest('/v3/documents', body);
    if (!res.ok) {
      logger.warn({ status: res.status }, 'Supermemory capture failed');
      return false;
    }

    logger.debug('Memory captured');
    return true;
  } catch (err) {
    logger.warn({ err }, 'Supermemory capture error');
    return false;
  }
}

/**
 * Search memories explicitly.
 */
export async function search(
  query: string,
  limit = 10,
): Promise<MemoryResult[]> {
  if (!isMemoryEnabled()) return [];

  try {
    const body: Record<string, unknown> = {
      q: query,
      containerTag: SUPERMEMORY_CONTAINER_TAG,
      limit,
    };

    const res = await apiRequest('/v4/search', body);
    if (!res.ok) return [];

    const data = await res.json();
    return parseSearchResults(data.results || []);
  } catch (err) {
    logger.warn({ err }, 'Supermemory search error');
    return [];
  }
}

// --- Internal ---

function apiRequest(
  path: string,
  body: Record<string, unknown>,
): Promise<Response> {
  return fetch(`${API_BASE}${path}`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${SUPERMEMORY_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
}

function parseSearchResults(
  // deno-lint-ignore no-explicit-any
  raw: any[],
): MemoryResult[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((r) => r && (typeof r.memory === 'string' || typeof r.content === 'string'))
    .map((r) => ({
      id: r.id || '',
      content: r.memory || r.content,
      score: r.similarity ?? r.score ?? 0,
      createdAt: r.createdAt || r.updatedAt,
    }));
}
