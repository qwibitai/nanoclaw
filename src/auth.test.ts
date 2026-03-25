import { describe, it, expect, beforeEach } from 'vitest';

import {
  _initTestDatabase,
  createUser,
  getUserById,
  getUserByUsername,
  listUsers,
  updateUser,
  deleteUser,
  hasAnyUsers,
  getUserGroups,
  setUserGroups,
  getConfigValue,
  setConfigValue,
  createGate,
  getGatesPaginated,
} from './db.js';
import {
  hashPassword,
  verifyPassword,
  signJwt,
  verifyJwt,
  parseCookieToken,
  getOrCreateJwtSecret,
  _resetSecretCache,
} from './auth.js';

beforeEach(() => {
  _initTestDatabase();
  _resetSecretCache();
});

// --- User CRUD ---

function makeUser(
  overrides: Partial<{
    id: string;
    username: string;
    password_hash: string;
    display_name: string | null;
    role: 'admin' | 'member';
  }> = {},
) {
  const now = new Date().toISOString();
  return {
    id: overrides.id ?? `user-${Math.random().toString(36).slice(2, 8)}`,
    username:
      overrides.username ?? `user_${Math.random().toString(36).slice(2, 8)}`,
    password_hash: overrides.password_hash ?? '$2b$10$fakehash',
    display_name: overrides.display_name ?? null,
    role: (overrides.role ?? 'member') as 'admin' | 'member',
    created_at: now,
    updated_at: now,
  };
}

describe('createUser + getUserById', () => {
  it('creates a user and retrieves by ID', () => {
    const user = makeUser({ id: 'u1', username: 'alice', role: 'admin' });
    createUser(user);

    const found = getUserById('u1');
    expect(found).not.toBeUndefined();
    expect(found!.username).toBe('alice');
    expect(found!.role).toBe('admin');
  });

  it('returns undefined for unknown ID', () => {
    expect(getUserById('no-such-user')).toBeUndefined();
  });
});

describe('getUserByUsername', () => {
  it('finds a user by username', () => {
    createUser(makeUser({ id: 'u2', username: 'bob' }));
    const found = getUserByUsername('bob');
    expect(found).not.toBeUndefined();
    expect(found!.id).toBe('u2');
  });

  it('returns undefined for unknown username', () => {
    expect(getUserByUsername('ghost')).toBeUndefined();
  });
});

describe('listUsers', () => {
  it('returns all users ordered by created_at', () => {
    createUser(makeUser({ id: 'u3', username: 'carol' }));
    createUser(makeUser({ id: 'u4', username: 'dave' }));

    const users = listUsers();
    expect(users.length).toBeGreaterThanOrEqual(2);
    const ids = users.map((u) => u.id);
    expect(ids).toContain('u3');
    expect(ids).toContain('u4');
  });
});

describe('updateUser', () => {
  it('updates display_name', () => {
    createUser(makeUser({ id: 'u5', username: 'eve' }));
    const updated = updateUser('u5', { display_name: 'Eve Adams' });
    expect(updated).toBe(true);

    const found = getUserById('u5');
    expect(found!.display_name).toBe('Eve Adams');
  });

  it('updates role', () => {
    createUser(makeUser({ id: 'u6', username: 'frank', role: 'member' }));
    updateUser('u6', { role: 'admin' });

    const found = getUserById('u6');
    expect(found!.role).toBe('admin');
  });

  it('returns false for no valid fields', () => {
    createUser(makeUser({ id: 'u7', username: 'grace' }));
    const updated = updateUser('u7', {});
    expect(updated).toBe(false);
  });
});

describe('deleteUser', () => {
  it('deletes a user', () => {
    createUser(makeUser({ id: 'u8', username: 'hank' }));
    const deleted = deleteUser('u8');
    expect(deleted).toBe(true);
    expect(getUserById('u8')).toBeUndefined();
  });

  it('returns false for non-existent user', () => {
    expect(deleteUser('no-user')).toBe(false);
  });
});

describe('hasAnyUsers', () => {
  it('returns false when no users exist', () => {
    expect(hasAnyUsers()).toBe(false);
  });

  it('returns true once a user is created', () => {
    createUser(makeUser({ id: 'u9', username: 'ivy' }));
    expect(hasAnyUsers()).toBe(true);
  });
});

describe('getUserGroups + setUserGroups', () => {
  it('sets and retrieves user group memberships', () => {
    createUser(makeUser({ id: 'u10', username: 'jack' }));
    setUserGroups('u10', ['main', 'dev']);

    const groups = getUserGroups('u10');
    expect(groups).toContain('main');
    expect(groups).toContain('dev');
    expect(groups).toHaveLength(2);
  });

  it('replaces groups on second call', () => {
    createUser(makeUser({ id: 'u11', username: 'kate' }));
    setUserGroups('u11', ['main', 'dev']);
    setUserGroups('u11', ['prod']);

    const groups = getUserGroups('u11');
    expect(groups).toEqual(['prod']);
  });

  it('returns empty array when no groups set', () => {
    createUser(makeUser({ id: 'u12', username: 'liam' }));
    expect(getUserGroups('u12')).toEqual([]);
  });
});

// --- Config store ---

describe('getConfigValue + setConfigValue', () => {
  it('stores and retrieves a value', () => {
    setConfigValue('test_key', 'test_value');
    expect(getConfigValue('test_key')).toBe('test_value');
  });

  it('returns null for missing key', () => {
    expect(getConfigValue('no_such_key')).toBeNull();
  });

  it('overwrites on second set', () => {
    setConfigValue('k', 'v1');
    setConfigValue('k', 'v2');
    expect(getConfigValue('k')).toBe('v2');
  });
});

// --- Gate pagination ---

function makeGate(
  overrides: Partial<{
    id: string;
    group_folder: string;
    chat_jid: string;
    status: 'pending' | 'approved' | 'cancelled';
  }> = {},
) {
  return {
    id: overrides.id ?? `gate-${Math.random().toString(36).slice(2, 8)}`,
    group_folder: overrides.group_folder ?? 'test-group',
    chat_jid: overrides.chat_jid ?? 'dc:123',
    label: 'Test Gate',
    summary: 'Summary',
    context_data: null,
    resume_prompt: null,
    session_key: null,
    status: (overrides.status ?? 'pending') as
      | 'pending'
      | 'approved'
      | 'cancelled',
    created_at: new Date().toISOString(),
  };
}

describe('getGatesPaginated', () => {
  it('returns all gates without filter', () => {
    createGate(makeGate({ id: 'g1', status: 'pending' }));
    createGate(makeGate({ id: 'g2', status: 'approved' }));

    const result = getGatesPaginated(undefined, 50, 0);
    expect(result.total).toBeGreaterThanOrEqual(2);
    const ids = result.data.map((g) => g.id);
    expect(ids).toContain('g1');
    expect(ids).toContain('g2');
  });

  it('filters by status', () => {
    createGate(makeGate({ id: 'g3', status: 'pending' }));
    createGate(makeGate({ id: 'g4', status: 'cancelled' }));

    const pending = getGatesPaginated('pending', 50, 0);
    expect(pending.data.every((g) => g.status === 'pending')).toBe(true);

    const cancelled = getGatesPaginated('cancelled', 50, 0);
    expect(cancelled.data.every((g) => g.status === 'cancelled')).toBe(true);
  });

  it('paginates correctly', () => {
    for (let i = 0; i < 5; i++) {
      createGate(makeGate({ id: `g-page-${i}`, status: 'pending' }));
    }

    const page1 = getGatesPaginated('pending', 3, 0);
    const page2 = getGatesPaginated('pending', 3, 3);
    expect(page1.data.length).toBe(3);
    expect(page2.data.length).toBeGreaterThanOrEqual(2);
  });
});

// --- Auth module ---

describe('hashPassword + verifyPassword', () => {
  it('hashes and verifies a password', async () => {
    const hash = await hashPassword('secret123');
    expect(hash).not.toBe('secret123');
    expect(await verifyPassword('secret123', hash)).toBe(true);
    expect(await verifyPassword('wrong', hash)).toBe(false);
  });
});

describe('signJwt + verifyJwt', () => {
  const secret = 'test-secret-value';

  it('signs and verifies a token', () => {
    const token = signJwt({ userId: 'u1', role: 'admin' }, secret);
    const decoded = verifyJwt(token, secret);
    expect(decoded).not.toBeNull();
    expect(decoded!.userId).toBe('u1');
    expect(decoded!.role).toBe('admin');
  });

  it('returns null for invalid token', () => {
    expect(verifyJwt('not-a-token', secret)).toBeNull();
  });

  it('returns null for wrong secret', () => {
    const token = signJwt({ userId: 'u1', role: 'admin' }, secret);
    expect(verifyJwt(token, 'wrong-secret')).toBeNull();
  });
});

describe('parseCookieToken', () => {
  it('extracts nc_token from cookie header', () => {
    const token = parseCookieToken('nc_token=abc123; other=xyz');
    expect(token).toBe('abc123');
  });

  it('returns null when nc_token is absent', () => {
    expect(parseCookieToken('session=foo; bar=baz')).toBeNull();
  });

  it('returns null for undefined cookie header', () => {
    expect(parseCookieToken(undefined)).toBeNull();
  });
});

describe('getOrCreateJwtSecret', () => {
  it('generates and persists a secret', () => {
    const secret1 = getOrCreateJwtSecret();
    expect(secret1).toBeTruthy();
    expect(secret1.length).toBeGreaterThan(32);

    _resetSecretCache();
    const secret2 = getOrCreateJwtSecret();
    // Same secret should be loaded from DB
    expect(secret2).toBe(secret1);
  });
});
