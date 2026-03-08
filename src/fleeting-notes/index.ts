/**
 * Fleeting Notes Pipeline Orchestrator
 *
 * Host-side process that runs the full fleeting notes pipeline:
 * 1. Ingest: Things Today → fleeting note files in vault
 * 2. Daily note: Collect unprocessed notes, build daily note section
 * 3. Route: Parse user decisions, create destination files (future)
 * 4. Integrity: Post-processing validation checks
 *
 * Runs on a configurable interval (default: same as Things sync).
 * Can also be triggered manually via Telegram command.
 */

import { logger } from '../logger.js';
import {
  buildDailyNoteSection,
  collectUnprocessedNotes,
  updateDailyNote,
} from './daily-note.js';
import { ingestThingsToday } from './ingest.js';
import { runIntegrityChecks } from './integrity.js';
import { loadRegistry } from './registry.js';
import type { IngestResult, IntegrityReport } from './types.js';

export interface PipelineResult {
  ingest: IngestResult;
  unprocessedCount: number;
  dailyNoteUpdated: boolean;
  integrity: IntegrityReport;
}

/**
 * Run the full fleeting notes pipeline once.
 *
 * @param vaultPath - Absolute path to the Obsidian vault
 * @param thingsDbPath - Path to the Things 3 SQLite database
 * @param thingsAuthToken - Things URL scheme auth token
 * @param options - Optional configuration
 */
export async function runPipeline(
  vaultPath: string,
  thingsDbPath: string,
  thingsAuthToken: string,
  options: {
    /** Skip Things ingestion (useful when only updating daily note). */
    skipIngest?: boolean;
    /** Run integrity checks after pipeline. */
    runIntegrity?: boolean;
    /** Directories to check for date prefixes. */
    integrityDirs?: string[];
  } = {},
): Promise<PipelineResult> {
  // Stage 1: Ingest Things Today items
  let ingestResult: IngestResult = { created: [], skipped: [], errors: [] };
  if (!options.skipIngest) {
    ingestResult = await ingestThingsToday(
      vaultPath,
      thingsDbPath,
      thingsAuthToken,
    );
    if (ingestResult.created.length > 0) {
      logger.info(
        {
          created: ingestResult.created.length,
          skipped: ingestResult.skipped.length,
        },
        'Fleeting notes ingested from Things Today',
      );
    }
  }

  // Stage 2: Build daily note section
  const registry = loadRegistry(vaultPath);
  const unprocessed = collectUnprocessedNotes(vaultPath);
  const section = buildDailyNoteSection(unprocessed, registry);
  const dailyNoteUpdated = updateDailyNote(vaultPath, section);

  if (dailyNoteUpdated) {
    logger.info(
      { unprocessed: unprocessed.length },
      'Daily note updated with fleeting notes section',
    );
  }

  // Stage 4: Integrity checks (optional)
  let integrityReport: IntegrityReport = {
    issues: [],
    checked: 0,
    passed: true,
  };
  if (options.runIntegrity) {
    integrityReport = runIntegrityChecks(vaultPath, {
      noteDirs: options.integrityDirs,
      checkRaw: false, // Don't flag raw notes during normal pipeline — they're expected
    });
    if (!integrityReport.passed) {
      logger.warn(
        { issueCount: integrityReport.issues.length },
        'Integrity issues found',
      );
    }
  }

  return {
    ingest: ingestResult,
    unprocessedCount: unprocessed.length,
    dailyNoteUpdated,
    integrity: integrityReport,
  };
}

let pipelineRunning = false;

/**
 * Start the fleeting notes pipeline loop.
 * Runs on the same interval as Things sync.
 */
export function startFleetingNotesPipeline(
  vaultPath: string,
  thingsDbPath: string,
  thingsAuthToken: string,
  intervalMs: number,
): void {
  if (pipelineRunning) {
    logger.debug('Fleeting notes pipeline already running');
    return;
  }
  pipelineRunning = true;
  logger.info({ intervalMs, vaultPath }, 'Starting fleeting notes pipeline');

  const run = () => {
    runPipeline(vaultPath, thingsDbPath, thingsAuthToken).catch((err) => {
      logger.error({ err }, 'Fleeting notes pipeline error');
    });
  };

  run();
  setInterval(run, intervalMs);
}

/** @internal - for tests only. */
export function _resetPipelineForTests(): void {
  pipelineRunning = false;
}
