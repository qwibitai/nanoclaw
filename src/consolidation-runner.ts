import { GroupQueue } from './group-queue.js';
import { RegisteredGroup } from './types.js';
import { logger } from './logger.js';

export const CONSOLIDATION_FOLDER = 'consolidation' as const;

export interface ConsolidationJobSpec {
  jobId: 'circadian' | 'emergence' | 'archaeology';
  prompt: string;
  targetGroups?: string[]; // group folders to include in context
  onComplete?: (result: string | null) => Promise<void>;
}

/**
 * Returns a synthetic RegisteredGroup for the consolidation internal group.
 * This group is NOT registered in the database — it is used only to provide
 * a consistent interface to task-scheduler.ts when running off-peak jobs.
 */
export function buildConsolidationGroup(): RegisteredGroup {
  return {
    name: 'Consolidation',
    folder: CONSOLIDATION_FOLDER,
    trigger: '',
    added_at: new Date().toISOString(),
    isMain: false,
  };
}

/**
 * Returns true if the given folder string refers to the consolidation
 * internal group folder.
 */
export function isConsolidationFolder(folder: string): boolean {
  return folder === CONSOLIDATION_FOLDER;
}
