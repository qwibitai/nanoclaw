import fs from 'fs';
import path from 'path';

/**
 * Atomically write a JSON file (write .tmp then rename).
 * Prevents partial reads by the container agent.
 */
export function writeJsonAtomic(filePath: string, data: unknown): void {
  const tmpPath = filePath + '.tmp';
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2));
  fs.renameSync(tmpPath, filePath);
}

const DAYS_TO_KEEP = 7;

/**
 * Merge items into a daily archive file (YYYY-MM-DD.json) and prune files older
 * than 7 days.
 *
 * Each daily file is an array of items. New items are appended (deduped by `idFn`).
 * Also writes an `index.json` listing available date files for the agent to discover.
 *
 * @param dir       Directory for daily files (e.g. data/slack/days/)
 * @param items     New items to merge
 * @param dateFn    Extract a Date from an item (used to bucket into days)
 * @param idFn      Extract a unique ID from an item (used for deduplication)
 * @param timezone  IANA timezone for day boundaries (default: Europe/London)
 */
export function mergeDailyArchive<T>(
  dir: string,
  items: T[],
  dateFn: (item: T) => Date,
  idFn: (item: T) => string,
  timezone = 'Europe/London',
): void {
  fs.mkdirSync(dir, { recursive: true });

  // Bucket new items by date string
  const buckets = new Map<string, T[]>();
  for (const item of items) {
    const dateStr = dateFn(item).toLocaleDateString('en-CA', { timeZone: timezone });
    if (!buckets.has(dateStr)) buckets.set(dateStr, []);
    buckets.get(dateStr)!.push(item);
  }

  // Merge into each daily file
  for (const [dateStr, newItems] of buckets) {
    const filePath = path.join(dir, `${dateStr}.json`);
    let existing: T[] = [];
    try {
      if (fs.existsSync(filePath)) {
        existing = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      }
    } catch {
      // Corrupted file — start fresh
    }

    // Dedup: build set of existing IDs, only add new ones
    const existingIds = new Set(existing.map(idFn));
    const merged = [...existing];
    for (const item of newItems) {
      if (!existingIds.has(idFn(item))) {
        merged.push(item);
      }
    }

    writeJsonAtomic(filePath, merged);
  }

  // Prune files older than DAYS_TO_KEEP
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - DAYS_TO_KEEP);
  const cutoffStr = cutoff.toLocaleDateString('en-CA', { timeZone: timezone });

  const files = fs.readdirSync(dir).filter(f => f.endsWith('.json') && f !== 'index.json');
  for (const file of files) {
    const dateStr = file.replace('.json', '');
    if (dateStr < cutoffStr) {
      fs.unlinkSync(path.join(dir, file));
    }
  }

  // Write index.json listing available dates (sorted newest first)
  const remaining = fs.readdirSync(dir)
    .filter(f => f.endsWith('.json') && f !== 'index.json')
    .map(f => f.replace('.json', ''))
    .sort()
    .reverse();

  writeJsonAtomic(path.join(dir, 'index.json'), {
    dates: remaining,
    updated_at: new Date().toISOString(),
  });
}
