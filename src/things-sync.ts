/**
 * Things 3 sync — reads the Things SQLite DB on the host side,
 * exports new items to the exocortex, and moves ingested items
 * under the "Ingested" heading after the agent processes them.
 */
import { exec } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import Database from 'better-sqlite3';

import { logger } from './logger.js';

interface ThingsItem {
  uuid: string;
  title: string;
  notes: string | null;
  project_title: string | null;
  creationDate: number; // Core Data timestamp (seconds since 2001-01-01)
}

interface ThingsProjectConfig {
  uuid: string;
  name: string;
  ingestedHeadingUuid: string;
}

interface ThingsConfig {
  projects: ThingsProjectConfig[];
}

interface SyncState {
  lastSyncUuids: string[];
  lastSyncTime: string;
}

function resolvePath(p: string): string {
  if (p.startsWith('~')) return path.join(os.homedir(), p.slice(1));
  return p;
}

// Things stores creationDate as Unix timestamp (seconds since 1970-01-01)
function thingsTimestampToDate(timestamp: number): string {
  return new Date(timestamp * 1000).toISOString();
}

function readJsonFile<T>(filePath: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return null;
  }
}

function writeJsonFile(filePath: string, data: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n');
}

export async function syncThingsToExocortex(
  exocortexPath: string,
  thingsDbPath: string,
  thingsAuthToken: string,
): Promise<void> {
  const resolvedExocortex = resolvePath(exocortexPath);
  const resolvedDb = resolvePath(thingsDbPath);

  const ingestDir = path.join(resolvedExocortex, 'ingest');
  const configPath = path.join(ingestDir, '.things_config.json');
  const syncStatePath = path.join(ingestDir, '.things_sync_state.json');
  const inboxPath = path.join(ingestDir, 'things_inbox.json');
  const ingestedPath = path.join(ingestDir, '.things_ingested.json');

  // 1. Read config
  const config = readJsonFile<ThingsConfig>(configPath);
  if (!config || !config.projects.length) {
    logger.debug('No Things projects configured, skipping sync');
    return;
  }

  const projectUuids = config.projects.map((p) => p.uuid);

  // 2. Open Things DB read-only
  let db: Database.Database;
  try {
    db = new Database(resolvedDb, { readonly: true, fileMustExist: true });
    db.pragma('journal_mode = WAL');
  } catch (err) {
    logger.error({ err, path: resolvedDb }, 'Failed to open Things database');
    return;
  }

  try {
    // 3. Query uningested items (heading IS NULL = not under "Ingested")
    const placeholders = projectUuids.map(() => '?').join(', ');
    const query = `
      SELECT t.uuid, t.title, t.notes, t.creationDate, p.title as project_title
      FROM TMTask t
      JOIN TMTask p ON t.project = p.uuid
      WHERE t.type = 0
        AND t.status = 0
        AND t.trashed = 0
        AND t.project IN (${placeholders})
        AND t.heading IS NULL
    `;
    const items = db.prepare(query).all(...projectUuids) as ThingsItem[];
    // 4. Read last sync state
    const syncState = readJsonFile<SyncState>(syncStatePath) || {
      lastSyncUuids: [],
      lastSyncTime: '',
    };

    // 5. Find new items
    const lastUuids = new Set(syncState.lastSyncUuids);
    const newItems = items.filter((item) => !lastUuids.has(item.uuid));

    if (newItems.length > 0) {
      // 6. Write new items to inbox (append to existing if any)
      const existingInbox = readJsonFile<ThingsItem[]>(inboxPath) || [];
      const existingUuids = new Set(existingInbox.map((i) => i.uuid));
      const toAdd = newItems.filter((i) => !existingUuids.has(i.uuid));

      if (toAdd.length > 0) {
        const inboxItems = [
          ...existingInbox,
          ...toAdd.map((item) => ({
            uuid: item.uuid,
            title: item.title,
            notes: item.notes,
            project_title: item.project_title,
            creationDate: thingsTimestampToDate(item.creationDate),
          })),
        ];
        writeJsonFile(inboxPath, inboxItems);
        logger.info(
          { count: toAdd.length },
          'Things: new items written to inbox',
        );
      }
    }

    // 7. Process ingested items — move them under "Ingested" heading
    const ingested = readJsonFile<string[]>(ingestedPath);
    if (ingested && ingested.length > 0) {
      for (const uuid of ingested) {
        // Find which project this item belongs to (query DB directly, not filtered result)
        const itemProjectRow = db
          .prepare('SELECT project FROM TMTask WHERE uuid = ?')
          .get(uuid) as { project: string } | undefined;
        if (!itemProjectRow) {
          logger.warn({ uuid }, 'Things: ingested item not found in DB, skipping');
          continue;
        }

        const projectConfig = config.projects.find(
          (p) => p.uuid === itemProjectRow.project,
        );
        if (!projectConfig) {
          logger.warn({ uuid, project: itemProjectRow.project }, 'Things: no config for item project, skipping');
          continue;
        }

        const url = `things:///update?id=${uuid}&auth-token=${thingsAuthToken}&heading-id=${projectConfig.ingestedHeadingUuid}`;
        exec(`open ${JSON.stringify(url)}`, (err) => {
          if (err) {
            logger.error(
              { err, uuid },
              'Failed to move Things item to Ingested',
            );
          } else {
            logger.info({ uuid }, 'Things: moved item to Ingested heading');
          }
        });

        // Small delay between URL scheme calls to avoid overwhelming Things
        await new Promise((resolve) => setTimeout(resolve, 500));
      }

      // Clear ingested file
      writeJsonFile(ingestedPath, []);

      // Remove ingested items from the inbox queue so they aren't re-read
      const currentInbox = readJsonFile<ThingsItem[]>(inboxPath) || [];
      const ingestedSet = new Set(ingested);
      const remainingInbox = currentInbox.filter(
        (item) => !ingestedSet.has(item.uuid),
      );
      writeJsonFile(inboxPath, remainingInbox);
      if (currentInbox.length !== remainingInbox.length) {
        logger.info(
          { removed: currentInbox.length - remainingInbox.length },
          'Things: cleared ingested items from inbox queue',
        );
      }
    }

    // 8. Update sync state
    writeJsonFile(syncStatePath, {
      lastSyncUuids: items.map((i) => i.uuid),
      lastSyncTime: new Date().toISOString(),
    });
  } finally {
    db.close();
  }
}

export function startThingsSync(
  exocortexPath: string,
  thingsDbPath: string,
  thingsAuthToken: string,
  intervalMs: number,
): void {
  logger.info({ intervalMs, exocortexPath }, 'Starting Things sync loop');

  // Run immediately, then on interval
  const run = () => {
    syncThingsToExocortex(exocortexPath, thingsDbPath, thingsAuthToken).catch(
      (err) => {
        logger.error({ err }, 'Things sync error');
      },
    );
  };

  run();
  setInterval(run, intervalMs);
}
