import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  normalizeTelegramUserId,
  TelegramAccessControl,
} from './telegram-access-control.js';

const tempDirs: string[] = [];

function createAccessControl(
  seedAdminUserId = '',
  seedAllowedUserIds: string[] = [],
): TelegramAccessControl {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-tg-acl-'));
  tempDirs.push(tempDir);
  return new TelegramAccessControl(
    path.join(tempDir, 'telegram-access.json'),
    seedAdminUserId,
    seedAllowedUserIds,
  );
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('normalizeTelegramUserId', () => {
  it('normalizes valid values', () => {
    expect(normalizeTelegramUserId('123')).toBe('123');
    expect(normalizeTelegramUserId(' tg:456 ')).toBe('456');
    expect(normalizeTelegramUserId(789)).toBe('789');
  });

  it('rejects invalid values', () => {
    expect(normalizeTelegramUserId('abc')).toBeNull();
    expect(normalizeTelegramUserId('')).toBeNull();
    expect(normalizeTelegramUserId(null)).toBeNull();
  });
});

describe('TelegramAccessControl', () => {
  it('allows everyone when no admin/allowlist is configured', () => {
    const acl = createAccessControl();

    expect(acl.isEnabled()).toBe(false);
    expect(acl.isUserAllowed('100')).toBe(true);
    expect(acl.isUserAllowed('200')).toBe(true);
  });

  it('seeds admin and allowed users from configuration', () => {
    const acl = createAccessControl('100', ['200', '300', 'tg:200']);

    expect(acl.isEnabled()).toBe(true);
    expect(acl.getAdminUserId()).toBe('100');
    expect(acl.getAllowedUserIds()).toEqual(['200', '300']);
    expect(acl.isUserAllowed('100')).toBe(true);
    expect(acl.isUserAllowed('200')).toBe(true);
    expect(acl.isUserAllowed('999')).toBe(false);
  });

  it('sets first admin by requester', () => {
    const acl = createAccessControl();

    const result = acl.setAdmin('100', '100');

    expect(result.ok).toBe(true);
    expect(acl.getAdminUserId()).toBe('100');
    expect(acl.isUserAllowed('100')).toBe(true);
    expect(acl.isUserAllowed('200')).toBe(false);
  });

  it('blocks non-admin from changing admin once admin is set', () => {
    const acl = createAccessControl('100');

    const result = acl.setAdmin('200', '300');

    expect(result.ok).toBe(false);
    expect(acl.getAdminUserId()).toBe('100');
  });

  it('lets admin allow and remove users', () => {
    const acl = createAccessControl('100');

    expect(acl.allowUser('100', '200').ok).toBe(true);
    expect(acl.isUserAllowed('200')).toBe(true);

    expect(acl.removeUser('100', '200').ok).toBe(true);
    expect(acl.isUserAllowed('200')).toBe(false);
  });

  it('blocks non-admin from allow/remove commands', () => {
    const acl = createAccessControl('100', ['200']);

    expect(acl.allowUser('200', '300').ok).toBe(false);
    expect(acl.removeUser('200', '200').ok).toBe(false);
  });

  it('does not remove admin via removeUser', () => {
    const acl = createAccessControl('100');

    const result = acl.removeUser('100', '100');

    expect(result.ok).toBe(false);
    expect(acl.getAdminUserId()).toBe('100');
  });

  it('persists state to disk and reloads it', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-tg-acl-'));
    tempDirs.push(tempDir);
    const filePath = path.join(tempDir, 'telegram-access.json');

    const first = new TelegramAccessControl(filePath, '100');
    first.allowUser('100', '200');

    const second = new TelegramAccessControl(filePath);

    expect(second.getAdminUserId()).toBe('100');
    expect(second.getAllowedUserIds()).toEqual(['200']);
    expect(second.isUserAllowed('200')).toBe(true);
  });
});
