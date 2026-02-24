/**
 * GitHub Access Control
 * Permission checking and rate limiting for webhook events.
 */
import { Octokit } from '@octokit/rest';

import { logger } from '../logger.js';

export type PermissionLevel = 'admin' | 'maintain' | 'write' | 'triage' | 'read' | 'none';

const PERMISSION_RANK: Record<PermissionLevel, number> = {
  admin: 5,
  maintain: 4,
  write: 3,
  triage: 2,
  read: 1,
  none: 0,
};

export interface AccessPolicy {
  minPermission: PermissionLevel;
  allowExternalContributors: boolean;
  rateLimitPerUser: number;
  rateLimitWindowMs: number;
}

export const DEFAULT_ACCESS_POLICY: AccessPolicy = {
  minPermission: 'triage',
  allowExternalContributors: false,
  rateLimitPerUser: 10,
  rateLimitWindowMs: 3600000, // 1 hour
};

/**
 * Check if a user has sufficient permission to trigger the bot.
 */
export async function checkPermission(
  octokit: Octokit,
  owner: string,
  repo: string,
  username: string,
  policy: AccessPolicy,
): Promise<{ allowed: boolean; reason?: string }> {
  try {
    const { data } = await octokit.repos.getCollaboratorPermissionLevel({
      owner,
      repo,
      username,
    });

    const userLevel = data.permission as PermissionLevel;
    const userRank = PERMISSION_RANK[userLevel] ?? 0;
    const requiredRank = PERMISSION_RANK[policy.minPermission] ?? 0;

    if (userRank >= requiredRank) {
      return { allowed: true };
    }

    // External contributors on public repos
    if (policy.allowExternalContributors) {
      return { allowed: true };
    }

    return {
      allowed: false,
      reason: `Insufficient permissions: ${userLevel} < ${policy.minPermission}`,
    };
  } catch (err: unknown) {
    // 404 = user is not a collaborator. Allow if external contributors are allowed.
    if (err && typeof err === 'object' && 'status' in err && (err as { status: number }).status === 404) {
      if (policy.allowExternalContributors) {
        return { allowed: true };
      }
      return { allowed: false, reason: 'Not a collaborator' };
    }

    logger.error({ err, owner, repo, username }, 'Failed to check permission');
    return { allowed: false, reason: 'Permission check failed' };
  }
}

/**
 * Simple in-memory rate limiter.
 * Tracks invocation timestamps per user-repo pair.
 */
export class RateLimiter {
  private buckets = new Map<string, number[]>();

  check(user: string, repoJid: string, policy: AccessPolicy): { allowed: boolean; retryAfterMs?: number } {
    const key = `${user}:${repoJid}`;
    const now = Date.now();
    const window = policy.rateLimitWindowMs;

    let timestamps = this.buckets.get(key) || [];
    // Prune expired entries
    timestamps = timestamps.filter(t => now - t < window);

    if (timestamps.length >= policy.rateLimitPerUser) {
      const oldest = timestamps[0];
      const retryAfterMs = window - (now - oldest);
      return { allowed: false, retryAfterMs };
    }

    timestamps.push(now);
    this.buckets.set(key, timestamps);
    return { allowed: true };
  }

  /** Periodic cleanup of stale entries. */
  cleanup(maxAgeMs: number = 7200000): void {
    const now = Date.now();
    for (const [key, timestamps] of this.buckets) {
      const fresh = timestamps.filter(t => now - t < maxAgeMs);
      if (fresh.length === 0) {
        this.buckets.delete(key);
      } else {
        this.buckets.set(key, fresh);
      }
    }
  }
}

/**
 * Parse a .github/nanoclaw.yml config into an AccessPolicy.
 * Falls back to defaults for missing fields.
 */
export function parseAccessPolicy(config: Record<string, unknown>): AccessPolicy {
  const access = (config.access || {}) as Record<string, unknown>;
  return {
    minPermission: (access.min_permission as PermissionLevel) || DEFAULT_ACCESS_POLICY.minPermission,
    allowExternalContributors: access.allow_external === true,
    rateLimitPerUser: typeof access.rate_limit === 'number'
      ? access.rate_limit
      : DEFAULT_ACCESS_POLICY.rateLimitPerUser,
    rateLimitWindowMs: DEFAULT_ACCESS_POLICY.rateLimitWindowMs,
  };
}
