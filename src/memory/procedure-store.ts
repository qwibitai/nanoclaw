/**
 * Procedure Store — Learned procedures stored as JSON files.
 *
 * Two scopes:
 * - Global: store/procedures/
 * - Per-group: groups/{name}/procedures/
 *
 * Procedures capture multi-step workflows the agent has learned,
 * either autonomously or via teach mode.
 */

import fs from 'fs';
import path from 'path';

import { GROUPS_DIR, STORE_DIR } from '../config.js';
import { logger } from '../logger.js';

export interface ProcedureStep {
  action: string;
  details?: string;
  expected?: string;
}

export interface Procedure {
  name: string;
  trigger: string;
  description?: string;
  steps: ProcedureStep[];
  success_count: number;
  failure_count: number;
  auto_execute: boolean;
  created_at: string;
  updated_at: string;
  groupId?: string;
}

function globalProceduresDir(): string {
  return path.join(STORE_DIR, 'procedures');
}

function groupProceduresDir(groupId: string): string {
  return path.join(GROUPS_DIR, groupId, 'procedures');
}

function procedurePath(name: string, groupId?: string): string {
  const dir = groupId ? groupProceduresDir(groupId) : globalProceduresDir();
  const safeName = name.replace(/[^a-zA-Z0-9_-]/g, '_');
  return path.join(dir, `${safeName}.json`);
}

function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

/**
 * Save a procedure to disk.
 */
export function saveProcedure(proc: Procedure): void {
  const filePath = procedurePath(proc.name, proc.groupId);
  ensureDir(path.dirname(filePath));

  const data = { ...proc };
  data.updated_at = new Date().toISOString();
  if (!data.created_at) {
    data.created_at = data.updated_at;
  }

  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
  logger.debug({ name: proc.name, path: filePath }, 'Saved procedure');
}

/**
 * Find a procedure by trigger text.
 * Searches group-specific procedures first, then global.
 * Uses fuzzy word-overlap matching with a 0.5 threshold.
 */
export function findProcedure(
  trigger: string,
  groupId?: string,
): Procedure | null {
  const normalizedTrigger = trigger.toLowerCase().trim();
  const triggerWords = normalizedTrigger.split(/\s+/).filter(Boolean);

  function scoreMatch(proc: Procedure): number {
    const procWords = proc.trigger.toLowerCase().trim().split(/\s+/).filter(Boolean);
    // Exact match
    if (proc.trigger.toLowerCase().trim() === normalizedTrigger) return 1.0;
    // Word overlap score
    const matchingWords = triggerWords.filter((w) => procWords.includes(w));
    if (matchingWords.length === 0) return 0;
    return matchingWords.length / Math.max(triggerWords.length, procWords.length);
  }

  const FUZZY_THRESHOLD = 0.5;
  let bestMatch: Procedure | null = null;
  let bestScore = 0;

  // Search group-specific first
  if (groupId) {
    for (const p of listProceduresFromDir(groupProceduresDir(groupId))) {
      const score = scoreMatch(p);
      if (score > bestScore && score >= FUZZY_THRESHOLD) {
        bestScore = score;
        bestMatch = p;
      }
    }
    if (bestMatch) return bestMatch;
  }

  // Then global
  for (const p of listProceduresFromDir(globalProceduresDir())) {
    const score = scoreMatch(p);
    if (score > bestScore && score >= FUZZY_THRESHOLD) {
      bestScore = score;
      bestMatch = p;
    }
  }

  return bestMatch;
}

/**
 * List all procedures, optionally filtered by group.
 */
export function listProcedures(groupId?: string): Procedure[] {
  const results: Procedure[] = [];

  // Always include global procedures
  results.push(...listProceduresFromDir(globalProceduresDir()));

  // Add group-specific if requested
  if (groupId) {
    results.push(...listProceduresFromDir(groupProceduresDir(groupId)));
  }

  return results;
}

/**
 * Update procedure stats after execution.
 */
export function updateProcedureStats(
  name: string,
  success: boolean,
  groupId?: string,
): boolean {
  const filePath = procedurePath(name, groupId);

  if (!fs.existsSync(filePath)) {
    // Try global if group-specific not found
    if (groupId) {
      return updateProcedureStats(name, success);
    }
    return false;
  }

  try {
    const data = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as Procedure;
    if (success) {
      data.success_count = (data.success_count || 0) + 1;
    } else {
      data.failure_count = (data.failure_count || 0) + 1;
    }
    data.updated_at = new Date().toISOString();
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
    return true;
  } catch (err) {
    logger.warn(
      { name, error: String(err) },
      'Failed to update procedure stats',
    );
    return false;
  }
}

/**
 * Delete a procedure by name.
 */
export function deleteProcedure(name: string, groupId?: string): boolean {
  const filePath = procedurePath(name, groupId);
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
    return true;
  }
  return false;
}

function listProceduresFromDir(dir: string): Procedure[] {
  if (!fs.existsSync(dir)) return [];

  const procedures: Procedure[] = [];

  try {
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
    for (const file of files) {
      try {
        const data = JSON.parse(
          fs.readFileSync(path.join(dir, file), 'utf-8'),
        ) as Procedure;
        procedures.push(data);
      } catch {
        logger.warn({ file, dir }, 'Failed to parse procedure file');
      }
    }
  } catch {
    // Directory doesn't exist or not readable
  }

  return procedures;
}
