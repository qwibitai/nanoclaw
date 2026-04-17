import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { _initTestDatabase, setRegisteredGroup } from '../db.js';
import type { RegisteredGroup } from '../types.js';

import { processMessageFiles } from './message-handler.js';
import type { IpcDeps } from './types.js';

const MAIN: RegisteredGroup = {
  name: 'Main',
  folder: 'main-group',
  trigger: '',
  added_at: '2026-01-01T00:00:00.000Z',
  isMain: true,
};
const CHILD: RegisteredGroup = {
  name: 'Child',
  folder: 'child-group',
  trigger: '@Andy',
  added_at: '2026-01-01T00:00:00.000Z',
};

describe('processMessageFiles', () => {
  let sandbox: string;
  let messagesDir: string;
  let errorsDir: string;
  let sent: Array<[string, string]>;
  let deps: IpcDeps;

  beforeEach(() => {
    _initTestDatabase();
    setRegisteredGroup('main@g.us', MAIN);
    setRegisteredGroup('child@g.us', CHILD);

    sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'msg-handler-'));
    messagesDir = path.join(sandbox, 'messages');
    errorsDir = path.join(sandbox, 'errors');
    fs.mkdirSync(messagesDir, { recursive: true });

    sent = [];
    deps = {
      sendMessage: async (jid, text) => {
        sent.push([jid, text]);
      },
      registeredGroups: () => ({
        'main@g.us': MAIN,
        'child@g.us': CHILD,
      }),
      registerGroup: () => {},
      syncGroups: async () => {},
      getAvailableGroups: () => [],
      writeGroupsSnapshot: () => {},
      onTasksChanged: () => {},
    };
  });

  afterEach(() => {
    fs.rmSync(sandbox, { recursive: true, force: true });
  });

  function dropMessage(payload: object): string {
    const name = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`;
    const p = path.join(messagesDir, name);
    fs.writeFileSync(p, JSON.stringify(payload));
    return p;
  }

  it('delivers an authorized message and removes the file', async () => {
    const p = dropMessage({
      type: 'message',
      chatJid: 'child@g.us',
      text: 'hi',
    });
    await processMessageFiles(
      messagesDir,
      'main-group',
      true,
      deps,
      errorsDir,
    );
    expect(sent).toEqual([['child@g.us', 'hi']]);
    expect(fs.existsSync(p)).toBe(false);
  });

  it('blocks an unauthorized attempt and still removes the file', async () => {
    const p = dropMessage({
      type: 'message',
      chatJid: 'child@g.us',
      text: 'blocked',
    });
    await processMessageFiles(
      messagesDir,
      'outsider-group',
      false,
      deps,
      errorsDir,
    );
    expect(sent).toEqual([]);
    expect(fs.existsSync(p)).toBe(false);
  });

  it('non-main group can send to itself', async () => {
    dropMessage({
      type: 'message',
      chatJid: 'child@g.us',
      text: 'self',
    });
    await processMessageFiles(
      messagesDir,
      'child-group',
      false,
      deps,
      errorsDir,
    );
    expect(sent).toEqual([['child@g.us', 'self']]);
  });

  it('ignores messages missing required fields (no send, no error)', async () => {
    dropMessage({ type: 'message', chatJid: 'child@g.us' }); // no text
    await processMessageFiles(
      messagesDir,
      'main-group',
      true,
      deps,
      errorsDir,
    );
    expect(sent).toEqual([]);
    expect(fs.readdirSync(messagesDir)).toEqual([]); // still cleaned up
  });

  it('moves malformed JSON to errorsDir', async () => {
    const p = path.join(messagesDir, 'bad.json');
    fs.writeFileSync(p, '{ not-json');
    await processMessageFiles(
      messagesDir,
      'main-group',
      true,
      deps,
      errorsDir,
    );
    expect(fs.existsSync(p)).toBe(false);
    expect(fs.readdirSync(errorsDir)).toHaveLength(1);
  });

  it('is a no-op when the messages directory does not exist', async () => {
    const missingDir = path.join(sandbox, 'not-there');
    await processMessageFiles(
      missingDir,
      'main-group',
      true,
      deps,
      errorsDir,
    );
    expect(sent).toEqual([]);
  });
});
