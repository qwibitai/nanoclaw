import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// The module reads from the filesystem and shells out to sqlite3. We stub
// both and import the SUT through vi.resetModules so each test gets a
// fresh copy with its own mocks.

describe('contacts-lookup', () => {
  beforeEach(() => {
    vi.resetModules();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns [] when the AddressBook directory does not exist', async () => {
    vi.doMock('fs', async () => {
      const actual = await vi.importActual<typeof import('fs')>('fs');
      return {
        ...actual,
        existsSync: vi.fn(() => false),
        readdirSync: vi.fn(),
        copyFileSync: vi.fn(),
        unlinkSync: vi.fn(),
      };
    });
    const { lookupContactEmails } = await import('../contacts-lookup.js');
    expect(lookupContactEmails('Philip Ye')).toEqual([]);
  });

  it('returns [] for empty query without touching fs', async () => {
    const existsSync = vi.fn(() => true);
    vi.doMock('fs', async () => {
      const actual = await vi.importActual<typeof import('fs')>('fs');
      return {
        ...actual,
        existsSync,
        readdirSync: vi.fn(),
        copyFileSync: vi.fn(),
        unlinkSync: vi.fn(),
      };
    });
    const { lookupContactEmails } = await import('../contacts-lookup.js');
    expect(lookupContactEmails('   ')).toEqual([]);
    expect(existsSync).not.toHaveBeenCalled();
  });

  it('parses sqlite3 json output and de-dupes contacts', async () => {
    vi.doMock('fs', async () => {
      const actual = await vi.importActual<typeof import('fs')>('fs');
      return {
        ...actual,
        existsSync: vi.fn(() => true),
        readdirSync: vi.fn(() => ['source-uuid']),
        copyFileSync: vi.fn(),
        unlinkSync: vi.fn(),
      };
    });
    vi.doMock('child_process', () => ({
      execFileSync: vi.fn(() =>
        JSON.stringify([
          { first: 'Philip', last: 'Ye', email: 'philip@whoisxmlapi.com' },
          { first: 'Philip', last: 'Ye', email: 'philip@whoisxmlapi.com' },
          { first: 'Philip', last: 'Ye', email: 'philip.ye@gmail.com' },
        ]),
      ),
    }));
    const { lookupContactEmails, resolveSingleContactEmail } =
      await import('../contacts-lookup.js');
    const matches = lookupContactEmails('Philip Ye');
    expect(matches).toHaveLength(3);
    expect(matches.map((m) => m.email).sort()).toEqual([
      'philip.ye@gmail.com',
      'philip@whoisxmlapi.com',
      'philip@whoisxmlapi.com',
    ]);
    // Ambiguous (two distinct addresses) → null.
    expect(resolveSingleContactEmail('Philip Ye')).toBeNull();
  });

  it('resolveSingleContactEmail returns email for unambiguous match', async () => {
    vi.doMock('fs', async () => {
      const actual = await vi.importActual<typeof import('fs')>('fs');
      return {
        ...actual,
        existsSync: vi.fn(() => true),
        readdirSync: vi.fn(() => ['source-uuid']),
        copyFileSync: vi.fn(),
        unlinkSync: vi.fn(),
      };
    });
    vi.doMock('child_process', () => ({
      execFileSync: vi.fn(() =>
        JSON.stringify([
          { first: 'Alice', last: 'Smith', email: 'alice@example.com' },
          { first: 'Alice', last: 'Smith', email: 'alice@example.com' }, // dup
        ]),
      ),
    }));
    const { resolveSingleContactEmail } = await import('../contacts-lookup.js');
    expect(resolveSingleContactEmail('Alice Smith')).toBe('alice@example.com');
  });

  it('filters out rows without an @ in the email', async () => {
    vi.doMock('fs', async () => {
      const actual = await vi.importActual<typeof import('fs')>('fs');
      return {
        ...actual,
        existsSync: vi.fn(() => true),
        readdirSync: vi.fn(() => ['source-uuid']),
        copyFileSync: vi.fn(),
        unlinkSync: vi.fn(),
      };
    });
    vi.doMock('child_process', () => ({
      execFileSync: vi.fn(() =>
        JSON.stringify([
          { first: 'Bob', last: '', email: 'not-an-email' },
          { first: 'Bob', last: '', email: null },
          { first: 'Bob', last: '', email: 'bob@example.com' },
        ]),
      ),
    }));
    const { lookupContactEmails } = await import('../contacts-lookup.js');
    const matches = lookupContactEmails('Bob');
    expect(matches).toHaveLength(1);
    expect(matches[0].email).toBe('bob@example.com');
  });

  it('swallows sqlite errors and returns []', async () => {
    vi.doMock('fs', async () => {
      const actual = await vi.importActual<typeof import('fs')>('fs');
      return {
        ...actual,
        existsSync: vi.fn(() => true),
        readdirSync: vi.fn(() => ['source-uuid']),
        copyFileSync: vi.fn(),
        unlinkSync: vi.fn(),
      };
    });
    vi.doMock('child_process', () => ({
      execFileSync: vi.fn(() => {
        throw new Error('database is locked');
      }),
    }));
    const { lookupContactEmails } = await import('../contacts-lookup.js');
    expect(lookupContactEmails('anyone')).toEqual([]);
  });
});
