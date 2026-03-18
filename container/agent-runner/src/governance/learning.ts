/**
 * Post-task analysis and graduation tracking.
 * Writes learning signals to ~/.atlas/autonomy/learning-log.jsonl
 * Updates graduation-status.json with run metrics.
 */

import fs from 'fs';
import path from 'path';
import { PostTaskParams } from './types.js';

const ATLAS_STATE_DIR = '/workspace/extra/atlas-state';
const AUTONOMY_DIR = path.join(ATLAS_STATE_DIR, 'autonomy');
const LEARNING_LOG = path.join(AUTONOMY_DIR, 'learning-log.jsonl');
const GRADUATION_STATUS = path.join(AUTONOMY_DIR, 'graduation-status.json');

interface LearningSignal {
  timestamp: string;
  signal_type: 'task_completion' | 'task_failure' | 'milestone_progress';
  severity: 'info' | 'warning' | 'critical';
  entity: string;
  tier: number;
  model: string;
  message: string;
  metadata: Record<string, unknown>;
}

interface GraduationStatus {
  milestones: Record<string, {
    status: string;
    progress: Record<string, unknown>;
    met_at?: string;
  }>;
  last_updated: string;
  [key: string]: unknown;
}

/**
 * Log a post-task analysis after a scheduled task or agent session completes.
 */
export function logPostTaskAnalysis(params: PostTaskParams): void {
  try {
    fs.mkdirSync(AUTONOMY_DIR, { recursive: true });

    const signal: LearningSignal = {
      timestamp: new Date().toISOString(),
      signal_type: params.success ? 'task_completion' : 'task_failure',
      severity: params.success ? 'info' : 'warning',
      entity: params.entity,
      tier: params.tier,
      model: params.model,
      message: params.success
        ? `Task ${params.taskId} completed in ${params.durationMs}ms (${params.toolCallCount} tool calls)`
        : `Task ${params.taskId} failed: ${params.errorMessage}`,
      metadata: {
        task_id: params.taskId,
        duration_ms: params.durationMs,
        tool_call_count: params.toolCallCount,
        error: params.errorMessage || null,
      },
    };

    fs.appendFileSync(LEARNING_LOG, JSON.stringify(signal) + '\n', { flag: 'a' });

    // Update graduation status
    updateGraduationMetrics(params);
  } catch (err) {
    console.error(`[governance/learning] Failed to log analysis: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Update graduation-status.json with metrics from this run.
 */
function updateGraduationMetrics(params: PostTaskParams): void {
  try {
    if (!fs.existsSync(GRADUATION_STATUS)) return;

    const status: GraduationStatus = JSON.parse(fs.readFileSync(GRADUATION_STATUS, 'utf-8'));

    // Update M2 progress: consecutive Tier 1 runs
    if (params.tier === 1 && status.milestones?.M2) {
      const m2 = status.milestones.M2;
      const progress = m2.progress as { consecutive_clean_runs?: number; target?: number };

      if (params.success) {
        progress.consecutive_clean_runs = (progress.consecutive_clean_runs || 0) + 1;
      } else {
        progress.consecutive_clean_runs = 0;  // Reset on failure
      }

      // Check if milestone newly met
      if (m2.status === 'pending' && (progress.consecutive_clean_runs || 0) >= (progress.target || 5)) {
        m2.status = 'complete';
        m2.met_at = new Date().toISOString();
      }
    }

    // Update M5 progress: total autonomous cycles
    if (status.milestones?.M5) {
      const m5 = status.milestones.M5;
      const progress = m5.progress as { total_cycles?: number; target?: number };
      if (params.success) {
        progress.total_cycles = (progress.total_cycles || 0) + 1;
      }
      if (m5.status === 'pending' && (progress.total_cycles || 0) >= (progress.target || 20)) {
        m5.status = 'complete';
        m5.met_at = new Date().toISOString();
      }
    }

    status.last_updated = new Date().toISOString();
    fs.writeFileSync(GRADUATION_STATUS, JSON.stringify(status, null, 2));
  } catch (err) {
    console.error(`[governance/learning] Failed to update graduation: ${err instanceof Error ? err.message : String(err)}`);
  }
}
