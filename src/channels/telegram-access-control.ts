import fs from 'fs';
import path from 'path';

import { logger } from '../logger.js';

export interface TelegramAccessState {
  adminUserId: string | null;
  allowedUserIds: string[];
}

export interface AccessActionResult {
  ok: boolean;
  message: string;
}

export interface TelegramAccessController {
  isEnabled(): boolean;
  isAdmin(userId: string): boolean;
  isUserAllowed(userId: string): boolean;
  getAdminUserId(): string | null;
  getAllowedUserIds(): string[];
  setAdmin(requesterUserId: string, newAdminUserId: string): AccessActionResult;
  allowUser(requesterUserId: string, userId: string): AccessActionResult;
  removeUser(requesterUserId: string, userId: string): AccessActionResult;
}

export function normalizeTelegramUserId(
  userId: string | number | null | undefined,
): string | null {
  if (userId === null || userId === undefined) return null;
  const normalized = String(userId).trim().replace(/^tg:/, '');
  if (!/^\d+$/.test(normalized)) return null;
  return normalized;
}

function sanitizeAllowedUserIds(ids: Iterable<string>): string[] {
  const clean = new Set<string>();
  for (const id of ids) {
    const normalized = normalizeTelegramUserId(id);
    if (normalized) clean.add(normalized);
  }
  return [...clean].sort();
}

function statesEqual(a: TelegramAccessState, b: TelegramAccessState): boolean {
  if (a.adminUserId !== b.adminUserId) return false;
  if (a.allowedUserIds.length !== b.allowedUserIds.length) return false;
  return a.allowedUserIds.every((id, i) => id === b.allowedUserIds[i]);
}

export class TelegramAccessControl implements TelegramAccessController {
  private readonly filePath: string;
  private state: TelegramAccessState;

  constructor(
    filePath: string,
    seedAdminUserId = '',
    seedAllowedUserIds: string[] = [],
  ) {
    this.filePath = filePath;
    this.state = this.loadState(seedAdminUserId, seedAllowedUserIds);
  }

  isEnabled(): boolean {
    return !!this.state.adminUserId || this.state.allowedUserIds.length > 0;
  }

  isAdmin(userId: string): boolean {
    const normalized = normalizeTelegramUserId(userId);
    return !!normalized && normalized === this.state.adminUserId;
  }

  isUserAllowed(userId: string): boolean {
    if (!this.isEnabled()) return true;

    const normalized = normalizeTelegramUserId(userId);
    if (!normalized) return false;

    if (normalized === this.state.adminUserId) return true;
    return this.state.allowedUserIds.includes(normalized);
  }

  getAdminUserId(): string | null {
    return this.state.adminUserId;
  }

  getAllowedUserIds(): string[] {
    return [...this.state.allowedUserIds];
  }

  setAdmin(requesterUserId: string, newAdminUserId: string): AccessActionResult {
    const requester = normalizeTelegramUserId(requesterUserId);
    const nextAdmin = normalizeTelegramUserId(newAdminUserId);

    if (!requester || !nextAdmin) {
      return {
        ok: false,
        message: 'Invalid Telegram user ID. Use /myid to get a valid ID.',
      };
    }

    const currentAdmin = this.state.adminUserId;
    if (currentAdmin && currentAdmin !== requester) {
      return {
        ok: false,
        message: `Only current admin (${currentAdmin}) can change admin.`,
      };
    }

    if (currentAdmin === nextAdmin) {
      return {
        ok: true,
        message: `Admin is already ${nextAdmin}.`,
      };
    }

    const allowed = new Set(this.state.allowedUserIds);
    if (currentAdmin && currentAdmin !== nextAdmin) {
      // Keep previous admin authorized after transfer.
      allowed.add(currentAdmin);
    }
    allowed.delete(nextAdmin);

    this.state = {
      adminUserId: nextAdmin,
      allowedUserIds: [...allowed].sort(),
    };
    this.persistState();

    return {
      ok: true,
      message: `Admin set to ${nextAdmin}.`,
    };
  }

  allowUser(requesterUserId: string, userId: string): AccessActionResult {
    const requester = normalizeTelegramUserId(requesterUserId);
    const target = normalizeTelegramUserId(userId);

    if (!requester || !target) {
      return {
        ok: false,
        message: 'Invalid Telegram user ID. Use /myid to get a valid ID.',
      };
    }

    const admin = this.state.adminUserId;
    if (!admin) {
      return {
        ok: false,
        message: 'Admin is not set. Run /set_admin <user_id> first.',
      };
    }

    if (requester !== admin) {
      return {
        ok: false,
        message: `Only admin (${admin}) can grant access.`,
      };
    }

    if (target === admin) {
      return {
        ok: true,
        message: `User ${target} is already the admin.`,
      };
    }

    if (this.state.allowedUserIds.includes(target)) {
      return {
        ok: true,
        message: `User ${target} is already allowed.`,
      };
    }

    this.state = {
      ...this.state,
      allowedUserIds: [...this.state.allowedUserIds, target].sort(),
    };
    this.persistState();

    return {
      ok: true,
      message: `Access granted to user ${target}.`,
    };
  }

  removeUser(requesterUserId: string, userId: string): AccessActionResult {
    const requester = normalizeTelegramUserId(requesterUserId);
    const target = normalizeTelegramUserId(userId);

    if (!requester || !target) {
      return {
        ok: false,
        message: 'Invalid Telegram user ID. Use /myid to get a valid ID.',
      };
    }

    const admin = this.state.adminUserId;
    if (!admin) {
      return {
        ok: false,
        message: 'Admin is not set. Run /set_admin <user_id> first.',
      };
    }

    if (requester !== admin) {
      return {
        ok: false,
        message: `Only admin (${admin}) can revoke access.`,
      };
    }

    if (target === admin) {
      return {
        ok: false,
        message: 'Cannot remove the admin. Transfer admin first with /set_admin.',
      };
    }

    if (!this.state.allowedUserIds.includes(target)) {
      return {
        ok: true,
        message: `User ${target} is not in allowed list.`,
      };
    }

    this.state = {
      ...this.state,
      allowedUserIds: this.state.allowedUserIds.filter((id) => id !== target),
    };
    this.persistState();

    return {
      ok: true,
      message: `Access removed for user ${target}.`,
    };
  }

  private loadState(
    seedAdminUserId: string,
    seedAllowedUserIds: string[],
  ): TelegramAccessState {
    const seedAdmin = normalizeTelegramUserId(seedAdminUserId);
    const seedAllowed = sanitizeAllowedUserIds(seedAllowedUserIds);

    let state: TelegramAccessState = {
      adminUserId: seedAdmin,
      allowedUserIds: seedAllowed.filter((id) => id !== seedAdmin),
    };

    if (fs.existsSync(this.filePath)) {
      try {
        const raw = JSON.parse(fs.readFileSync(this.filePath, 'utf-8'));
        state = this.parseState(raw);
      } catch (err) {
        logger.warn(
          { err, filePath: this.filePath },
          'Failed to parse Telegram access file, rebuilding with seed values',
        );
      }
    }

    const merged = this.mergeSeedState(state, seedAdmin, seedAllowed);

    // Ensure file exists and stays normalized.
    if (!fs.existsSync(this.filePath) || !statesEqual(merged, state)) {
      this.writeStateToDisk(merged);
    }

    return merged;
  }

  private parseState(raw: unknown): TelegramAccessState {
    if (typeof raw !== 'object' || raw === null) {
      return { adminUserId: null, allowedUserIds: [] };
    }

    const source = raw as Partial<TelegramAccessState>;
    const adminUserId = normalizeTelegramUserId(source.adminUserId ?? null);
    const allowedUserIds = sanitizeAllowedUserIds(
      Array.isArray(source.allowedUserIds) ? source.allowedUserIds : [],
    ).filter((id) => id !== adminUserId);

    return {
      adminUserId,
      allowedUserIds,
    };
  }

  private mergeSeedState(
    base: TelegramAccessState,
    seedAdminUserId: string | null,
    seedAllowedUserIds: string[],
  ): TelegramAccessState {
    const adminUserId = base.adminUserId || seedAdminUserId || null;
    const allowed = new Set(base.allowedUserIds);

    for (const id of seedAllowedUserIds) {
      allowed.add(id);
    }

    if (adminUserId) {
      allowed.delete(adminUserId);
    }

    return {
      adminUserId,
      allowedUserIds: [...allowed].sort(),
    };
  }

  private persistState(): void {
    this.writeStateToDisk(this.state);
  }

  private writeStateToDisk(state: TelegramAccessState): void {
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      fs.writeFileSync(this.filePath, `${JSON.stringify(state, null, 2)}\n`, 'utf-8');
    } catch (err) {
      logger.error(
        { err, filePath: this.filePath },
        'Failed to persist Telegram access control state',
      );
    }
  }
}
