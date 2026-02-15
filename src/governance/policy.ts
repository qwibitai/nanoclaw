// Ported from Mission Control — deterministic state machine validation
// Pure TypeScript, zero NanoClaw dependencies

import type { GateType, TaskState } from './constants.js';

// --- Valid transitions graph (includes APPROVAL state per P0-3) ---

const VALID_TRANSITIONS: Record<TaskState, TaskState[]> = {
  INBOX: ['TRIAGED', 'BLOCKED'],
  TRIAGED: ['READY', 'BLOCKED'],
  READY: ['DOING', 'BLOCKED'],
  DOING: ['REVIEW', 'BLOCKED'],
  REVIEW: ['APPROVAL', 'DOING', 'BLOCKED'], // DOING = rework
  APPROVAL: ['DONE', 'REVIEW', 'BLOCKED'], // REVIEW = changes requested
  DONE: [], // terminal
  BLOCKED: ['INBOX', 'TRIAGED', 'READY', 'DOING'],
};

// --- Types for full (strict) validation ---

export type DodItem = { label: string; done: boolean };

export type Approval = {
  gate: GateType;
  approvedBy: string;
  timestampUtc: number;
  evidenceLink?: string;
  notes?: string;
};

export type TaskLike = {
  type: string;
  board?: string;
  product?: string;
  domain?: string;
  priority: string;
  owner: string;
  gate: GateType;
  evidenceRequired: boolean;
  auditLink?: string;
  docsUpdated?: boolean;
  dodChecklist: DodItem[];
  approvals: Approval[];
  override?: {
    used: boolean;
    by: string;
    reason: string;
    acceptedRisk: string;
    reviewDeadlineIso: string;
  };
};

export type TransitionResult = { ok: true } | { ok: false; errors: string[] };

/**
 * Validate a state transition.
 *
 * strict=true: full Mission Control validation (DoD, docs, gates, evidence).
 * strict=false (default for kernel v0): only validates the transition graph.
 *
 * IMPORTANT: strict is host-side config only — never controlled by agents.
 */
export function validateTransition(
  from: TaskState,
  to: TaskState,
  task?: TaskLike,
  strict = false,
): TransitionResult {
  const errors: string[] = [];

  // 1. Graph validation (always enforced)
  const allowed = VALID_TRANSITIONS[from];
  if (!allowed) {
    return { ok: false, errors: [`UNKNOWN_STATE: ${from}`] };
  }
  if (!allowed.includes(to)) {
    return { ok: false, errors: [`INVALID_TRANSITION: ${from} -> ${to}`] };
  }

  // 2. Strict validation (full Mission Control rules)
  if (strict && task) {
    // Base mandatory fields
    for (const [k, v] of Object.entries({
      priority: task.priority,
      owner: task.owner,
    })) {
      if (!v || (typeof v === 'string' && v.trim().length === 0)) {
        errors.push(`MISSING_${k.toUpperCase()}`);
      }
    }

    // Enter DOING: DoD checklist present + evidenceRequired explicit
    if (to === 'DOING') {
      if (!Array.isArray(task.dodChecklist) || task.dodChecklist.length === 0) {
        errors.push('MISSING_DOD_CHECKLIST');
      }
      if (typeof task.evidenceRequired !== 'boolean') {
        errors.push('MISSING_EVIDENCE_REQUIRED');
      }
    }

    // Leave REVIEW or enter DONE: evidence link(s) required if evidenceRequired
    if ((from === 'REVIEW' && to !== 'REVIEW') || to === 'DONE') {
      if (task.evidenceRequired) {
        const hasAnyLink =
          !!task.auditLink ||
          (task.approvals ?? []).some((a) => !!a.evidenceLink);
        if (!hasAnyLink) errors.push('MISSING_EVIDENCE_LINK');
      }
    }

    // DONE requires: DoD all done + docsUpdated for key types + gate approval
    if (to === 'DONE') {
      if (task.dodChecklist?.some((i) => !i.done)) {
        errors.push('DOD_INCOMPLETE');
      }

      const needsDocs = ['SECURITY', 'REVOPS', 'INCIDENT', 'FEATURE'].includes(
        task.type,
      );
      if (needsDocs && task.docsUpdated !== true) {
        errors.push('DOCS_NOT_UPDATED');
      }

      if (task.gate !== 'None') {
        const approved = (task.approvals ?? []).some(
          (a) => a.gate === task.gate,
        );
        const overridden = task.override?.used === true;
        if (!approved && !overridden) errors.push('GATE_NOT_APPROVED');
      }

      // Override must be explicit if used
      if (task.override?.used) {
        if (!task.override.by) errors.push('OVERRIDE_MISSING_BY');
        if (!task.override.reason) errors.push('OVERRIDE_MISSING_REASON');
        if (!task.override.acceptedRisk)
          errors.push('OVERRIDE_MISSING_ACCEPTED_RISK');
        if (!task.override.reviewDeadlineIso)
          errors.push('OVERRIDE_MISSING_REVIEW_DEADLINE');
      }
    }
  }

  return errors.length ? { ok: false, errors } : { ok: true };
}
