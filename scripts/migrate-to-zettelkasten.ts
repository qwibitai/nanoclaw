#!/usr/bin/env npx tsx
/**
 * One-time migration: convert existing inbox.md and notes.md entries
 * into individual fleeting/permanent note files with YAML frontmatter.
 *
 * Usage: npx tsx scripts/migrate-to-zettelkasten.ts
 */
import fs from 'fs';
import path from 'path';
import os from 'os';

const EXOCORTEX = path.join(os.homedir(), 'Documents', 'ai_assistant');
const FLEETING_DIR = path.join(EXOCORTEX, 'fleeting');
const NOTES_DIR = path.join(EXOCORTEX, 'notes');

function slugify(text: string, maxLen = 40): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, maxLen)
    .replace(/-$/, '');
}

interface InboxEntry {
  date: string;  // YYYY-MM-DD
  time: string;  // HH:MM TZ
  content: string;
  source?: string;  // "from Things, ..." etc
}

function parseInboxMd(filePath: string): InboxEntry[] {
  if (!fs.existsSync(filePath)) return [];
  const text = fs.readFileSync(filePath, 'utf-8');
  const entries: InboxEntry[] = [];

  // Split on ## headings (date entries)
  const sections = text.split(/^## /m).slice(1); // skip header

  for (const section of sections) {
    const lines = section.trim().split('\n');
    const dateLine = lines[0].trim();

    // Match "YYYY-MM-DD HH:MM TZ" or "Unrouted" etc
    const dateMatch = dateLine.match(/^(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2}\s+\w+)/);
    if (!dateMatch) continue; // skip non-date sections like "Unrouted"

    const content = lines.slice(1).join('\n').trim();
    if (!content) continue;

    // Check for "(from Things, ...)" source annotation
    const sourceMatch = content.match(/\(from (\w+),\s*([\d-]+)\)/);
    const source = sourceMatch ? sourceMatch[1].toLowerCase() : 'capture';
    const cleanContent = content.replace(/\n\(from \w+,\s*[\d-]+\)\s*$/, '').trim();

    entries.push({
      date: dateMatch[1],
      time: dateMatch[2],
      content: cleanContent,
      source,
    });
  }

  return entries;
}

interface NoteEntry {
  title: string;
  content: string;
  source?: string;
}

function parseNotesMd(filePath: string): NoteEntry[] {
  if (!fs.existsSync(filePath)) return [];
  const text = fs.readFileSync(filePath, 'utf-8');
  const entries: NoteEntry[] = [];

  const sections = text.split(/^## /m).slice(1); // skip header

  for (const section of sections) {
    const lines = section.trim().split('\n');
    const title = lines[0].trim();
    if (!title) continue;

    const content = lines.slice(1).join('\n').trim();
    if (!content) continue;

    const sourceMatch = content.match(/\(Source: (.+?)\)/);
    entries.push({
      title,
      content: content.replace(/\n?\(Source: .+?\)\s*$/, '').trim(),
      source: sourceMatch ? sourceMatch[1] : undefined,
    });
  }

  return entries;
}

function main() {
  fs.mkdirSync(FLEETING_DIR, { recursive: true });
  fs.mkdirSync(NOTES_DIR, { recursive: true });

  // Track sequence numbers per date
  const seqByDate: Record<string, number> = {};
  const getSeq = (date: string): string => {
    seqByDate[date] = (seqByDate[date] || 0) + 1;
    return String(seqByDate[date]).padStart(3, '0');
  };

  // Migrate inbox files → fleeting notes
  const inboxFiles = [
    { path: path.join(EXOCORTEX, 'inbox.md'), project: 'general' },
    { path: path.join(EXOCORTEX, 'nanoclaw', 'inbox.md'), project: 'nanoclaw' },
    { path: path.join(EXOCORTEX, 'projects', 'onto', 'inbox.md'), project: 'onto' },
  ];

  let fleetingCount = 0;
  for (const inbox of inboxFiles) {
    const entries = parseInboxMd(inbox.path);
    for (const entry of entries) {
      // Skip noise
      if (['test', 'ok', '(empty)'].includes(entry.content.toLowerCase().trim())) continue;

      const seq = getSeq(entry.date);
      const slug = slugify(entry.content.split(/\s+/).slice(0, 6).join(' '));
      const filename = `${entry.date}-${seq}-${slug || 'note'}.md`;
      const filePath = path.join(FLEETING_DIR, filename);

      const fm = [
        '---',
        'type: fleeting',
        'status: active',
        `project: ${inbox.project}`,
        `source: ${entry.source || 'capture'}`,
        `created: "${entry.date} ${entry.time}"`,
        '---',
      ].join('\n');

      fs.writeFileSync(filePath, fm + '\n' + entry.content + '\n');
      fleetingCount++;
    }
  }

  // Migrate notes.md files → permanent notes
  const notesFiles = [
    { path: path.join(EXOCORTEX, 'nanoclaw', 'notes.md'), project: 'nanoclaw' },
    { path: path.join(EXOCORTEX, 'projects', 'onto', 'notes.md'), project: 'onto' },
  ];

  let permanentCount = 0;
  for (const notes of notesFiles) {
    const entries = parseNotesMd(notes.path);
    for (const entry of entries) {
      const slug = slugify(entry.title);
      if (!slug) continue;
      const filename = `${slug}.md`;
      const filePath = path.join(NOTES_DIR, filename);

      const fm = [
        '---',
        'type: permanent',
        `project: ${notes.project}`,
        entry.source ? `source: "${entry.source}"` : null,
        '---',
      ]
        .filter(Boolean)
        .join('\n');

      const body = `# ${entry.title}\n\n${entry.content}\n`;
      fs.writeFileSync(filePath, fm + '\n' + body);
      permanentCount++;
    }
  }

  console.log(`Migration complete:`);
  console.log(`  ${fleetingCount} fleeting notes created in ${FLEETING_DIR}`);
  console.log(`  ${permanentCount} permanent notes created in ${NOTES_DIR}`);
  console.log(`\nOriginal inbox.md and notes.md files are preserved (not deleted).`);
  console.log(`Review the migration, then remove the old files manually.`);
}

main();
