/**
 * Thin HTTP client for the MemOS product API.
 * All methods are safe to call even when MemOS is unavailable —
 * errors are logged and callers get empty/null fallbacks.
 */
import { logger } from './logger.js';
import { MEMOS_API_URL, MEMOS_USER_ID } from './config.js';
import { readEnvFile } from './env.js';

const REQUEST_TIMEOUT = 5000;

// Auth loaded once from .env (not exported to avoid leaking to child processes)
const authEnv = readEnvFile(['MEMOS_API_AUTH']);
const MEMOS_AUTH_HEADER = authEnv.MEMOS_API_AUTH
  ? `Basic ${Buffer.from(authEnv.MEMOS_API_AUTH).toString('base64')}`
  : '';

export interface MemoryResult {
  text: string;
  score: number;
}

/**
 * Search MemOS for memories relevant to the given query.
 * Returns an empty array on error or when MemOS is disabled.
 */
export async function searchMemories(
  query: string,
  userId: string = MEMOS_USER_ID,
): Promise<MemoryResult[]> {
  if (!MEMOS_API_URL) return [];

  try {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (MEMOS_AUTH_HEADER) headers['Authorization'] = MEMOS_AUTH_HEADER;
    const resp = await fetch(`${MEMOS_API_URL}/search`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ query, user_id: userId }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT),
    });

    if (!resp.ok) {
      logger.warn({ status: resp.status }, 'MemOS search failed');
      return [];
    }

    const json = (await resp.json()) as { data?: Record<string, unknown> };
    const data = json.data;
    if (!data || typeof data !== 'object') return [];

    // MemOS returns categories (text_mem, act_mem, etc.), each containing
    // cubes with memories arrays. Flatten all memories from all categories.
    const results: MemoryResult[] = [];
    for (const category of Object.values(data)) {
      if (!Array.isArray(category)) continue;
      for (const cube of category) {
        const c = cube as { memories?: unknown[] };
        if (!Array.isArray(c.memories)) continue;
        for (const mem of c.memories) {
          const m = mem as { memory?: string; score?: number };
          if (m.memory) {
            results.push({ text: m.memory, score: m.score ?? 0 });
          }
        }
      }
    }
    return results;
  } catch (err) {
    logger.warn({ err }, 'MemOS search unavailable');
    return [];
  }
}

/**
 * Store content in MemOS as a memory.
 * Returns true on success, false on error. Never throws.
 */
export async function addMemory(
  content: string,
  userId: string = MEMOS_USER_ID,
): Promise<boolean> {
  if (!MEMOS_API_URL) return false;

  try {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (MEMOS_AUTH_HEADER) headers['Authorization'] = MEMOS_AUTH_HEADER;
    const resp = await fetch(`${MEMOS_API_URL}/add`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        user_id: userId,
        messages: [{ role: 'user', content }],
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT),
    });

    if (!resp.ok) {
      logger.warn({ status: resp.status }, 'MemOS add failed');
      return false;
    }

    return true;
  } catch (err) {
    logger.warn({ err }, 'MemOS add unavailable');
    return false;
  }
}
