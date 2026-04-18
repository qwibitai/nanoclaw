// src/events.ts

/**
 * NanoClaw Event System — Type Definitions
 *
 * All inter-layer communication flows through typed events.
 * Each layer emits and subscribes to events via the EventBus.
 *
 * Event naming: {layer}.{entity}.{action}
 *   layer: message, task, trust, verify, learn, system
 *   entity: what's being acted on
 *   action: what happened
 */

// --- Base event structure ---

export interface NanoClawEvent {
  type: string;
  source: string;
  groupId?: string;
  timestamp: number;
  payload: Record<string, unknown>;
}

// --- Message events ---

export interface MessageInboundEvent extends NanoClawEvent {
  type: 'message.inbound';
  source: 'channel';
  payload: {
    chatJid: string;
    channel: string;
    messageCount: number;
  };
}

export interface MessageOutboundEvent extends NanoClawEvent {
  type: 'message.outbound';
  source: 'router';
  payload: {
    chatJid: string;
    channel: string;
    text: string;
  };
}

// --- Task/Executor events ---

export interface TaskQueuedEvent extends NanoClawEvent {
  type: 'task.queued';
  source: 'executor';
  payload: {
    taskId: string;
    groupJid: string;
    priority: 'interactive' | 'scheduled' | 'proactive';
    queuePosition: number;
  };
}

export interface TaskStartedEvent extends NanoClawEvent {
  type: 'task.started';
  source: 'executor';
  payload: {
    taskId: string;
    groupJid: string;
    containerName: string;
    slotIndex: number;
  };
}

export interface TaskCompleteEvent extends NanoClawEvent {
  type: 'task.complete';
  source: 'executor';
  payload: {
    taskId: string;
    groupJid: string;
    status: 'success' | 'error';
    durationMs: number;
    costUsd?: number;
  };
}

export interface TaskProgressEvent extends NanoClawEvent {
  type: 'task.progress';
  source: 'executor';
  payload: {
    taskId: string;
    groupJid: string;
    label: string;
  };
}

// --- Warm pool events ---

export interface PoolWarmCreatedEvent extends NanoClawEvent {
  type: 'pool.warm.created';
  source: 'executor';
  payload: {
    containerId: string;
    poolSize: number;
  };
}

export interface PoolWarmUsedEvent extends NanoClawEvent {
  type: 'pool.warm.used';
  source: 'executor';
  payload: {
    containerId: string;
    groupJid: string;
    taskId: string;
  };
}

export interface PoolWarmEvictedEvent extends NanoClawEvent {
  type: 'pool.warm.evicted';
  source: 'executor';
  payload: {
    containerId: string;
    reason: 'idle_timeout' | 'crash' | 'shutdown';
  };
}

// --- Trust events ---

export interface TrustRequestEvent extends NanoClawEvent {
  type: 'trust.request';
  source: 'trust-gateway';
  payload: {
    approvalId: string;
    actionClass: string;
    toolName: string;
    description: string;
    groupId: string;
    chatJid: string;
    confidence: number;
    threshold: number;
  };
}

export interface TrustApprovedEvent extends NanoClawEvent {
  type: 'trust.approved';
  source: 'trust-gateway';
  payload: {
    approvalId: string;
    actionClass: string;
    toolName: string;
    groupId: string;
    auto: boolean; // true = auto-approved by confidence, false = user approved
  };
}

export interface TrustDeniedEvent extends NanoClawEvent {
  type: 'trust.denied';
  source: 'trust-gateway';
  payload: {
    approvalId: string;
    actionClass: string;
    toolName: string;
    groupId: string;
    reason: 'user_denied' | 'timeout';
  };
}

export interface TrustGraduatedEvent extends NanoClawEvent {
  type: 'trust.graduated';
  source: 'trust-engine';
  payload: {
    actionClass: string;
    confidence: number;
    threshold: number;
    groupId: string;
  };
}

export interface TrustUnknownToolEvent extends NanoClawEvent {
  type: 'trust.unknown_tool';
  source: 'trust-engine';
  payload: {
    toolName: string;
  };
}

// --- Verification events ---

export interface VerifyCheckEvent extends NanoClawEvent {
  type: 'verify.check';
  source: 'router';
  payload: {
    taskId: string;
    groupId: string;
    claimsFound: number;
  };
}

export interface VerifyPassedEvent extends NanoClawEvent {
  type: 'verify.passed';
  source: 'router';
  payload: {
    taskId: string;
    groupId: string;
    confidenceMarkers: number;
  };
}

export interface VerifyFailedEvent extends NanoClawEvent {
  type: 'verify.failed';
  source: 'trust-gateway';
  payload: {
    taskId: string;
    groupId: string;
    toolName: string;
    reason: string;
  };
}

// --- System events ---

export interface SystemErrorEvent extends NanoClawEvent {
  type: 'system.error';
  source: string;
  payload: {
    error: string;
    handler: string;
    originalEvent: string;
  };
}

export interface SystemStartupEvent extends NanoClawEvent {
  type: 'system.startup';
  source: 'orchestrator';
  payload: {
    channels: string[];
    groupCount: number;
  };
}

export interface SystemShutdownEvent extends NanoClawEvent {
  type: 'system.shutdown';
  source: 'orchestrator';
  payload: {
    reason: string;
  };
}

// --- Proactive Monitor events ---

export interface EmailReceivedEvent extends NanoClawEvent {
  type: 'email.received';
  source: 'email-sse';
  payload: {
    count: number;
    emails: Array<{
      thread_id: string;
      account: string;
      subject: string;
      sender: string;
    }>;
    connection: string;
  };
}

export interface WebhookReceivedEvent extends NanoClawEvent {
  type: 'webhook.received';
  source: 'webhook';
  payload: {
    webhookSource: string;
    data: Record<string, unknown>;
  };
}

// --- Browser events ---

export interface BrowserContextCreatedEvent extends NanoClawEvent {
  type: 'browser.context.created';
  source: 'browser';
  payload: {
    groupId: string;
    contextId: string;
  };
}

export interface BrowserContextClosedEvent extends NanoClawEvent {
  type: 'browser.context.closed';
  source: 'browser';
  payload: {
    groupId: string;
    contextId: string;
    profileSaved: boolean;
  };
}

export interface BrowserSidecarDownEvent extends NanoClawEvent {
  type: 'browser.sidecar.down';
  source: 'browser';
  payload: {
    error: string;
    activeContexts: number;
  };
}

export interface BrowserProfileCorruptEvent extends NanoClawEvent {
  type: 'browser.profile.corrupt';
  source: 'browser';
  payload: {
    groupId: string;
    error: string;
  };
}

export interface BrowserVisualChangedEvent extends NanoClawEvent {
  type: 'browser.visual.changed';
  source: 'browser';
  payload: {
    groupId: string;
    label: string;
    diffPercentage: number;
    threshold: number;
  };
}

// --- Item lifecycle events ---

export interface ItemClassifiedEvent extends NanoClawEvent {
  type: 'item.classified';
  source: 'classification' | 'sse-classifier';
  payload: {
    itemId: string;
    decision: 'push' | 'digest' | 'resolved';
    source: string;
    reason: Record<string, unknown>;
  };
}

export interface ItemPushedEvent extends NanoClawEvent {
  type: 'item.pushed';
  source: 'push-manager';
  payload: {
    itemId: string;
    telegramMessageId: number;
  };
}

export interface ItemResolvedEvent extends NanoClawEvent {
  type: 'item.resolved';
  source: 'resolution-detector';
  payload: {
    itemId: string;
    method: string;
  };
}

export interface ItemStaleEvent extends NanoClawEvent {
  type: 'item.stale';
  source: 'digest-engine';
  payload: {
    itemId: string;
    digestCycles: number;
  };
}

export interface DigestSentEvent extends NanoClawEvent {
  type: 'digest.sent';
  source: 'digest-engine';
  payload: {
    groupName: string;
    itemCount: number;
    digestType: 'smart' | 'morning' | 'ondemand';
  };
}

// --- Learn events ---

export interface LearnRuleCreatedEvent extends NanoClawEvent {
  type: 'learn.rule_created';
  source: 'learning';
  payload: {
    ruleId: string;
    rule: string;
    source: 'outcome_pattern' | 'user_feedback' | 'agent_reported';
    groupId: string | null;
  };
}

export interface LearnRuleAppliedEvent extends NanoClawEvent {
  type: 'learn.rule_applied';
  source: 'learning';
  payload: {
    ruleId: string;
    groupId: string;
    taskId: string;
  };
}

export interface LearnProcedureSavedEvent extends NanoClawEvent {
  type: 'learn.procedure_saved';
  source: 'learning';
  payload: {
    name: string;
    trigger: string;
    groupId: string;
    stepCount: number;
  };
}

export interface LearnProcedureMatchedEvent extends NanoClawEvent {
  type: 'learn.procedure_matched';
  source: 'learning';
  payload: {
    name: string;
    trigger: string;
    groupId: string;
    autoExecute: boolean;
  };
}

export interface LearnProcedureExecutedEvent extends NanoClawEvent {
  type: 'learn.procedure_executed';
  source: 'learning';
  payload: {
    name: string;
    groupId: string;
    success: boolean;
    durationMs: number;
  };
}

export interface LearnProcedurePromotedEvent extends NanoClawEvent {
  type: 'learn.procedure_promoted';
  source: 'learning';
  payload: {
    name: string;
    fromGroups: string[];
    stepCount: number;
  };
}

export interface LearnFeedbackReceivedEvent extends NanoClawEvent {
  type: 'learn.feedback_received';
  source: 'learning';
  payload: {
    ruleId: string;
    feedback: string;
    groupId: string;
  };
}

// --- Calendar events ---

export interface CalendarSyncedEvent extends NanoClawEvent {
  type: 'calendar.synced';
  source: 'calendar-poller';
  payload: {
    eventsFound: number;
    lookaheadMs: number;
  };
}

export interface ThreadCorrelatedEvent extends NanoClawEvent {
  type: 'thread.correlated';
  source: 'thread-correlator';
  payload: {
    threadId: string;
    itemId: string;
    linkType: string;
    confidence: number;
  };
}

// --- Watcher events ---

export interface WatcherChangedEvent extends NanoClawEvent {
  type: 'watcher.changed';
  source: 'browser-watcher';
  payload: {
    watcherId: string;
    url: string;
    selector: string;
    previousValue: string | null;
    newValue: string | null;
    groupId: string;
  };
}

// --- Proactive scheduling events ---

export interface ProactiveSuggestionEvent extends NanoClawEvent {
  type: 'proactive.suggestion';
  source: 'scheduling-advisor';
  payload: {
    groupName: string;
    suggestion: string;
    pendingCount: number;
    nextGapAt: number | null;
    urgencyScore: number;
  };
}

// --- Plan events ---

export interface PlanProposedEvent extends NanoClawEvent {
  type: 'plan.proposed';
  source: 'agent';
  payload: {
    taskId: string;
    plan: string;
    urgency: 'normal' | 'urgent';
    domain: string;
  };
}

export interface PlanAutoApprovedEvent extends NanoClawEvent {
  type: 'plan.auto_approved';
  source: 'auto-approval';
  payload: {
    taskId: string;
  };
}

export interface PlanCancelledEvent extends NanoClawEvent {
  type: 'plan.cancelled';
  source: 'auto-approval';
  payload: {
    taskId: string;
  };
}

// --- Draft events ---

export interface EmailDraftCreatedEvent extends NanoClawEvent {
  type: 'email.draft.created';
  source: 'draft-watcher';
  payload: {
    draftId: string;
    threadId: string;
    account: string;
  };
}

export interface EmailDraftEnrichedEvent extends NanoClawEvent {
  type: 'email.draft.enriched';
  source: 'draft-enrichment';
  payload: {
    draftId: string;
    changes: string;
  };
}

// --- Email action events ---

export interface EmailActionCompletedEvent extends NanoClawEvent {
  type: 'email.action.completed';
  source: 'archive-tracker';
  payload: {
    emailId: string;
    threadId: string;
    account: string;
    action: string;
  };
}

export interface EmailDraftSendFailedEvent extends NanoClawEvent {
  type: 'email.draft.send_failed';
  source: string;
  payload: {
    draftId: string;
    account: string;
    subject?: string;
    threadId?: string;
    error: string;
  };
}

// --- Event type map (for type-safe subscriptions) ---

export interface EventMap {
  'message.inbound': MessageInboundEvent;
  'message.outbound': MessageOutboundEvent;
  'task.queued': TaskQueuedEvent;
  'task.started': TaskStartedEvent;
  'task.complete': TaskCompleteEvent;
  'task.progress': TaskProgressEvent;
  'pool.warm.created': PoolWarmCreatedEvent;
  'pool.warm.used': PoolWarmUsedEvent;
  'pool.warm.evicted': PoolWarmEvictedEvent;
  'trust.request': TrustRequestEvent;
  'trust.approved': TrustApprovedEvent;
  'trust.denied': TrustDeniedEvent;
  'trust.graduated': TrustGraduatedEvent;
  'trust.unknown_tool': TrustUnknownToolEvent;
  'verify.check': VerifyCheckEvent;
  'verify.passed': VerifyPassedEvent;
  'verify.failed': VerifyFailedEvent;
  'system.error': SystemErrorEvent;
  'system.startup': SystemStartupEvent;
  'system.shutdown': SystemShutdownEvent;
  'email.received': EmailReceivedEvent;
  'webhook.received': WebhookReceivedEvent;
  'browser.context.created': BrowserContextCreatedEvent;
  'browser.context.closed': BrowserContextClosedEvent;
  'browser.sidecar.down': BrowserSidecarDownEvent;
  'browser.profile.corrupt': BrowserProfileCorruptEvent;
  'browser.visual.changed': BrowserVisualChangedEvent;
  'learn.rule_created': LearnRuleCreatedEvent;
  'learn.rule_applied': LearnRuleAppliedEvent;
  'learn.procedure_saved': LearnProcedureSavedEvent;
  'learn.procedure_matched': LearnProcedureMatchedEvent;
  'learn.procedure_executed': LearnProcedureExecutedEvent;
  'learn.procedure_promoted': LearnProcedurePromotedEvent;
  'learn.feedback_received': LearnFeedbackReceivedEvent;
  'item.classified': ItemClassifiedEvent;
  'item.pushed': ItemPushedEvent;
  'item.resolved': ItemResolvedEvent;
  'item.stale': ItemStaleEvent;
  'digest.sent': DigestSentEvent;
  'calendar.synced': CalendarSyncedEvent;
  'thread.correlated': ThreadCorrelatedEvent;
  'proactive.suggestion': ProactiveSuggestionEvent;
  'watcher.changed': WatcherChangedEvent;
  'plan.proposed': PlanProposedEvent;
  'plan.auto_approved': PlanAutoApprovedEvent;
  'plan.cancelled': PlanCancelledEvent;
  'email.draft.created': EmailDraftCreatedEvent;
  'email.draft.enriched': EmailDraftEnrichedEvent;
  'email.action.completed': EmailActionCompletedEvent;
  'email.draft.send_failed': EmailDraftSendFailedEvent;
}

export type EventType = keyof EventMap;
