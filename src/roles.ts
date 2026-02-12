/**
 * roles.ts — Role management and temporary blocking.
 *
 * All functions take a better-sqlite3 Database instance as first arg
 * so callers control the connection lifecycle.
 */
import type Database from 'better-sqlite3';
import type { UserRole } from './types.js';
import { nowISO } from './utils.js';

const ADMIN_ROLES: UserRole[] = ['admin', 'superadmin'];

/** Get user's role. Defaults to 'user' if not set or user doesn't exist. */
export function getUserRole(db: Database.Database, phone: string): UserRole {
  const row = db
    .prepare('SELECT role FROM users WHERE phone = ?')
    .get(phone) as { role: string | null } | undefined;
  return (row?.role as UserRole) ?? 'user';
}

/** Check if user has admin or superadmin role. */
export function isAdmin(db: Database.Database, phone: string): boolean {
  const role = getUserRole(db, phone);
  return ADMIN_ROLES.includes(role);
}

/**
 * Set user's role. Only superadmin can promote to admin/superadmin.
 * Admin can set user/karyakarta. Returns 'OK' or an error message.
 */
export function setUserRole(
  db: Database.Database,
  phone: string,
  role: UserRole,
  callerRole: UserRole,
): string {
  // Only admin or superadmin callers can change roles
  if (!ADMIN_ROLES.includes(callerRole)) {
    return 'Only admin or superadmin can change user roles.';
  }

  // Only superadmin can promote to admin/superadmin
  if (ADMIN_ROLES.includes(role) && callerRole !== 'superadmin') {
    return 'Only superadmin can promote users to admin or superadmin.';
  }

  db.prepare('UPDATE users SET role = ? WHERE phone = ?').run(role, phone);
  return 'OK';
}

/**
 * Temporarily block a user for `hours`. Refuses if target is admin/superadmin.
 * Creates user record if not exists.
 */
export function tempBlockUser(
  db: Database.Database,
  phone: string,
  reason: string,
  hours: number,
): string {
  // Check if target is admin/superadmin
  const role = getUserRole(db, phone);
  if (ADMIN_ROLES.includes(role)) {
    return 'This user is an admin and cannot be blocked.';
  }

  const now = nowISO();
  const blockedUntil = new Date(Date.now() + hours * 60 * 60 * 1000)
    .toISOString()
    .replace(/\.\d{3}Z$/, 'Z');

  db.prepare(
    `INSERT INTO users (phone, is_blocked, block_reason, blocked_until, first_seen, last_seen)
     VALUES (?, 1, ?, ?, ?, ?)
     ON CONFLICT(phone) DO UPDATE SET
       is_blocked = 1, block_reason = ?, blocked_until = ?, last_seen = ?`,
  ).run(phone, reason, blockedUntil, now, now, reason, blockedUntil, now);

  return 'OK';
}

/**
 * Check if user is temporarily blocked (blocked_until > now).
 * Auto-unblocks if expired. Admins/superadmins always return false.
 */
export function isUserTempBlocked(
  db: Database.Database,
  phone: string,
): boolean {
  const row = db
    .prepare(
      'SELECT role, is_blocked, blocked_until FROM users WHERE phone = ?',
    )
    .get(phone) as
    | { role: string | null; is_blocked: number; blocked_until: string | null }
    | undefined;

  if (!row) return false;

  // Admins/superadmins are never blocked
  if (ADMIN_ROLES.includes((row.role ?? 'user') as UserRole)) return false;

  if (!row.blocked_until) return row.is_blocked === 1;

  const blockedUntil = new Date(row.blocked_until).getTime();
  if (blockedUntil > Date.now()) return true;

  // Expired — auto-unblock
  db.prepare(
    'UPDATE users SET is_blocked = 0, blocked_until = NULL WHERE phone = ?',
  ).run(phone);
  return false;
}

/** Unblock a user immediately (clear is_blocked and blocked_until). */
export function unblockUser(db: Database.Database, phone: string): string {
  const row = db.prepare('SELECT phone FROM users WHERE phone = ?').get(phone);
  if (!row) return 'User not found.';

  db.prepare(
    'UPDATE users SET is_blocked = 0, blocked_until = NULL WHERE phone = ?',
  ).run(phone);
  return 'OK';
}

/** Auto-assign admin role if phone is in admin_phones list. Does not downgrade superadmin. */
export function autoAssignAdminRole(
  db: Database.Database,
  phone: string,
  adminPhones: string[],
): void {
  if (!adminPhones.includes(phone)) return;

  const currentRole = getUserRole(db, phone);

  // Don't downgrade superadmin to admin
  if (currentRole === 'superadmin') return;

  const now = nowISO();
  // Upsert user with admin role
  db.prepare(
    `INSERT INTO users (phone, role, first_seen, last_seen)
     VALUES (?, 'admin', ?, ?)
     ON CONFLICT(phone) DO UPDATE SET role = 'admin', last_seen = ?`,
  ).run(phone, now, now, now);
}
