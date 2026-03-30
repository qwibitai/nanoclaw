/**
 * Integration tests for the IPC pipeline — processQueueFile handler.
 *
 * Tests the path from a parsed JSON payload → correct dep method called
 * with the right arguments, covering message routing, file routing,
 * thread ID propagation, group authorization, and edge cases.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { _initTestDatabase, setRegisteredGroup } from './db.js';
import { _processQueueFile, IpcDeps } from './ipc.js';
import { RegisteredGroup } from './types.js';

// --- Test fixtures ---

const MAIN_GROUP: RegisteredGroup = {
  name: 'Main',
  folder: 'whatsapp_main',
  trigger: 'always',
  added_at: '2024-01-01T00:00:00.000Z',
  isMain: true,
};

const OTHER_GROUP: RegisteredGroup = {
  name: 'Other',
  folder: 'other-group',
  trigger: '@Andy',
  added_at: '2024-01-01T00:00:00.000Z',
};

const MAIN_JID = 'main@g.us';
const OTHER_JID = 'other@g.us';

let tmpDir: string;
let deps: IpcDeps;
let groups: Record<string, RegisteredGroup>;

// Spy refs — reset in beforeEach
let sendMessageSpy: ReturnType<typeof vi.fn>;
let sendChannelMessageSpy: ReturnType<typeof vi.fn>;
let sendFileSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  _initTestDatabase();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-ipc-test-'));

  groups = {
    [MAIN_JID]: MAIN_GROUP,
    [OTHER_JID]: OTHER_GROUP,
  };

  setRegisteredGroup(MAIN_JID, MAIN_GROUP);
  setRegisteredGroup(OTHER_JID, OTHER_GROUP);

  sendMessageSpy = vi.fn().mockResolvedValue(undefined);
  sendChannelMessageSpy = vi.fn().mockResolvedValue(undefined);
  sendFileSpy = vi.fn().mockResolvedValue(undefined);

  deps = {
    sendMessage: sendMessageSpy as IpcDeps['sendMessage'],
    sendChannelMessage: sendChannelMessageSpy as IpcDeps['sendChannelMessage'],
    sendFile: sendFileSpy as IpcDeps['sendFile'],
    registeredGroups: () => groups,
    registerGroup: () => {},
    syncGroups: async () => {},
    getAvailableGroups: () => [],
    writeGroupsSnapshot: () => {},
    onTasksChanged: () => {},
  };
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// Helper to call processQueueFile without a real IPC base dir / basePath
// (only needed for send_files which resolves file paths)
async function process(
  data: Record<string, unknown>,
  opts: {
    sourceGroup?: string;
    threadId?: string;
    isMain?: boolean;
    basePath?: string;
  } = {},
): Promise<void> {
  const {
    sourceGroup = OTHER_GROUP.folder,
    threadId = undefined,
    isMain = false,
    basePath = tmpDir,
  } = opts;

  await _processQueueFile(
    data,
    sourceGroup,
    threadId,
    isMain,
    tmpDir, // ipcBaseDir
    basePath,
    deps,
    groups,
  );
}

// ---------------------------------------------------------------------------
// message type
// ---------------------------------------------------------------------------

describe('IPC message routing', () => {
  it('calls sendMessage for authorized message', async () => {
    await process(
      { type: 'message', chatJid: OTHER_JID, text: 'hello' },
      { sourceGroup: OTHER_GROUP.folder },
    );

    expect(sendMessageSpy).toHaveBeenCalledOnce();
    expect(sendMessageSpy).toHaveBeenCalledWith(OTHER_JID, 'hello', undefined);
  });

  it('main group can send message to any group', async () => {
    await process(
      { type: 'message', chatJid: OTHER_JID, text: 'from main' },
      { sourceGroup: MAIN_GROUP.folder, isMain: true },
    );

    expect(sendMessageSpy).toHaveBeenCalledWith(
      OTHER_JID,
      'from main',
      undefined,
    );
  });

  it('non-main group cannot send message to another group', async () => {
    await process(
      { type: 'message', chatJid: MAIN_JID, text: 'unauthorized' },
      { sourceGroup: OTHER_GROUP.folder, isMain: false },
    );

    expect(sendMessageSpy).not.toHaveBeenCalled();
  });

  it('passes thread context ID to sendMessage', async () => {
    await process(
      { type: 'message', chatJid: OTHER_JID, text: 'threaded' },
      { sourceGroup: OTHER_GROUP.folder, threadId: 'ctx-7' },
    );

    expect(sendMessageSpy).toHaveBeenCalledWith(OTHER_JID, 'threaded', 7);
  });

  it('ignores non-ctx threadId (not parsed as context)', async () => {
    await process(
      { type: 'message', chatJid: OTHER_JID, text: 'plain thread' },
      { sourceGroup: OTHER_GROUP.folder, threadId: 'some-other-id' },
    );

    // non-ctx threadId → parseCtxId returns undefined
    expect(sendMessageSpy).toHaveBeenCalledWith(
      OTHER_JID,
      'plain thread',
      undefined,
    );
  });

  it('uses sendChannelMessage for scheduled messages', async () => {
    await process(
      {
        type: 'message',
        chatJid: OTHER_JID,
        text: 'scheduled!',
        isScheduled: 'true',
      },
      { sourceGroup: OTHER_GROUP.folder },
    );

    expect(sendChannelMessageSpy).toHaveBeenCalledWith(OTHER_JID, 'scheduled!');
    expect(sendMessageSpy).not.toHaveBeenCalled();
  });

  it('drops message with missing text field', async () => {
    await process(
      { type: 'message', chatJid: OTHER_JID },
      { sourceGroup: OTHER_GROUP.folder },
    );

    expect(sendMessageSpy).not.toHaveBeenCalled();
  });

  it('drops message with missing chatJid field', async () => {
    await process(
      { type: 'message', text: 'no jid' },
      { sourceGroup: OTHER_GROUP.folder },
    );

    expect(sendMessageSpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// send_files type
// ---------------------------------------------------------------------------

describe('IPC send_files routing', () => {
  // Helper: write a file inside tmpDir/queue/ and return its /workspace/ipc/ path.
  // handleIpcFiles resolves /workspace/ipc/... paths relative to basePath.
  function writeIpcFile(name: string, content = 'data'): string {
    const queueDir = path.join(tmpDir, 'queue');
    fs.mkdirSync(queueDir, { recursive: true });
    fs.writeFileSync(path.join(queueDir, name), content);
    return `/workspace/ipc/queue/${name}`;
  }

  it('calls sendFile for authorized send_files with a real file', async () => {
    const containerPath = writeIpcFile('report.png', 'fake-image-data');

    await process(
      {
        type: 'send_files',
        chatJid: OTHER_JID,
        files: [{ path: containerPath, name: 'report.png' }],
        caption: 'Here you go',
      },
      { sourceGroup: OTHER_GROUP.folder, basePath: tmpDir },
    );

    expect(sendFileSpy).toHaveBeenCalledOnce();
    const [jid, files, caption, ctxId] = sendFileSpy.mock.calls[0];
    expect(jid).toBe(OTHER_JID);
    expect(files[0].name).toBe('report.png');
    expect(caption).toBe('Here you go');
    expect(ctxId).toBeUndefined();
  });

  it('passes thread context ID to sendFile', async () => {
    const containerPath = writeIpcFile('chart.png');

    await process(
      {
        type: 'send_files',
        chatJid: OTHER_JID,
        files: [{ path: containerPath, name: 'chart.png' }],
      },
      { sourceGroup: OTHER_GROUP.folder, threadId: 'ctx-42', basePath: tmpDir },
    );

    const [, , , ctxId] = sendFileSpy.mock.calls[0];
    expect(ctxId).toBe(42);
  });

  it('blocks non-main group from sending files to another group', async () => {
    const containerPath = writeIpcFile('file.png');

    await process(
      {
        type: 'send_files',
        chatJid: MAIN_JID,
        files: [{ path: containerPath, name: 'file.png' }],
      },
      { sourceGroup: OTHER_GROUP.folder, isMain: false, basePath: tmpDir },
    );

    expect(sendFileSpy).not.toHaveBeenCalled();
  });

  it('blocks send_files when file does not exist', async () => {
    await process(
      {
        type: 'send_files',
        chatJid: OTHER_JID,
        files: [{ path: '/workspace/ipc/queue/ghost.png', name: 'x.png' }],
      },
      { sourceGroup: OTHER_GROUP.folder, basePath: tmpDir },
    );

    expect(sendFileSpy).not.toHaveBeenCalled();
  });

  it('blocks send_files with disallowed extension', async () => {
    const containerPath = writeIpcFile('script.sh', '#!/bin/bash');

    await process(
      {
        type: 'send_files',
        chatJid: OTHER_JID,
        files: [{ path: containerPath, name: 'script.sh' }],
      },
      { sourceGroup: OTHER_GROUP.folder, basePath: tmpDir },
    );

    expect(sendFileSpy).not.toHaveBeenCalled();
  });

  it('blocks send_files when files array is empty', async () => {
    await process(
      { type: 'send_files', chatJid: OTHER_JID, files: [] },
      { sourceGroup: OTHER_GROUP.folder, basePath: tmpDir },
    );

    expect(sendFileSpy).not.toHaveBeenCalled();
  });

  it('blocks send_files when file exceeds 25MB', async () => {
    const queueDir = path.join(tmpDir, 'queue');
    fs.mkdirSync(queueDir, { recursive: true });
    const hostPath = path.join(queueDir, 'huge.png');
    // Write 26MB of data
    const buf = Buffer.alloc(26 * 1024 * 1024, 'x');
    fs.writeFileSync(hostPath, buf);
    const containerPath = '/workspace/ipc/queue/huge.png';

    await process(
      {
        type: 'send_files',
        chatJid: OTHER_JID,
        files: [{ path: containerPath, name: 'huge.png' }],
      },
      { sourceGroup: OTHER_GROUP.folder, basePath: tmpDir },
    );

    expect(sendFileSpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Thread ID parsing
// ---------------------------------------------------------------------------

describe('Thread ID parsing (parseCtxId)', () => {
  it('parses ctx-0 as 0', async () => {
    await process(
      { type: 'message', chatJid: OTHER_JID, text: 'ctx zero' },
      { threadId: 'ctx-0' },
    );
    expect(sendMessageSpy).toHaveBeenCalledWith(OTHER_JID, 'ctx zero', 0);
  });

  it('parses ctx-999 as 999', async () => {
    await process(
      { type: 'message', chatJid: OTHER_JID, text: 'ctx 999' },
      { threadId: 'ctx-999' },
    );
    expect(sendMessageSpy).toHaveBeenCalledWith(OTHER_JID, 'ctx 999', 999);
  });

  it('returns undefined for non-ctx threadId', async () => {
    await process(
      { type: 'message', chatJid: OTHER_JID, text: 'no ctx' },
      { threadId: 'random-id' },
    );
    expect(sendMessageSpy).toHaveBeenCalledWith(OTHER_JID, 'no ctx', undefined);
  });

  it('returns undefined for undefined threadId', async () => {
    await process(
      { type: 'message', chatJid: OTHER_JID, text: 'no thread' },
      { threadId: undefined },
    );
    expect(sendMessageSpy).toHaveBeenCalledWith(
      OTHER_JID,
      'no thread',
      undefined,
    );
  });

  it('returns undefined for malformed ctx id (NaN)', async () => {
    await process(
      { type: 'message', chatJid: OTHER_JID, text: 'bad ctx' },
      { threadId: 'ctx-abc' },
    );
    expect(sendMessageSpy).toHaveBeenCalledWith(
      OTHER_JID,
      'bad ctx',
      undefined,
    );
  });
});

// ---------------------------------------------------------------------------
// Unknown / malformed payloads
// ---------------------------------------------------------------------------

describe('Malformed IPC payloads', () => {
  it('silently ignores unknown type', async () => {
    await process({ type: 'teleport', chatJid: OTHER_JID });
    expect(sendMessageSpy).not.toHaveBeenCalled();
    expect(sendFileSpy).not.toHaveBeenCalled();
  });

  it('silently ignores array payload', async () => {
    await _processQueueFile(
      [] as unknown as Record<string, unknown>,
      OTHER_GROUP.folder,
      undefined,
      false,
      tmpDir,
      tmpDir,
      deps,
      groups,
    );
    expect(sendMessageSpy).not.toHaveBeenCalled();
  });

  it('silently ignores payload without type field', async () => {
    await process({ chatJid: OTHER_JID, text: 'no type' });
    expect(sendMessageSpy).not.toHaveBeenCalled();
  });
});
