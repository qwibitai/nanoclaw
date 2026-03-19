/**
 * Atlas Governance Module — main entry point.
 * Exports all governance functions for use in the agent-runner.
 */

export { runPreflightChecks } from './canary.js';
export { getAllowedToolsForTier, getDefaultTools, isAutonomousTier } from './tier-gate.js';
export { createAuditInterceptor } from './interceptor.js';
export { logAuditEvent, logGovernanceEvent, createToolCallEvent, countTodayEvents } from './audit.js';
export { logPostTaskAnalysis } from './learning.js';
export { getQuotaStatus, shouldRunTask, logInvocation, getQuotaAlert, recordRateLimit } from './quota.js';
export { checkResponseQuality, buildCorrectionPrompt, logInterceptionResult } from './response-interceptor.js';
export type { QualityCheckResult } from './response-interceptor.js';
export type { GovernanceContainerInput, PreflightResult, PostTaskParams, QuotaStatus, QuotaEntry, AuditEvent } from './types.js';
