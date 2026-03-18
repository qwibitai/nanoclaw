/**
 * Structured JSONL audit logging.
 * Writes to /workspace/extra/atlas-state/audit/{entity}/{YYYY-MM-DD}.jsonl
 * Append-only, entity-scoped, one event per line.
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { AuditEvent } from './types.js';

const ATLAS_STATE_DIR = '/workspace/extra/atlas-state';

function getAuditDir(entity: string): string {
  return path.join(ATLAS_STATE_DIR, 'audit', entity);
}

function getAuditFilePath(entity: string): string {
  const date = new Date().toISOString().split('T')[0];
  return path.join(getAuditDir(entity), `${date}.jsonl`);
}

/**
 * Log a single audit event to the entity-scoped JSONL file.
 */
export function logAuditEvent(event: AuditEvent): void {
  try {
    const dir = getAuditDir(event.actor.entity);
    fs.mkdirSync(dir, { recursive: true });

    const filePath = getAuditFilePath(event.actor.entity);
    const line = JSON.stringify(event) + '\n';
    fs.appendFileSync(filePath, line, { flag: 'a' });
  } catch (err) {
    // Audit logging must never crash the agent
    console.error(`[governance/audit] Failed to log event: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Create an audit event for a tool call.
 */
export function createToolCallEvent(params: {
  entity: string;
  actorId: string;
  actorType: 'agent' | 'scheduled_task' | 'ceo';
  tier: number;
  toolName: string;
  target?: string;
  status: 'success' | 'denied' | 'error';
  errorMessage?: string;
  durationMs?: number;
}): AuditEvent {
  return {
    timestamp: new Date().toISOString(),
    event_id: crypto.randomUUID(),
    actor: {
      type: params.actorType,
      id: params.actorId,
      entity: params.entity,
    },
    action: {
      type: 'tool_call',
      tool_name: params.toolName,
      target: params.target,
      authority_tier: params.tier,
    },
    outcome: {
      status: params.status,
      error_message: params.errorMessage,
      duration_ms: params.durationMs,
    },
  };
}

/**
 * Log a governance event (preflight, quota check, etc.)
 */
export function logGovernanceEvent(params: {
  entity: string;
  eventType: string;
  description: string;
  tier: number;
  status: 'success' | 'denied' | 'error';
  errorMessage?: string;
}): void {
  logAuditEvent({
    timestamp: new Date().toISOString(),
    event_id: crypto.randomUUID(),
    actor: {
      type: 'agent',
      id: 'governance',
      entity: params.entity,
    },
    action: {
      type: params.eventType,
      tool_name: 'governance',
      authority_tier: params.tier,
      description: params.description,
    },
    outcome: {
      status: params.status,
      error_message: params.errorMessage,
    },
  });
}

/**
 * Count today's audit events for an entity (for digest/monitoring).
 */
export function countTodayEvents(entity: string): number {
  try {
    const filePath = getAuditFilePath(entity);
    if (!fs.existsSync(filePath)) return 0;
    const content = fs.readFileSync(filePath, 'utf-8');
    return content.split('\n').filter(line => line.trim()).length;
  } catch {
    return 0;
  }
}
