/**
 * Stage 1: Ingest Things Today items into fleeting notes in the Obsidian vault.
 *
 * Reads Things 3 SQLite DB directly for items in Today view,
 * creates fleeting note files, and marks items as completed in Things.
 */

import { exec } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import Database from 'better-sqlite3';

import { logger } from '../logger.js';
import { detectProject, loadRegistry } from './registry.js';
import type { FleetingNote, IngestResult, ThingsItem } from './types.js';

function resolvePath(p: string): string {
  if (p.startsWith('~')) return path.join(os.homedir(), p.slice(1));
  return p;
}

/** Generate a URL-safe slug from a title. */
export function slugify(title: string): string {
  return title
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60);
}

/** Format a Date as YYYY-MM-DD. */
function formatDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** Build the vault-relative path for a fleeting note. */
export function fleetingNotePath(created: Date, slug: string): string {
  const y = String(created.getFullYear());
  const m = String(created.getMonth() + 1).padStart(2, '0');
  const d = String(created.getDate()).padStart(2, '0');
  return `Fleeting/${y}/${m}/${d}/${slug}.md`;
}

/** Build frontmatter + body for a fleeting note file. */
export function buildFleetingNoteContent(
  title: string,
  body: string,
  created: string,
  thingsUuid: string,
  project?: string,
): string {
  const lines = [
    '---',
    'source: things',
    `created: ${created}`,
    `things_uuid: ${thingsUuid}`,
    'status: raw',
    ...(project ? [`project: ${project}`] : []),
    '---',
    '',
    `# ${title.trim()}`,
  ];
  if (body && body.trim()) {
    lines.push('', body.trim());
  }
  lines.push('');
  return lines.join('\n');
}

/** Read Things Today items directly from the Things SQLite DB. */
export function readThingsToday(thingsDbPath: string): ThingsItem[] {
  const resolvedDb = resolvePath(thingsDbPath);
  let db: Database.Database;
  try {
    db = new Database(resolvedDb, { readonly: true, fileMustExist: true });
  } catch (err) {
    logger.error({ err, path: resolvedDb }, 'Failed to open Things database');
    return [];
  }

  try {
    // Things Today: todayIndex is not null, status=0 (incomplete), not trashed
    const query = `
      SELECT uuid, title, notes, creationDate
      FROM TMTask
      WHERE type = 0
        AND status = 0
        AND trashed = 0
        AND todayIndex IS NOT NULL
    `;
    return db.prepare(query).all() as ThingsItem[];
  } finally {
    db.close();
  }
}

/** Find existing fleeting notes by Things UUID to prevent duplicates. */
export function findExistingUuids(vaultPath: string): Set<string> {
  const fleetingDir = path.join(vaultPath, 'Fleeting');
  const uuids = new Set<string>();

  if (!fs.existsSync(fleetingDir)) return uuids;

  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        walk(path.join(dir, entry.name));
      } else if (entry.name.endsWith('.md') && !entry.name.startsWith('_')) {
        try {
          const content = fs.readFileSync(path.join(dir, entry.name), 'utf-8');
          const match = content.match(/things_uuid:\s*(\S+)/);
          if (match) uuids.add(match[1]);
        } catch {
          // skip unreadable files
        }
      }
    }
  };

  walk(fleetingDir);
  return uuids;
}

/** Mark a Things item as completed via the things CLI. */
export function markThingsCompleted(
  uuid: string,
  authToken: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const cmd = `THINGS_AUTH_TOKEN=${authToken} things update --id ${uuid} --completed`;
    exec(cmd, (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

/**
 * Ingest all Things Today items as fleeting notes in the Obsidian vault.
 *
 * - Reads Things Today from SQLite
 * - Deduplicates against existing fleeting notes (by UUID)
 * - Creates fleeting note files with frontmatter
 * - Marks Things items as completed
 */
export async function ingestThingsToday(
  vaultPath: string,
  thingsDbPath: string,
  thingsAuthToken: string,
): Promise<IngestResult> {
  const result: IngestResult = { created: [], skipped: [], errors: [] };

  // Read Things Today
  const items = readThingsToday(thingsDbPath);
  if (items.length === 0) {
    logger.debug('No items in Things Today');
    return result;
  }

  // Find existing UUIDs to deduplicate
  const existingUuids = findExistingUuids(vaultPath);

  // Load project registry for routing detection
  const registry = loadRegistry(vaultPath);

  for (const item of items) {
    // Skip empty titles
    if (!item.title || !item.title.trim()) {
      result.skipped.push(item.uuid);
      continue;
    }

    // Deduplicate
    if (existingUuids.has(item.uuid)) {
      result.skipped.push(item.uuid);
      continue;
    }

    const slug = slugify(item.title);
    if (!slug) {
      result.skipped.push(item.uuid);
      continue;
    }

    // Things stores Unix timestamps directly
    const createdDate = new Date(item.creationDate * 1000);
    const createdStr = formatDate(createdDate);

    const notePath = fleetingNotePath(createdDate, slug);
    const absPath = path.join(vaultPath, notePath);

    // Ensure directory exists
    fs.mkdirSync(path.dirname(absPath), { recursive: true });

    // Don't overwrite existing files (extra safety beyond UUID dedup)
    if (fs.existsSync(absPath)) {
      result.skipped.push(item.uuid);
      continue;
    }

    // Detect project from content
    const project = detectProject(registry, item.title, item.notes || '');

    // Write fleeting note
    const content = buildFleetingNoteContent(
      item.title,
      item.notes || '',
      createdStr,
      item.uuid,
      project?.name,
    );
    fs.writeFileSync(absPath, content);

    const note: FleetingNote = {
      path: notePath,
      slug,
      title: item.title.trim(),
      body: (item.notes || '').trim(),
      source: 'things',
      thingsUuid: item.uuid,
      created: createdStr,
      status: 'raw',
      project: project?.name,
    };
    result.created.push(note);
    existingUuids.add(item.uuid); // prevent within-batch duplicates

    // Mark as completed in Things
    if (thingsAuthToken) {
      try {
        await markThingsCompleted(item.uuid, thingsAuthToken);
      } catch (err) {
        result.errors.push(
          `Failed to complete Things item ${item.uuid}: ${err}`,
        );
      }
    }
  }

  if (result.created.length > 0) {
    logger.info(
      { created: result.created.length, skipped: result.skipped.length },
      'Fleeting notes: ingestion complete',
    );
  }

  return result;
}
