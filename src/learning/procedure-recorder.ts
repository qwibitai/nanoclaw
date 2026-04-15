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

export function startTrace(groupId: string, taskId: string): void {
  traceBuffer.set(traceKey(groupId, taskId), []);
  logger.debug({ groupId, taskId }, 'Trace started');
}

export function addTrace(groupId: string, taskId: string, action: TracedAction): void {
  const key = traceKey(groupId, taskId);
  const buf = traceBuffer.get(key);
  if (!buf) return;
  buf.push(action);
}

function stepsOverlap(existing: ProcedureStep[], candidate: ProcedureStep[]): number {
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
    logger.debug({ groupId, taskId, actionCount: actions.length }, 'Trace too short, skipping');
    return;
  }

  const now = new Date().toISOString();
  let steps: ProcedureStep[];
  let name: string;
  let trigger: string;
  let description: string;

  if (agentProcedure) {
    const traceActionTypes = new Set(actions.map((a) => a.type));
    const validAgentSteps = agentProcedure.steps.filter((s) => traceActionTypes.has(s.action));
    const extraTraceSteps = actions
      .filter((a) => !agentProcedure.steps.some((s) => s.action === a.type))
      .map((a) => ({ action: a.type, details: a.inputSummary.slice(0, 100) }));
    steps = [...validAgentSteps, ...extraTraceSteps];
    name = agentProcedure.name;
    trigger = agentProcedure.trigger;
    description = agentProcedure.description;
  } else {
    steps = actions.map((a) => ({ action: a.type, details: a.inputSummary.slice(0, 100) }));
    name = `procedure-${groupId}-${Date.now()}`;
    trigger = steps.map((s) => s.action).join(', ');
    description = `Auto-recorded procedure with ${steps.length} steps`;
  }

  const existing = findProcedure(trigger, groupId);
  if (existing) {
    const overlap = stepsOverlap(existing.steps, steps);
    if (overlap >= 0.7) {
      saveProcedure({ ...existing, success_count: existing.success_count + 1, updated_at: now });
      logger.debug({ name: existing.name, groupId }, 'Procedure success_count incremented');
      return;
    }
    name = `${name}-v${Date.now()}`;
  }

  const proc: Procedure = {
    name, trigger, description, steps,
    success_count: 1, failure_count: 0, auto_execute: false,
    created_at: now, updated_at: now, groupId,
  };
  saveProcedure(proc);
  logger.info({ name, trigger, groupId, stepCount: steps.length }, 'Procedure saved');
}
