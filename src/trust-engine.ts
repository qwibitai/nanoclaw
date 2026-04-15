/**
 * Trust Engine Core
 *
 * Classifies actions into domain×operation classes, evaluates confidence
 * against thresholds, and determines whether actions need user approval
 * or can execute autonomously.
 *
 * Formula: confidence = approvals / (approvals + denials + 1)
 * Decay: -0.01 per day without activity (floor 0.0)
 */

import { getTrustLevel, upsertTrustLevel, insertTrustAction } from './db.js';
import { eventBus } from './event-bus.js';
import type { TrustGraduatedEvent } from './events.js';

// --- Action taxonomy ---

export type TrustDomain =
  | 'info'
  | 'comms'
  | 'health'
  | 'finance'
  | 'code'
  | 'services';
export type TrustOperation = 'read' | 'write' | 'transact';
export type ActionClass = `${TrustDomain}.${TrustOperation}`;

/** Default thresholds by operation type */
const DEFAULT_THRESHOLDS: Record<TrustOperation, number> = {
  read: 0.7,
  write: 0.8,
  transact: 0.95,
};

/** Static mapping: known tool names → action class */
const TOOL_CLASS_MAP: Record<string, ActionClass> = {
  // Info domain — reads
  web_search: 'info.read',
  web_fetch: 'info.read',
  search_contacts: 'info.read',
  read_file: 'info.read',
  list_files: 'info.read',
  // Comms domain
  send_message: 'comms.write',
  send_email: 'comms.transact',
  reply_email: 'comms.write',
  draft_email: 'comms.write',
  // Health domain
  request_refill: 'health.transact',
  book_appointment: 'health.transact',
  cancel_appointment: 'health.transact',
  check_symptoms: 'health.read',
  // Finance domain
  check_balance: 'finance.read',
  transfer_funds: 'finance.transact',
  pay_bill: 'finance.transact',
  // Code domain
  bash: 'code.write',
  write_file: 'code.write',
  edit_file: 'code.write',
  delete_file: 'code.transact',
  run_tests: 'code.write',
  // Services domain
  schedule_task: 'services.write',
  cancel_task: 'services.write',
  pause_task: 'services.write',
  resume_task: 'services.write',
  create_calendar_event: 'services.write',
  delete_calendar_event: 'services.transact',
  // Browser domain — reads (session-level trust)
  browser_navigate: 'info.read',
  browser_snapshot: 'info.read',
  browser_take_screenshot: 'info.read',
  browser_tab_list: 'info.read',
  browser_tab_new: 'info.read',
  browser_tab_select: 'info.read',
  browser_pdf_save: 'info.read',
  browser_extract: 'info.read',
  browser_observe: 'info.read',
  // Browser domain — writes (per-action trust)
  browser_click: 'services.write',
  browser_type: 'services.write',
  browser_select_option: 'services.write',
  browser_file_upload: 'services.write',
  browser_press_key: 'services.write',
  browser_act: 'services.write',
  // Delegation — "Handle It" actions from email intelligence
  handle_email_reply: 'comms.write',
  handle_email_send: 'comms.transact',
  handle_email_forward: 'comms.write',
  handle_calendar_accept: 'services.write',
  handle_calendar_decline: 'services.write',
  handle_calendar_reschedule: 'services.write',
  handle_archive: 'comms.read',
  handle_label: 'comms.write',
  handle_snooze: 'services.write',
  handle_dismiss: 'comms.read',
};

/** Parse an ActionClass string into domain and operation. */
export function parseActionClass(actionClass: ActionClass | string): {
  domain: TrustDomain;
  operation: TrustOperation;
} {
  const [domain, operation] = actionClass.split('.') as [
    TrustDomain,
    TrustOperation,
  ];
  return { domain, operation };
}

/** Classify a tool call. Fallback to highest risk (transact) for unknowns. */
export function classifyTool(
  toolName: string,
  selfReportedClass?: string,
): ActionClass {
  const normalized = toolName.toLowerCase().replace(/[^a-z0-9_]/g, '_');
  if (TOOL_CLASS_MAP[normalized]) return TOOL_CLASS_MAP[normalized];

  // Try self-reported class from container agent
  if (selfReportedClass && isValidActionClass(selfReportedClass)) {
    return selfReportedClass as ActionClass;
  }

  // Default: highest risk
  return 'services.transact';
}

function isValidActionClass(s: string): boolean {
  const parts = s.split('.');
  if (parts.length !== 2) return false;
  const domains: string[] = [
    'info',
    'comms',
    'health',
    'finance',
    'code',
    'services',
  ];
  const ops: string[] = ['read', 'write', 'transact'];
  return domains.includes(parts[0]) && ops.includes(parts[1]);
}

/** Calculate confidence with time decay. */
export function calculateConfidence(
  approvals: number,
  denials: number,
  lastUpdated: string,
): number {
  const rawConfidence = approvals / (approvals + denials + 1);

  // Apply time decay: -0.01 per day since last activity
  const daysSinceActivity =
    (Date.now() - new Date(lastUpdated).getTime()) / (1000 * 60 * 60 * 24);
  const decayed = rawConfidence - 0.01 * daysSinceActivity;

  return Math.max(0.0, decayed);
}

export interface TrustDecision {
  decision: 'approved' | 'needs_approval';
  reason: string;
  confidence: number;
  threshold: number;
}

/**
 * Evaluate whether an action can auto-execute or needs user approval.
 * Updates the trust level record with decayed confidence.
 */
export function evaluateTrust(
  toolName: string,
  groupId: string,
  selfReportedClass?: string,
): TrustDecision {
  const actionClass = classifyTool(toolName, selfReportedClass);
  const { operation } = parseActionClass(actionClass);

  const stored = getTrustLevel(actionClass, groupId);
  const defaultThreshold = DEFAULT_THRESHOLDS[operation];

  if (!stored) {
    // Cold start: no trust data
    return {
      decision: 'needs_approval',
      reason: 'cold start — no trust data for this action class',
      confidence: 0,
      threshold: defaultThreshold,
    };
  }

  // auto_execute = false means permanently gated
  if (!stored.auto_execute) {
    return {
      decision: 'needs_approval',
      reason: 'manually configured to always require approval',
      confidence: stored.confidence,
      threshold: stored.threshold,
    };
  }

  // Apply time decay
  const confidence = calculateConfidence(
    stored.approvals,
    stored.denials,
    stored.last_updated,
  );

  // Persist decayed confidence back
  if (Math.abs(confidence - stored.confidence) > 0.001) {
    upsertTrustLevel({
      ...stored,
      confidence,
      last_updated: new Date().toISOString(),
    });
  }

  if (confidence >= stored.threshold) {
    return {
      decision: 'approved',
      reason: `confidence ${confidence.toFixed(2)} >= threshold ${stored.threshold}`,
      confidence,
      threshold: stored.threshold,
    };
  }

  return {
    decision: 'needs_approval',
    reason: `confidence ${confidence.toFixed(2)} < threshold ${stored.threshold}`,
    confidence,
    threshold: stored.threshold,
  };
}

/**
 * Record a trust decision (approval or denial) and update trust level.
 * Emits trust.graduated when confidence crosses the threshold for the first time.
 */
export function recordTrustDecision(
  toolName: string,
  groupId: string,
  decision: 'approved' | 'denied',
  description?: string,
  selfReportedClass?: string,
): void {
  const actionClass = classifyTool(toolName, selfReportedClass);
  const { domain, operation } = parseActionClass(actionClass);
  const now = new Date().toISOString();

  insertTrustAction({
    action_class: actionClass,
    domain,
    operation,
    description,
    decision,
    group_id: groupId,
    timestamp: now,
  });

  const stored = getTrustLevel(actionClass, groupId);
  const defaultThreshold = DEFAULT_THRESHOLDS[operation];

  const prevApprovals = stored?.approvals ?? 0;
  const prevDenials = stored?.denials ?? 0;
  const prevConfidence = stored?.confidence ?? 0;
  const threshold = stored?.threshold ?? defaultThreshold;
  const autoExecute = stored?.auto_execute ?? true;

  const newApprovals =
    decision === 'approved' ? prevApprovals + 1 : prevApprovals;
  const newDenials = decision === 'denied' ? prevDenials + 1 : prevDenials;

  const newConfidence = calculateConfidence(newApprovals, newDenials, now);

  const wasBelow = prevConfidence < threshold;
  const nowAbove = newConfidence >= threshold;

  upsertTrustLevel({
    action_class: actionClass,
    group_id: groupId,
    approvals: newApprovals,
    denials: newDenials,
    confidence: newConfidence,
    threshold,
    auto_execute: autoExecute,
    last_updated: now,
  });

  // Emit graduation event when threshold is first crossed
  if (wasBelow && nowAbove && autoExecute) {
    const graduatedEvent: TrustGraduatedEvent = {
      type: 'trust.graduated',
      source: 'trust-engine',
      groupId,
      timestamp: Date.now(),
      payload: {
        actionClass,
        confidence: newConfidence,
        threshold,
        groupId,
      },
    };
    eventBus.emit('trust.graduated', graduatedEvent);
  }
}
