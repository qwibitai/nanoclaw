/**
 * Policy version — tracks the governance policy in effect.
 * Stored in gov_tasks.metadata and ext_calls.policy_version for auditability.
 * Bump on any policy change (transitions, gates, scoping rules).
 */
export const POLICY_VERSION = '1.0.0';
