import path from 'path';

import { describe, expect, it } from 'vitest';

import {
  decodeIpcNamespaceKey,
  encodeIpcNamespaceKey,
  isValidGroupFolder,
  resolveGroupFolderPath,
  resolveGroupIpcPath,
  resolveGroupIpcPathByJid,
} from './group-folder.js';

describe('group folder validation', () => {
  it('accepts normal group folder names', () => {
    expect(isValidGroupFolder('main')).toBe(true);
    expect(isValidGroupFolder('family-chat')).toBe(true);
    expect(isValidGroupFolder('Team_42')).toBe(true);
  });

  it('rejects traversal and reserved names', () => {
    expect(isValidGroupFolder('../../etc')).toBe(false);
    expect(isValidGroupFolder('/tmp')).toBe(false);
    expect(isValidGroupFolder('global')).toBe(false);
    expect(isValidGroupFolder('')).toBe(false);
  });

  it('resolves safe paths under groups directory', () => {
    const resolved = resolveGroupFolderPath('family-chat');
    expect(resolved.endsWith(`${path.sep}groups${path.sep}family-chat`)).toBe(
      true,
    );
  });

  it('resolves safe paths under data ipc directory', () => {
    const resolved = resolveGroupIpcPath('family-chat');
    expect(
      resolved.endsWith(`${path.sep}data${path.sep}ipc${path.sep}family-chat`),
    ).toBe(true);
  });

  it('encodes and decodes IPC namespace keys for chat JIDs', () => {
    const encoded = encodeIpcNamespaceKey('dc:1234567890');
    expect(encoded).toBe('dc%3A1234567890');
    expect(decodeIpcNamespaceKey(encoded)).toBe('dc:1234567890');
  });

  it('resolves safe IPC paths for chat JIDs', () => {
    const resolved = resolveGroupIpcPathByJid('dc:1234567890');
    expect(
      resolved.endsWith(
        `${path.sep}data${path.sep}ipc${path.sep}dc%3A1234567890`,
      ),
    ).toBe(true);
  });

  it('returns null for invalid encoded IPC namespace keys', () => {
    expect(decodeIpcNamespaceKey('%E0%A4%A')).toBeNull();
  });

  it('throws for unsafe folder names', () => {
    expect(() => resolveGroupFolderPath('../../etc')).toThrow();
    expect(() => resolveGroupIpcPath('/tmp')).toThrow();
  });

  it('throws for invalid chat JID IPC namespace keys', () => {
    expect(() => encodeIpcNamespaceKey('')).toThrow();
  });
});
