/**
 * Authentication routes — login, logout, user management.
 */
import { readEnvFile } from '../../env.js';
import { logger } from '../../logger.js';
import {
  hashPassword,
  signToken,
  verifyPassword,
} from '../middleware/auth.js';
import {
  createUser,
  getUserByEmail,
  getUserById,
  getUserCount,
} from '../db-portal.js';
import { json, error, RequestContext } from '../server.js';

export function ensureDefaultAdmin(): void {
  if (getUserCount() > 0) return;

  const envSecrets = readEnvFile([
    'PORTAL_ADMIN_EMAIL',
    'PORTAL_ADMIN_PASSWORD',
  ]);
  const email =
    process.env.PORTAL_ADMIN_EMAIL ||
    envSecrets.PORTAL_ADMIN_EMAIL ||
    'admin@blackhawkdata.com';
  const password =
    process.env.PORTAL_ADMIN_PASSWORD ||
    envSecrets.PORTAL_ADMIN_PASSWORD ||
    'changeme';

  createUser({
    email,
    name: 'Admin',
    password_hash: hashPassword(password),
    role: 'admin',
  });
  logger.info({ email }, 'Default admin user created');
}

export async function handleAuthRoutes(ctx: RequestContext): Promise<void> {
  const { method, pathname, body, res, user } = ctx;

  // POST /api/auth/login
  if (method === 'POST' && pathname === '/api/auth/login') {
    const { email, password } = (body as { email?: string; password?: string }) || {};
    if (!email || !password) {
      error(res, 'Email and password required');
      return;
    }

    const dbUser = getUserByEmail(email);
    if (!dbUser || !verifyPassword(password, dbUser.password_hash)) {
      error(res, 'Invalid credentials', 401);
      return;
    }

    const token = signToken({
      sub: dbUser.id,
      email: dbUser.email,
      role: dbUser.role,
    });

    json(res, {
      token,
      user: {
        id: dbUser.id,
        email: dbUser.email,
        name: dbUser.name,
        role: dbUser.role,
      },
    });
    return;
  }

  // GET /api/auth/me
  if (method === 'GET' && pathname === '/api/auth/me') {
    if (!user) {
      error(res, 'Unauthorized', 401);
      return;
    }
    const dbUser = getUserById(user.sub);
    if (!dbUser) {
      error(res, 'User not found', 404);
      return;
    }
    json(res, {
      id: dbUser.id,
      email: dbUser.email,
      name: dbUser.name,
      role: dbUser.role,
    });
    return;
  }

  // POST /api/auth/register (admin only)
  if (method === 'POST' && pathname === '/api/auth/register') {
    if (!user || user.role !== 'admin') {
      error(res, 'Admin access required', 403);
      return;
    }
    const { email, name, password, role } = (body as {
      email?: string;
      name?: string;
      password?: string;
      role?: string;
    }) || {};
    if (!email || !name || !password) {
      error(res, 'Email, name, and password required');
      return;
    }

    if (getUserByEmail(email)) {
      error(res, 'Email already registered', 409);
      return;
    }

    const newUser = createUser({
      email,
      name,
      password_hash: hashPassword(password),
      role: (role as 'admin' | 'operator' | 'viewer') || 'operator',
    });

    json(res, {
      id: newUser.id,
      email: newUser.email,
      name: newUser.name,
      role: newUser.role,
    }, 201);
    return;
  }

  error(res, 'Not Found', 404);
}
