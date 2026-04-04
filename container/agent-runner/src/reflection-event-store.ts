/**
 * Deterministic event IDs and provenance metadata for reflection events.
 * Ported from memory-lancedb-pro.
 */

import { createHash } from 'node:crypto';

// ============================================================================
// Types
// ============================================================================

export interface ReflectionEvent {
  /** Deterministic event ID (hash of content + context) */
  id: string;
  /** Event type */
  type: 'reflection_created' | 'reflection_updated' | 'reflection_expired' | 'reflection_promoted';
  /** Reflection item ID */
  reflectionId: string;
  /** Agent ID (group folder) */
  agentId: string;
  /** Session ID */
  sessionId: string;
  /** Timestamp */
  timestamp: number;
  /** Provenance metadata */
  provenance: ProvenanceMetadata;
}

export interface ProvenanceMetadata {
  /** Source of the event */
  source: 'extraction' | 'manual' | 'precompact' | 'session_end';
  /** Trigger that caused the event */
  trigger: string;
  /** Additional context */
  context?: Record<string, unknown>;
}

// ============================================================================
// Event Store
// ============================================================================

const _events: ReflectionEvent[] = [];
const MAX_EVENTS = 1000;

/**
 * Generate a deterministic event ID from content.
 * Ensures the same event produces the same ID across invocations.
 */
export function generateEventId(
  type: ReflectionEvent['type'],
  reflectionId: string,
  agentId: string,
  timestamp: number,
): string {
  const hash = createHash('sha256')
    .update(`${type}:${reflectionId}:${agentId}:${timestamp}`)
    .digest('hex')
    .slice(0, 16);
  return `evt-${hash}`;
}

/**
 * Record a reflection event.
 */
export function recordReflectionEvent(
  type: ReflectionEvent['type'],
  reflectionId: string,
  agentId: string,
  sessionId: string,
  provenance: ProvenanceMetadata,
): ReflectionEvent {
  const timestamp = Date.now();
  const event: ReflectionEvent = {
    id: generateEventId(type, reflectionId, agentId, timestamp),
    type,
    reflectionId,
    agentId,
    sessionId,
    timestamp,
    provenance,
  };

  _events.push(event);

  // Trim old events if over limit
  if (_events.length > MAX_EVENTS) {
    _events.splice(0, _events.length - MAX_EVENTS);
  }

  return event;
}

/**
 * Get recent events for an agent.
 */
export function getRecentEvents(agentId: string, limit: number = 20): ReflectionEvent[] {
  return _events
    .filter(e => e.agentId === agentId)
    .slice(-limit);
}

/**
 * Get events for a specific reflection item.
 */
export function getEventsForReflection(reflectionId: string): ReflectionEvent[] {
  return _events.filter(e => e.reflectionId === reflectionId);
}
