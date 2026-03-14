/**
 * Self-improvement file system: .learnings/LEARNINGS.md + .learnings/ERRORS.md
 * Sequential IDs, file write queue for safe concurrent access.
 *
 * Ported from memory-lancedb-pro.
 */

import fs from 'fs';
import path from 'path';

// ============================================================================
// Types
// ============================================================================

export interface LearningEntry {
  id: number;
  timestamp: string;
  category: 'learning' | 'error' | 'pattern' | 'insight';
  text: string;
  context?: string;
}

// ============================================================================
// Constants
// ============================================================================

const LEARNINGS_DIR = '/workspace/group/.learnings';
const LEARNINGS_FILE = path.join(LEARNINGS_DIR, 'LEARNINGS.md');
const ERRORS_FILE = path.join(LEARNINGS_DIR, 'ERRORS.md');

// ============================================================================
// File Write Queue (serialized writes to avoid corruption)
// ============================================================================

let _writeQueue: Promise<void> = Promise.resolve();

function enqueueWrite(fn: () => Promise<void>): Promise<void> {
  _writeQueue = _writeQueue.then(fn).catch(err => {
    console.warn(`[self-improvement] Write failed: ${err instanceof Error ? err.message : String(err)}`);
  });
  return _writeQueue;
}

// ============================================================================
// Core Functions
// ============================================================================

function ensureDir(): void {
  if (!fs.existsSync(LEARNINGS_DIR)) {
    fs.mkdirSync(LEARNINGS_DIR, { recursive: true });
  }
}

function getNextId(filePath: string): number {
  if (!fs.existsSync(filePath)) return 1;

  const content = fs.readFileSync(filePath, 'utf-8');
  const matches = content.match(/^## (\d+)\./gm);
  if (!matches || matches.length === 0) return 1;

  const ids = matches.map(m => parseInt(m.replace('## ', '').replace('.', ''), 10));
  return Math.max(...ids) + 1;
}

function formatEntry(entry: LearningEntry): string {
  const lines: string[] = [];
  lines.push(`## ${entry.id}. [${entry.category.toUpperCase()}] ${entry.timestamp}`);
  lines.push('');
  lines.push(entry.text);
  if (entry.context) {
    lines.push('');
    lines.push(`> Context: ${entry.context}`);
  }
  lines.push('');
  lines.push('---');
  lines.push('');
  return lines.join('\n');
}

function initFile(filePath: string, title: string): void {
  if (!fs.existsSync(filePath)) {
    const header = `# ${title}\n\nAutomatically collected insights and improvements.\n\n---\n\n`;
    fs.writeFileSync(filePath, header);
  }
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Log a learning or insight.
 */
export function logLearning(
  text: string,
  category: 'learning' | 'pattern' | 'insight' = 'learning',
  context?: string,
): Promise<void> {
  return enqueueWrite(async () => {
    ensureDir();
    initFile(LEARNINGS_FILE, 'Learnings');

    const entry: LearningEntry = {
      id: getNextId(LEARNINGS_FILE),
      timestamp: new Date().toISOString(),
      category,
      text,
      context,
    };

    fs.appendFileSync(LEARNINGS_FILE, formatEntry(entry));
  });
}

/**
 * Log an error or mistake for future avoidance.
 */
export function logError(
  text: string,
  context?: string,
): Promise<void> {
  return enqueueWrite(async () => {
    ensureDir();
    initFile(ERRORS_FILE, 'Errors & Mistakes');

    const entry: LearningEntry = {
      id: getNextId(ERRORS_FILE),
      timestamp: new Date().toISOString(),
      category: 'error',
      text,
      context,
    };

    fs.appendFileSync(ERRORS_FILE, formatEntry(entry));
  });
}

/**
 * Read all entries from a learning file.
 */
export function readLearnings(): LearningEntry[] {
  return readEntries(LEARNINGS_FILE);
}

/**
 * Read all error entries.
 */
export function readErrors(): LearningEntry[] {
  return readEntries(ERRORS_FILE);
}

function readEntries(filePath: string): LearningEntry[] {
  if (!fs.existsSync(filePath)) return [];

  const content = fs.readFileSync(filePath, 'utf-8');
  const entries: LearningEntry[] = [];

  // Parse entries by ## heading
  const sections = content.split(/^## /gm).slice(1); // skip header
  for (const section of sections) {
    const lines = section.split('\n');
    const headerMatch = lines[0]?.match(/^(\d+)\.\s+\[(\w+)\]\s+(.+)/);
    if (!headerMatch) continue;

    const id = parseInt(headerMatch[1], 10);
    const category = headerMatch[2].toLowerCase() as LearningEntry['category'];
    const timestamp = headerMatch[3].trim();

    // Collect body text (skip empty lines and --- separator)
    const bodyLines: string[] = [];
    let contextText: string | undefined;

    for (let i = 1; i < lines.length; i++) {
      const line = lines[i];
      if (line === '---') break;
      if (line.startsWith('> Context: ')) {
        contextText = line.replace('> Context: ', '');
      } else if (line.trim()) {
        bodyLines.push(line);
      }
    }

    entries.push({
      id,
      timestamp,
      category,
      text: bodyLines.join('\n'),
      context: contextText,
    });
  }

  return entries;
}
