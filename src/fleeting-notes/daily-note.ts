/**
 * Stage 2: Build the daily note's Fleeting Notes section.
 *
 * Reads all unprocessed (status: raw) fleeting notes from the vault,
 * formats them per the daily note spec, and appends/updates the section
 * in today's daily note.
 */

import fs from 'fs';
import path from 'path';

import { logger } from '../logger.js';
import { loadRegistry } from './registry.js';
import type {
  FleetingNote,
  ProjectRegistryEntry,
  RoutingProposal,
} from './types.js';

const FLEETING_START = '<!-- fleeting-start -->';
const FLEETING_END = '<!-- fleeting-end -->';

/** Parse YAML-ish frontmatter from a markdown file (simple key: value). */
export function parseFrontmatter(
  content: string,
): Record<string, string> | null {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return null;
  const fm: Record<string, string> = {};
  for (const line of match[1].split('\n')) {
    const m = line.match(/^(\w[\w_]*?):\s*"?(.+?)"?\s*$/);
    if (m) fm[m[1]] = m[2];
  }
  return fm;
}

/** Collect all fleeting notes with status: raw from the vault. */
export function collectUnprocessedNotes(vaultPath: string): FleetingNote[] {
  const fleetingDir = path.join(vaultPath, 'Fleeting');
  const notes: FleetingNote[] = [];

  if (!fs.existsSync(fleetingDir)) return notes;

  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        walk(path.join(dir, entry.name));
      } else if (entry.name.endsWith('.md') && !entry.name.startsWith('_')) {
        const absPath = path.join(dir, entry.name);
        const content = fs.readFileSync(absPath, 'utf-8');
        const fm = parseFrontmatter(content);
        if (!fm || fm.status !== 'raw') continue;

        // Extract title from first # heading
        const titleMatch = content.match(/^#\s+(.+)$/m);
        const title = titleMatch ? titleMatch[1].trim() : entry.name.replace('.md', '');

        // Extract body (everything after the heading)
        const bodyMatch = content.match(/^#\s+.+\n+([\s\S]*)/m);
        const body = bodyMatch ? bodyMatch[1].trim() : '';

        const relPath = path.relative(vaultPath, absPath);
        notes.push({
          path: relPath,
          slug: entry.name.replace('.md', ''),
          title,
          body,
          source: (fm.source as FleetingNote['source']) || 'things',
          thingsUuid: fm.things_uuid,
          created: fm.created || '',
          status: 'raw',
          project: fm.project,
        });
      }
    }
  };

  walk(fleetingDir);
  // Sort by created date (oldest first)
  notes.sort((a, b) => a.created.localeCompare(b.created));
  return notes;
}

/**
 * Generate a rule-based routing proposal for a fleeting note.
 * Phase 1: heuristic matching. Phase 2 will use container agent AI.
 */
export function generateProposal(
  note: FleetingNote,
  registry: ProjectRegistryEntry[],
): RoutingProposal {
  const text = `${note.title} ${note.body}`.toLowerCase();

  // Find matching project
  let matchedProject: ProjectRegistryEntry | null = null;
  // From detectProject logic (already run at ingest time, stored in note.project)
  if (note.project) {
    matchedProject =
      registry.find(
        (p) => p.name.toLowerCase() === note.project!.toLowerCase(),
      ) || null;
  }

  const projectLine = matchedProject
    ? `Project ${matchedProject.name}.`
    : 'No project match.';

  // Determine conversion path
  const hasUrl = /https?:\/\//.test(text);
  const isAction =
    /\b(reply|email|send|buy|check|submit|call|talk|ask|resubmit|schedule|book|fix|update|implement|create|start|finish)\b/.test(
      text,
    );
  const isStale = isOlderThanWeeks(note.created, 2);
  const isShort = !note.body && note.title.length < 15;
  const isTest = /\b(test|testing)\b/.test(text) && isShort;

  if (isTest) {
    return {
      projectLine,
      text: `${projectLine} Retire — test item with no actionable content.`,
    };
  }

  if (isStale && isShort) {
    return {
      projectLine,
      text: `${projectLine} Retire — stale item (${note.created}) with insufficient context.`,
    };
  }

  if (hasUrl) {
    const desc = matchedProject
      ? `literature note in ${matchedProject.name}`
      : 'literature note';
    return {
      projectLine,
      text: `${projectLine} Literature note + permanent note — ${desc}, fetch and preserve source text.`,
    };
  }

  if (isAction && matchedProject) {
    return {
      projectLine,
      text: `${projectLine} #task — action item for ${matchedProject.name}.`,
    };
  }

  if (isAction) {
    return {
      projectLine,
      text: `${projectLine} #task — actionable item, route to appropriate project.`,
    };
  }

  if (matchedProject) {
    return {
      projectLine,
      text: `${projectLine} Permanent note — insight or observation for ${matchedProject.name}.`,
    };
  }

  return {
    projectLine,
    text: `No project match. Idea log entry — capture for future routing, or retire if context is lost.`,
  };
}

function isOlderThanWeeks(dateStr: string, weeks: number): boolean {
  if (!dateStr) return false;
  const created = new Date(dateStr);
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - weeks * 7);
  return created < cutoff;
}

/** Format a single daily note entry per the format spec. */
export function formatDailyNoteEntry(
  index: number,
  note: FleetingNote,
  proposal: RoutingProposal,
): string {
  const wikiLink = `[[${note.path.replace('.md', '')}|f-note]]`;

  const lines: string[] = [];
  lines.push(`${index}. **${note.title}** (${note.created}) ${wikiLink}`);

  // Notes (≤2 lines verbatim) vs Summary (>2 lines AI summary)
  const bodyText = note.body || '';
  if (bodyText) {
    const bodyLines = bodyText.split('\n').filter((l) => l.trim());
    if (bodyLines.length <= 2) {
      lines.push(`    **Notes:** ${bodyText.replace(/\n/g, ' ')}`);
    } else {
      // For rule-based Phase 1, use first 2 lines as summary
      const summary = bodyLines.slice(0, 2).join(' ');
      lines.push(`    **Summary:** ${summary}`);
    }
  }

  // Routing proposal
  lines.push(`    **Proposed:** ${proposal.text}`);

  // Action controls
  lines.push('    - [ ] Accept');
  lines.push('    - [ ] Retire');
  lines.push('    **Chat:**');
  lines.push('    **Response:**');

  return lines.join('\n');
}

/** Build the full Fleeting Notes section for the daily note. */
export function buildDailyNoteSection(
  notes: FleetingNote[],
  registry: ProjectRegistryEntry[],
): string {
  const now = new Date();
  const tz =
    Intl.DateTimeFormat().resolvedOptions().timeZone?.split('/').pop() || 'UTC';
  const time = now.toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const dateStr = now.toISOString().slice(0, 10);

  const lines: string[] = [];
  lines.push(FLEETING_START);
  lines.push('');
  lines.push(
    `## Fleeting Notes (appended ${dateStr} ~${time} ${tz})`,
  );
  lines.push('');

  if (notes.length === 0) {
    lines.push('### Unprocessed (0 — all processed)');
  } else {
    const source = [...new Set(notes.map((n) => n.source))].join(', ');
    lines.push(`### Unprocessed (${notes.length} from ${source})`);
    lines.push('');

    for (let i = 0; i < notes.length; i++) {
      const proposal = generateProposal(notes[i], registry);
      lines.push(formatDailyNoteEntry(i + 1, notes[i], proposal));
      lines.push('');
    }

    lines.push('**Bulk Response:**');
    lines.push('');
  }

  lines.push('### Routed');
  lines.push('');
  lines.push(FLEETING_END);

  return lines.join('\n');
}

/**
 * Find today's daily note file in the vault.
 * Pattern: 0a. Daily Notes/{year}/{month}-{MonthName}/{date}-{DayName}.md
 */
export function findDailyNoteFile(
  vaultPath: string,
  date?: Date,
): string | null {
  const d = date || new Date();
  const year = String(d.getFullYear());
  const monthNum = String(d.getMonth() + 1).padStart(2, '0');
  const months = [
    'January',
    'February',
    'March',
    'April',
    'May',
    'June',
    'July',
    'August',
    'September',
    'October',
    'November',
    'December',
  ];
  const monthName = months[d.getMonth()];
  const dayNum = String(d.getDate()).padStart(2, '0');

  const monthDir = path.join(
    vaultPath,
    '0a. Daily Notes',
    year,
    `${monthNum}-${monthName}`,
  );

  if (!fs.existsSync(monthDir)) return null;

  const datePrefix = `${year}-${monthNum}-${dayNum}`;
  const files = fs.readdirSync(monthDir);
  const match = files.find((f) => f.startsWith(datePrefix) && f.endsWith('.md'));
  return match ? path.join(monthDir, match) : null;
}

/**
 * Update the daily note with the Fleeting Notes section.
 * Uses HTML comment markers for idempotent replacement.
 */
export function updateDailyNote(vaultPath: string, section: string): boolean {
  const dailyNotePath = findDailyNoteFile(vaultPath);
  if (!dailyNotePath) {
    logger.warn('No daily note file found for today');
    return false;
  }

  let content = fs.readFileSync(dailyNotePath, 'utf-8');

  // Replace existing section or append
  const startIdx = content.indexOf(FLEETING_START);
  const endIdx = content.indexOf(FLEETING_END);

  if (startIdx !== -1 && endIdx !== -1) {
    // Replace existing section
    content =
      content.slice(0, startIdx) +
      section +
      content.slice(endIdx + FLEETING_END.length);
  } else {
    // Append with separator
    content = content.trimEnd() + '\n\n---\n\n' + section + '\n';
  }

  fs.writeFileSync(dailyNotePath, content);
  logger.info({ path: dailyNotePath }, 'Daily note updated with fleeting notes section');
  return true;
}
