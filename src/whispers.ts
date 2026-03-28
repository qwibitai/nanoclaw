import { getDb } from './db.js';
import { logger } from './logger.js';

export interface Whisper {
  id: number;
  source_group_folder: string;
  signal: string;
  strength: number;
  emitted_at: string;
  expires_at: string;
  decay_rate: number;
}

let whisperDecayLoopRunning = false;

export function emitWhisper(
  sourceGroupFolder: string,
  signal: string,
  options?: { ttlHours?: number; decayRate?: number; initialStrength?: number },
): void {
  const ttlHours = options?.ttlHours ?? 72;
  const decayRate = options?.decayRate ?? 0.1;
  const initialStrength = options?.initialStrength ?? 1.0;

  const now = new Date();
  const emittedAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + ttlHours * 3600 * 1000).toISOString();

  getDb()
    .prepare(
      `INSERT INTO whispers (source_group_folder, signal, strength, emitted_at, expires_at, decay_rate)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(sourceGroupFolder, signal, initialStrength, emittedAt, expiresAt, decayRate);

  logger.debug({ sourceGroupFolder, signal, ttlHours, decayRate, initialStrength }, 'Whisper emitted');
}

export function decayWhispers(now?: Date): void {
  const db = getDb();
  const nowDate = now ?? new Date();
  const nowIso = nowDate.toISOString();

  // Update strength: reduce by decay_rate * hoursElapsed since emission
  db.prepare(
    `UPDATE whispers
     SET strength = MAX(0, strength - (decay_rate * ((unixepoch(?) - unixepoch(emitted_at)) / 3600.0)))
     WHERE expires_at > ?`,
  ).run(nowIso, nowIso);

  // Delete exhausted or expired whispers
  db.prepare(
    `DELETE FROM whispers WHERE strength <= 0 OR expires_at <= ?`,
  ).run(nowIso);

  logger.debug({ now: nowIso }, 'Whispers decayed');
}

export function getActiveWhispers(options?: { minStrength?: number; limit?: number }): Whisper[] {
  const db = getDb();
  const minStrength = options?.minStrength ?? 0;
  const nowIso = new Date().toISOString();

  let sql = `SELECT * FROM whispers WHERE strength > ? AND expires_at > ? ORDER BY strength DESC`;
  const params: unknown[] = [minStrength, nowIso];

  if (options?.limit !== undefined) {
    sql += ' LIMIT ?';
    params.push(options.limit);
  }

  return db.prepare(sql).all(...params) as Whisper[];
}

export function buildWhisperContextPrefix(whispers: Whisper[], maxChars?: number): string {
  if (whispers.length === 0) return '';

  const lines = whispers
    .map((w) => `${w.signal} (strength: ${w.strength.toFixed(2)})`)
    .join('\n');

  let result = `<whispers>\n${lines}\n</whispers>`;

  if (maxChars !== undefined && result.length > maxChars) {
    result = result.slice(0, maxChars);
  }

  return result;
}

export function injectWhisperContext(groupFolder: string, existingPrompt: string): string {
  const whispers = getActiveWhispers({ minStrength: 0.1, limit: 10 });

  if (whispers.length === 0) {
    return existingPrompt;
  }

  const prefix = buildWhisperContextPrefix(whispers);
  return `${prefix}\n\n${existingPrompt}`;
}

export function startWhisperDecayLoop(options?: { pollIntervalMs?: number }): void {
  if (whisperDecayLoopRunning) {
    logger.debug('Whisper decay loop already running, skipping');
    return;
  }

  whisperDecayLoopRunning = true;
  const pollIntervalMs = options?.pollIntervalMs ?? 3600000;

  logger.info({ pollIntervalMs }, 'Starting whisper decay loop');

  const tick = () => {
    if (!whisperDecayLoopRunning) return;

    try {
      decayWhispers();
    } catch (err) {
      logger.error({ err }, 'Error in whisper decay tick');
    }

    if (whisperDecayLoopRunning) {
      setTimeout(tick, pollIntervalMs);
    }
  };

  setTimeout(tick, pollIntervalMs);
}

export function _resetWhisperDecayLoopForTests(): void {
  whisperDecayLoopRunning = false;
}
