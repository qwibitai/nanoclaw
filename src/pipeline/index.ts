/**
 * Pipeline barrel export — convenient single import point.
 */
export { InboundPipeline } from './inbound-pipeline.js';
export { OutboundPipeline } from './outbound-pipeline.js';
export type { InboundMessage, OutboundMessage, StageVerdict, OutboundVerdict } from './types.js';

// Stages
export { DedupStage } from './stages/dedup.js';
export { InboundRateLimiter, OutboundRateLimiter } from './stages/rate-limiter.js';
export { SenderFilter } from './stages/sender-filter.js';
export { RelevanceGate } from './stages/relevance-gate.js';
export { ErrorSuppressor } from './stages/error-suppressor.js';
export { OutboundDedup } from './stages/outbound-dedup.js';
export { isWebhookRateLimited } from './stages/webhook-guard.js';
export { ReplyLoopDetector } from './stages/reply-loop-detector.js';
export { EscalationDetector } from './stages/escalation-detector.js';
