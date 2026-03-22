/**
 * Individual reflection item CRUD with ordinal/group tracking.
 * Stores reflection items in LanceDB with metadata for retrieval.
 *
 * Ported from memory-lancedb-pro.
 */

import type { ReflectionKind } from './reflection-metadata.js';
import { inferReflectionKind } from './reflection-metadata.js';
import { getReflectionDecayConfig } from './reflection-mapped-metadata.js';

// ============================================================================
// Types
// ============================================================================

export interface ReflectionItem {
  /** Unique ID */
  id: string;
  /** Reflection text */
  text: string;
  /** Reflection kind (determines decay behavior) */
  kind: ReflectionKind;
  /** Source session/conversation */
  sessionId: string;
  /** Agent ID (group folder) */
  agentId: string;
  /** Ordinal within the group (for ordering) */
  ordinal: number;
  /** Group key (for batch operations) */
  groupKey: string;
  /** Creation timestamp */
  createdAt: number;
  /** Importance score */
  importance: number;
  /** Access count */
  accessCount: number;
}

// ============================================================================
// In-Memory Store
// ============================================================================

const _items = new Map<string, ReflectionItem>();
let _nextOrdinal = 1;

/**
 * Create a new reflection item.
 */
export function createReflectionItem(
  text: string,
  sessionId: string,
  agentId: string,
  kind?: ReflectionKind,
  groupKey?: string,
): ReflectionItem {
  const inferredKind = kind || inferReflectionKind(text);
  const decayConfig = getReflectionDecayConfig(inferredKind);

  const item: ReflectionItem = {
    id: `ref-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    text,
    kind: inferredKind,
    sessionId,
    agentId,
    ordinal: _nextOrdinal++,
    groupKey: groupKey || `${agentId}:${sessionId}`,
    createdAt: Date.now(),
    importance: decayConfig.defaultImportance,
    accessCount: 0,
  };

  _items.set(item.id, item);
  return item;
}

/**
 * Get a reflection item by ID.
 */
export function getReflectionItem(id: string): ReflectionItem | undefined {
  return _items.get(id);
}

/**
 * Update a reflection item.
 */
export function updateReflectionItem(
  id: string,
  updates: Partial<Pick<ReflectionItem, 'text' | 'kind' | 'importance' | 'accessCount'>>,
): ReflectionItem | undefined {
  const item = _items.get(id);
  if (!item) return undefined;

  const updated = { ...item, ...updates };
  _items.set(id, updated);
  return updated;
}

/**
 * Delete a reflection item.
 */
export function deleteReflectionItem(id: string): boolean {
  return _items.delete(id);
}

/**
 * List reflection items for an agent, optionally filtered by kind.
 */
export function listReflectionItems(
  agentId: string,
  kind?: ReflectionKind,
): ReflectionItem[] {
  const items: ReflectionItem[] = [];
  for (const item of _items.values()) {
    if (item.agentId !== agentId) continue;
    if (kind && item.kind !== kind) continue;
    items.push(item);
  }
  return items.sort((a, b) => b.createdAt - a.createdAt);
}

/**
 * List reflection items by group key.
 */
export function listReflectionItemsByGroup(groupKey: string): ReflectionItem[] {
  const items: ReflectionItem[] = [];
  for (const item of _items.values()) {
    if (item.groupKey === groupKey) items.push(item);
  }
  return items.sort((a, b) => a.ordinal - b.ordinal);
}

/**
 * Get total count of reflection items for an agent.
 */
export function countReflectionItems(agentId: string): number {
  let count = 0;
  for (const item of _items.values()) {
    if (item.agentId === agentId) count++;
  }
  return count;
}
