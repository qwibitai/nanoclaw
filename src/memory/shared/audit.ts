// src/memory/shared/audit.ts
import fs from 'fs';
import { auditLogPath, ensureMemoryDirs } from './paths.js';

export type AuditAction = 'create' | 'merge' | 'reject' | 'archive';

export interface AuditEntry {
  ts: string; // ISO datetime
  action: AuditAction;
  slug: string;
  source: string;
  reason: string;
}

export function logAudit(entry: Omit<AuditEntry, 'ts'>): void {
  ensureMemoryDirs();
  const line: AuditEntry = { ts: new Date().toISOString(), ...entry };
  fs.appendFileSync(auditLogPath(), JSON.stringify(line) + '\n');
}

export function readAudit(): AuditEntry[] {
  const p = auditLogPath();
  if (!fs.existsSync(p)) return [];
  return fs
    .readFileSync(p, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as AuditEntry);
}
