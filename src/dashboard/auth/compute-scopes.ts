import { getDb } from '../../db/connection.js';
import type { GroupScope } from '../router.js';

interface UserRoleRow {
  role: string;
  agent_group_id: string | null;
}

export interface UserScopes {
  role: GroupScope['role'];
  allowed_group_ids: string[];
  no_filter: boolean;
}

/**
 * Compute the dashboard scope for a user, querying `user_roles` directly.
 *
 * Used by:
 *  - `requireAuth` (src/dashboard/router.ts) to populate `ctx.scopes` for every
 *    authenticated request — drives §2a per-query scope filtering.
 *  - `authMeHandler` (src/dashboard/api/auth-me.ts) to project the scope to the SPA.
 *
 * Both call sites must share the same logic; previously they diverged
 * (post-build QA fix MF-3 — scoped admins were getting allowed_group_ids=[]
 * because requireAuth used canAccessAgentGroup(user, '*') instead of this
 * enumeration query, locking the entire scoped-admin role tier out of the dashboard).
 */
export function computeScopes(userId: string): UserScopes {
  const rows = getDb()
    .prepare('SELECT role, agent_group_id FROM user_roles WHERE user_id = ?')
    .all(userId) as UserRoleRow[];

  const isOwner = rows.some((r) => r.role === 'owner' && r.agent_group_id === null);
  const isGlobalAdmin = rows.some((r) => r.role === 'admin' && r.agent_group_id === null);

  if (isOwner) {
    return { role: 'owner', allowed_group_ids: [], no_filter: true };
  }
  if (isGlobalAdmin) {
    return { role: 'global_admin', allowed_group_ids: [], no_filter: true };
  }

  const scopedAdminGroups = rows
    .filter((r) => r.role === 'admin' && r.agent_group_id !== null)
    .map((r) => r.agent_group_id as string)
    .sort();

  if (scopedAdminGroups.length > 0) {
    return { role: 'admin_of_group', allowed_group_ids: scopedAdminGroups, no_filter: false };
  }

  const memberGroups = rows
    .filter((r) => r.role === 'member' && r.agent_group_id !== null)
    .map((r) => r.agent_group_id as string)
    .sort();

  return { role: 'member', allowed_group_ids: memberGroups, no_filter: false };
}
