/**
 * case-auth.ts — AUTHORITATIVE SECURITY GATE for case creation.
 *
 * This is an authoritative policy file. All case type and authorization
 * decisions MUST go through this module. Rules:
 * - Do NOT duplicate authorization logic elsewhere
 * - Do NOT bypass this gate — all case creation paths call authorizeCaseCreation()
 * - Changes to this file require careful review
 *
 * See also: mount-security.ts (mount authorization), sender-allowlist.ts (sender policy)
 *
 * Policies enforced:
 * 1. Auto-detection: promotes work→dev when description looks like code work
 * 2. Authorization: determines if dev case goes active or needs approval
 *    - isMain source → authorized (active immediately)
 *    - non-main source → needs approval (suggested status)
 */
import { logger } from './logger.js';

// Heuristic patterns for detecting code-related work in case descriptions
const CODE_WORK_PATTERNS = [
  /\b(?:fix|bug|patch|hotfix)\b/i,
  /\b(?:implement|feature|refactor|rewrite)\b/i,
  /\b(?:add|update|remove|delete|rename)\s+(?:function|method|class|module|endpoint|route|hook|tool|handler|middleware|schema|migration|test|type|interface)\b/i,
  /\b(?:PR|pull request|branch|commit|merge|worktree)\b/i,
  /\b(?:config|dockerfile|package\.json|tsconfig|eslint)\b/i,
  /\b(?:\.ts|\.js|\.py|\.sh|\.md)\b/i,
  /\b(?:src\/|container\/|hooks\/|tests\/)\b/i,
  /\b(?:code change|code review|code fix)\b/i,
];

/**
 * Heuristic: does the description look like it involves code changes?
 */
export function looksLikeCodeWork(description: string): boolean {
  return CODE_WORK_PATTERNS.some((p) => p.test(description));
}

export type CaseAuthDecision = {
  /** Final case type after policy evaluation */
  caseType: 'dev' | 'work';
  /** Whether the case can go straight to active, or needs approval */
  status: 'active' | 'suggested';
  /** Whether the type was auto-promoted from work→dev */
  autoPromoted: boolean;
  /** Human-readable reason for the decision */
  reason: string;
};

/**
 * Single authoritative gate for case creation authorization.
 *
 * Determines:
 * 1. What case type should be used (auto-promoting work→dev if needed)
 * 2. Whether the case should be active immediately or need approval
 *
 * All code paths that create cases MUST call this function.
 */
export function authorizeCaseCreation(params: {
  requestedType: 'dev' | 'work';
  description: string;
  sourceGroup: string;
  isMain: boolean;
}): CaseAuthDecision {
  const { requestedType, description, sourceGroup, isMain } = params;

  // Policy 1: Auto-detect code work and promote to dev
  let caseType = requestedType;
  let autoPromoted = false;
  if (caseType === 'work' && looksLikeCodeWork(description)) {
    caseType = 'dev';
    autoPromoted = true;
    logger.info(
      { sourceGroup, description: description.slice(0, 100) },
      'Auto-promoted work→dev: description looks like code work',
    );
  }

  // Policy 2: Authorization — who can create dev cases immediately?
  if (caseType === 'dev') {
    if (isMain) {
      return {
        caseType,
        status: 'active',
        autoPromoted,
        reason: 'Main group: dev case authorized immediately',
      };
    }
    return {
      caseType,
      status: 'suggested',
      autoPromoted,
      reason: `Non-main group (${sourceGroup}): dev case needs approval`,
    };
  }

  // Work cases are always authorized immediately
  return {
    caseType: 'work',
    status: 'active',
    autoPromoted: false,
    reason: 'Work case: no approval needed',
  };
}
