import { logger } from '../logger.js';

const auditLogger = logger.child({ component: 'audit' });

export interface AuditEntry {
  action: string;
  command?: string;
  args?: string[];
  result?: 'allowed' | 'blocked';
  reason?: string;
}

export function auditLog(entry: AuditEntry): void {
  auditLogger.info(entry, `audit: ${entry.action}`);
}
