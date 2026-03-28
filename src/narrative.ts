import fs from 'fs';
import path from 'path';

import { GROUPS_DIR } from './config.js';
import { getDb } from './db.js';

export type NarrativeEventType = 'task_complete' | 'milestone' | 'failure' | 'insight';

export interface NarrativeEvent {
  id: number;
  group_folder: string;
  event_type: NarrativeEventType;
  description: string;
  created_at: string;
  included_in_narrative: number;
}

export function recordNarrativeEvent(
  groupFolder: string,
  eventType: NarrativeEventType,
  description: string,
): void {
  const db = getDb();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO narrative_events (group_folder, event_type, description, created_at, included_in_narrative)
     VALUES (?, ?, ?, ?, 0)`,
  ).run(groupFolder, eventType, description, now);
}

export function getPendingNarrativeEvents(groupFolder: string): NarrativeEvent[] {
  const db = getDb();
  return db
    .prepare(
      `SELECT * FROM narrative_events
       WHERE group_folder = ? AND included_in_narrative = 0
       ORDER BY created_at`,
    )
    .all(groupFolder) as NarrativeEvent[];
}

export function markNarrativeEventsIncluded(ids: number[]): void {
  if (ids.length === 0) return;
  const db = getDb();
  const placeholders = ids.map(() => '?').join(', ');
  db.prepare(
    `UPDATE narrative_events SET included_in_narrative = 1 WHERE id IN (${placeholders})`,
  ).run(...ids);
}

export function buildNarrativeUpdatePrompt(
  groupFolder: string,
  currentNarrative: string,
  newEvents: NarrativeEvent[],
): string {
  const eventLines = newEvents
    .map((e) => `- [${e.event_type}] ${e.description}`)
    .join('\n');

  return `You are updating the living narrative for the group "${groupFolder}".

Current narrative:
${currentNarrative}

New events to incorporate:
${eventLines}

Instructions:
- Integrate the new events into the narrative in a coherent, concise way.
- Preserve important context from the current narrative.
- Write from a third-person perspective, as a historical record.
- Keep the narrative focused and avoid unnecessary repetition.
- Return only the updated narrative text.`;
}

export function ensureNarrativeFile(groupFolder: string): void {
  const narrativePath = path.join(GROUPS_DIR, groupFolder, 'NARRATIVE.md');
  if (!fs.existsSync(narrativePath)) {
    fs.mkdirSync(path.dirname(narrativePath), { recursive: true });
    fs.writeFileSync(
      narrativePath,
      `# ${groupFolder} — Narrative\n\n_No narrative yet. History will appear here after the first consolidation cycle._\n`,
    );
  }
}

export function getNarrativePath(groupFolder: string): string {
  return path.join(GROUPS_DIR, groupFolder, 'NARRATIVE.md');
}
