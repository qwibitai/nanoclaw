import { findProcedure, saveProcedure } from '../memory/procedure-store.js';
import type { Procedure, ProcedureStep } from '../memory/procedure-store.js';
import { logger } from '../logger.js';

export interface TracedAction {
  type: string;
  timestamp: number;
  inputSummary: string;
  result: 'success' | 'error';
}

export interface AgentProcedure {
  name: string;
  trigger: string;
  description: string;
  steps: Array<{ action: string; details?: string }>;
}

const traceBuffer = new Map<string, TracedAction[]>();

function traceKey(groupId: string, taskId: string): string {
  return `${groupId}::${taskId}`;
}

const MAX_TRACE_AGE_MS = 60 * 60 * 1000; // 1 hour
const MAX_TRACE_BUFFER_SIZE = 100;

export function startTrace(groupId: string, taskId: string): void {
  traceBuffer.set(traceKey(groupId, taskId), []);
  logger.debug({ groupId, taskId }, 'Trace started');
}

export function pruneOrphanedTraces(): number {
  const cutoff = Date.now() - MAX_TRACE_AGE_MS;
  let pruned = 0;

  for (const [key, actions] of traceBuffer.entries()) {
    if (actions.length === 0) {
      traceBuffer.delete(key);
      pruned++;
      continue;
    }
    // Check the LAST action timestamp, not the first
    const lastTimestamp = actions[actions.length - 1].timestamp;
    if (lastTimestamp < cutoff) {
      traceBuffer.delete(key);
      pruned++;
    }
  }

  // Enforce buffer size cap — evict oldest traces first
  if (traceBuffer.size > MAX_TRACE_BUFFER_SIZE) {
    const entries = [...traceBuffer.entries()].sort((a, b) => {
      const aTime = a[1].length > 0 ? a[1][a[1].length - 1].timestamp : 0;
      const bTime = b[1].length > 0 ? b[1][b[1].length - 1].timestamp : 0;
      return aTime - bTime;
    });
    const excess = traceBuffer.size - MAX_TRACE_BUFFER_SIZE;
    for (let i = 0; i < excess; i++) {
      traceBuffer.delete(entries[i][0]);
      pruned++;
    }
  }

  return pruned;
}

export function addTrace(
  groupId: string,
  taskId: string,
  action: TracedAction,
): void {
  const key = traceKey(groupId, taskId);
  const buf = traceBuffer.get(key);
  if (!buf) return;
  buf.push(action);
}

function stepsOverlap(
  existing: ProcedureStep[],
  candidate: ProcedureStep[],
): number {
  if (existing.length === 0 || candidate.length === 0) return 0;
  const existingActions = new Set(existing.map((s) => s.action));
  const matches = candidate.filter((s) => existingActions.has(s.action)).length;
  return matches / Math.max(existing.length, candidate.length);
}

export function finalizeTrace(
  groupId: string,
  taskId: string,
  success: boolean,
  agentProcedure?: AgentProcedure,
): void {
  const key = traceKey(groupId, taskId);
  const actions = traceBuffer.get(key) ?? [];
  traceBuffer.delete(key);

  if (!success) {
    logger.debug({ groupId, taskId }, 'Trace discarded (task failed)');
    return;
  }
  if (actions.length < 2) {
    logger.debug(
      { groupId, taskId, actionCount: actions.length },
      'Trace too short, skipping',
    );
    return;
  }

  const now = new Date().toISOString();
  let steps: ProcedureStep[];
  let name: string;
  let trigger: string;
  let description: string;

  if (agentProcedure) {
    const traceActionTypes = new Set(actions.map((a) => a.type));
    const validAgentSteps = agentProcedure.steps.filter((s) =>
      traceActionTypes.has(s.action),
    );
    const extraTraceSteps = actions
      .filter((a) => !agentProcedure.steps.some((s) => s.action === a.type))
      .map((a) => ({ action: a.type, details: a.inputSummary.slice(0, 100) }));
    steps = [...validAgentSteps, ...extraTraceSteps];
    name = agentProcedure.name;
    trigger = agentProcedure.trigger;
    description = agentProcedure.description;
  } else {
    steps = actions.map((a) => ({
      action: a.type,
      details: a.inputSummary.slice(0, 100),
    }));
    name = `procedure-${groupId}-${Date.now()}`;
    trigger = steps.map((s) => s.action).join(', ');
    description = `Auto-recorded procedure with ${steps.length} steps`;
  }

  const existing = findProcedure(trigger, groupId);
  if (existing) {
    const overlap = stepsOverlap(existing.steps, steps);
    if (overlap >= 0.7) {
      saveProcedure({
        ...existing,
        success_count: existing.success_count + 1,
        updated_at: now,
      });
      logger.debug(
        { name: existing.name, groupId },
        'Procedure success_count incremented',
      );
      return;
    }
    name = `${name}-v${Date.now()}`;
  }

  const proc: Procedure = {
    name,
    trigger,
    description,
    steps,
    success_count: 1,
    failure_count: 0,
    auto_execute: false,
    created_at: now,
    updated_at: now,
    groupId,
  };
  saveProcedure(proc);
  logger.info(
    { name, trigger, groupId, stepCount: steps.length },
    'Procedure saved',
  );
}
