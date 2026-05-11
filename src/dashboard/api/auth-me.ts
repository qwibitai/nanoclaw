import { register, requireAuth } from '../router.js';
import type { AuthHandler } from '../router.js';
import { computeScopes } from '../auth/compute-scopes.js';

export const authMeHandler: AuthHandler = async (_req, _params, ctx) => {
  const userId = ctx.user.id;
  const scopes = computeScopes(userId);

  return new Response(JSON.stringify({ user_id: userId, scopes }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
};

// Side-effect registration
register('GET', '/dashboard/api/auth/me', requireAuth(authMeHandler));
