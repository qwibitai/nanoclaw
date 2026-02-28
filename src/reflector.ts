/**
 * Reflector — intelligent garbage collection for observer memory.
 *
 * Deterministic pruning by priority + age. No LLM calls.
 * - 🟢 Noise: pruned after noiseMaxAgeDays (default 30)
 * - 🟡 Useful: pruned after usefulMaxAgeDays (default 90)
 * - 🔴 Critical: kept forever
 *
 * Scans {groupPath}/daily/observer/*.md, parses observation blocks,
 * filters by retention policy, rewrites or deletes files.
 */
import fs from 'node:fs';
import path from 'node:path';

import { logger } from './logger.js';
import type { ReflectorOutput, ReflectorAction } from './schemas.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RetentionPolicy {
  noiseMaxAgeDays: number;
  usefulMaxAgeDays: number;
}

export interface ParsedObservation {
  /** Full header line: "### HH:MM — Topic (emoji Priority)" */
  header: string;
  /** Body text (points + referenced dates) */
  body: string;
  /** Detected priority */
  priority: 'critical' | 'useful' | 'noise';
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_POLICY: RetentionPolicy = {
  noiseMaxAgeDays: 30,
  usefulMaxAgeDays: 90,
};

// ---------------------------------------------------------------------------
// Parser — extract observation blocks from observer markdown
// ---------------------------------------------------------------------------

const PRIORITY_MAP: Record<string, ParsedObservation['priority']> = {
  critical: 'critical',
  useful: 'useful',
  noise: 'noise',
};

/**
 * Parse observer markdown file into observation blocks.
 * Handles the format produced by observationToMarkdown().
 */
export function parseObservationBlocks(content: string): ParsedObservation[] {
  const blocks: ParsedObservation[] = [];

  // Split on "### " at start of line (keep the delimiter)
  const parts = content.split(/^(?=### )/m);

  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed.startsWith('### ')) continue;

    // Extract header (first line) and body (rest)
    const newlineIdx = trimmed.indexOf('\n');
    const header = newlineIdx >= 0 ? trimmed.slice(0, newlineIdx) : trimmed;
    const body = newlineIdx >= 0 ? trimmed.slice(newlineIdx + 1).trim() : '';

    // Detect priority from header — look for (emoji Label) pattern
    const priorityMatch = header.match(
      /\([\u{1F534}\u{1F7E1}\u{1F7E2}]\s*(Critical|Useful|Noise)\)/u,
    );
    const priorityLabel = priorityMatch
      ? priorityMatch[1].toLowerCase()
      : 'useful'; // default to useful (safe — won't be pruned early)
    const priority = PRIORITY_MAP[priorityLabel] ?? 'useful';

    blocks.push({ header, body, priority });
  }

  return blocks;
}

// ---------------------------------------------------------------------------
// Filter — apply retention policy
// ---------------------------------------------------------------------------

/**
 * Compute age of a file in days from its YYYY-MM-DD filename date.
 */
export function fileAgeDays(fileDate: string, now: Date): number {
  const parsed = new Date(fileDate + 'T00:00:00Z');
  if (isNaN(parsed.getTime())) return 0; // unparseable → treat as recent (safe)
  return Math.floor((now.getTime() - parsed.getTime()) / (1000 * 60 * 60 * 24));
}

/**
 * Filter observation blocks by retention policy.
 * Returns which blocks to keep and which were pruned.
 */
export function filterBlocks(
  blocks: ParsedObservation[],
  ageDays: number,
  policy: RetentionPolicy,
): { keep: ParsedObservation[]; pruned: ParsedObservation[] } {
  const keep: ParsedObservation[] = [];
  const pruned: ParsedObservation[] = [];

  for (const block of blocks) {
    switch (block.priority) {
      case 'critical':
        // Never pruned
        keep.push(block);
        break;
      case 'useful':
        if (ageDays > policy.usefulMaxAgeDays) {
          pruned.push(block);
        } else {
          keep.push(block);
        }
        break;
      case 'noise':
        if (ageDays > policy.noiseMaxAgeDays) {
          pruned.push(block);
        } else {
          keep.push(block);
        }
        break;
      default:
        // Unknown priority — keep (safe default)
        keep.push(block);
    }
  }

  return { keep, pruned };
}

// ---------------------------------------------------------------------------
// File reassembly
// ---------------------------------------------------------------------------

/**
 * Extract the file header (source comment + ## heading) from observer markdown.
 */
export function extractFileHeader(content: string): string {
  const lines = content.split('\n');
  const headerLines: string[] = [];

  for (const line of lines) {
    if (line.startsWith('### ')) break; // first observation block
    headerLines.push(line);
  }

  return headerLines.join('\n').trimEnd();
}

/**
 * Reassemble observation blocks into file content.
 */
export function reassembleFile(
  header: string,
  blocks: ParsedObservation[],
): string {
  if (blocks.length === 0) return '';

  const blockTexts = blocks.map((b) =>
    b.body ? `${b.header}\n${b.body}` : b.header,
  );

  return header + '\n\n' + blockTexts.join('\n\n') + '\n';
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

export async function reflectOnMemory(
  groupFolder: string,
  policy?: Partial<RetentionPolicy>,
): Promise<ReflectorOutput> {
  const mergedPolicy: RetentionPolicy = {
    ...DEFAULT_POLICY,
    ...policy,
  };

  const actions: ReflectorAction[] = [];

  try {
    // Resolve path
    const { resolveGroupFolderPath } = await import('./group-folder.js');
    const groupPath = resolveGroupFolderPath(groupFolder);
    const observerDir = path.join(groupPath, 'daily', 'observer');

    // Check if observer directory exists
    if (!fs.existsSync(observerDir)) {
      logger.info(
        { groupFolder },
        'Reflector: no observer directory, nothing to prune',
      );
      return { actions, summary: 'No observer data found.' };
    }

    // List all .md files
    const files = fs.readdirSync(observerDir).filter((f) => f.endsWith('.md'));
    if (files.length === 0) {
      return { actions, summary: 'No observer files found.' };
    }

    const now = new Date();
    let totalPruned = 0;
    let filesDeleted = 0;
    let filesRewritten = 0;

    for (const file of files) {
      const filePath = path.join(observerDir, file);
      const fileDate = file.replace('.md', '');
      const ageDays = fileAgeDays(fileDate, now);

      // Read file content
      let content: string;
      try {
        content = fs.readFileSync(filePath, 'utf-8');
      } catch {
        continue; // skip unreadable files
      }

      // Parse observation blocks
      const blocks = parseObservationBlocks(content);
      if (blocks.length === 0) continue;

      // Apply retention policy
      const { keep, pruned } = filterBlocks(blocks, ageDays, mergedPolicy);

      if (pruned.length === 0) continue; // nothing to prune in this file

      totalPruned += pruned.length;

      // Log pruned actions
      for (const p of pruned) {
        actions.push({
          action: 'prune',
          targetPath: `${file}:${p.header.slice(0, 60)}`,
          reason: `${p.priority} entry, ${ageDays} days old`,
        });
      }

      if (keep.length === 0) {
        // All blocks pruned — delete file
        fs.unlinkSync(filePath);
        filesDeleted++;
        actions.push({
          action: 'prune',
          targetPath: file,
          reason: `All ${pruned.length} entries expired, file deleted`,
        });
      } else {
        // Some blocks remain — rewrite file
        const header = extractFileHeader(content);
        const newContent = reassembleFile(header, keep);
        fs.writeFileSync(filePath, newContent, 'utf-8');
        filesRewritten++;
      }
    }

    const summary =
      totalPruned === 0
        ? 'No entries exceeded retention policy.'
        : `Pruned ${totalPruned} entries across ${filesDeleted + filesRewritten} files ` +
          `(${filesDeleted} deleted, ${filesRewritten} rewritten).`;

    logger.info(
      { groupFolder, totalPruned, filesDeleted, filesRewritten },
      'Reflector complete',
    );

    return { actions, summary };
  } catch (err) {
    logger.error({ err }, 'Reflector unexpected error');
    return { actions, summary: 'Reflector failed — see logs.' };
  }
}
