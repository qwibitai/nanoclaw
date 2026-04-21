import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

vi.mock('./logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { processImageIpcFile } from './ipc.js';
import { RegisteredGroup } from './types.js';

const MAIN_GROUP: RegisteredGroup = {
  name: 'Main',
  folder: 'slack_main',
  trigger: '@E',
  added_at: '',
  isMain: true,
};

const SLACK_TEST: RegisteredGroup = {
  name: 'Test',
  folder: 'slack_test',
  trigger: '@E',
  added_at: '',
};

describe('processImageIpcFile', () => {
  let tmpDir: string;
  let groupsDir: string;
  let sendImage: ReturnType<
    typeof vi.fn<
      (jid: string, paths: string[], caption?: string) => Promise<void>
    >
  >;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-ipc-img-'));
    groupsDir = path.join(tmpDir, 'groups');
    fs.mkdirSync(path.join(groupsDir, 'slack_test', 'outbox'), {
      recursive: true,
    });
    fs.mkdirSync(path.join(groupsDir, 'slack_other', 'outbox'), {
      recursive: true,
    });
    fs.mkdirSync(path.join(groupsDir, 'slack_main', 'outbox'), {
      recursive: true,
    });
    sendImage = vi.fn(async () => undefined);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function registered() {
    return {
      'slack:C1': SLACK_TEST,
      'slack:Cmain': MAIN_GROUP,
    };
  }

  it('dispatches sendImage for a valid authorized image IPC payload', async () => {
    const imgPath = path.join(groupsDir, 'slack_test', 'outbox', 'a.png');
    fs.writeFileSync(imgPath, 'PNGDATA');

    await processImageIpcFile(
      {
        type: 'image',
        chatJid: 'slack:C1',
        groupFolder: 'slack_test',
        paths: ['outbox/a.png'],
        caption: 'hello',
      },
      'slack_test',
      false,
      registered(),
      groupsDir,
      sendImage,
    );

    expect(sendImage).toHaveBeenCalledWith('slack:C1', [imgPath], 'hello');
  });

  it('rejects path traversal (../../etc/passwd)', async () => {
    await processImageIpcFile(
      {
        type: 'image',
        chatJid: 'slack:C1',
        groupFolder: 'slack_test',
        paths: ['../../etc/passwd'],
      },
      'slack_test',
      false,
      registered(),
      groupsDir,
      sendImage,
    );

    expect(sendImage).not.toHaveBeenCalled();
  });

  it('blocks cross-group sends for non-main groups', async () => {
    const imgPath = path.join(groupsDir, 'slack_other', 'outbox', 'x.png');
    fs.writeFileSync(imgPath, 'X');

    await processImageIpcFile(
      {
        type: 'image',
        chatJid: 'slack:C1', // belongs to slack_test
        groupFolder: 'slack_other',
        paths: ['outbox/x.png'],
      },
      'slack_other',
      false,
      registered(),
      groupsDir,
      sendImage,
    );

    expect(sendImage).not.toHaveBeenCalled();
  });

  it('allows main group to send to any jid', async () => {
    const imgPath = path.join(groupsDir, 'slack_main', 'outbox', 'x.png');
    fs.writeFileSync(imgPath, 'X');

    await processImageIpcFile(
      {
        type: 'image',
        chatJid: 'slack:C1', // belongs to slack_test, but main is sending
        groupFolder: 'slack_main',
        paths: ['outbox/x.png'],
      },
      'slack_main',
      true, // isMain
      registered(),
      groupsDir,
      sendImage,
    );

    expect(sendImage).toHaveBeenCalledWith('slack:C1', [imgPath], undefined);
  });

  it('skips missing files but delivers surviving ones', async () => {
    const goodPath = path.join(groupsDir, 'slack_test', 'outbox', 'ok.png');
    fs.writeFileSync(goodPath, 'OK');

    await processImageIpcFile(
      {
        type: 'image',
        chatJid: 'slack:C1',
        groupFolder: 'slack_test',
        paths: ['outbox/missing.png', 'outbox/ok.png'],
      },
      'slack_test',
      false,
      registered(),
      groupsDir,
      sendImage,
    );

    expect(sendImage).toHaveBeenCalledWith('slack:C1', [goodPath], undefined);
  });

  it('does not call sendImage when all paths are missing', async () => {
    await processImageIpcFile(
      {
        type: 'image',
        chatJid: 'slack:C1',
        groupFolder: 'slack_test',
        paths: ['outbox/missing1.png', 'outbox/missing2.png'],
      },
      'slack_test',
      false,
      registered(),
      groupsDir,
      sendImage,
    );

    expect(sendImage).not.toHaveBeenCalled();
  });

  it('ignores payloads with missing required fields', async () => {
    await processImageIpcFile(
      { type: 'image' } as unknown as Parameters<typeof processImageIpcFile>[0],
      'slack_test',
      false,
      registered(),
      groupsDir,
      sendImage,
    );

    expect(sendImage).not.toHaveBeenCalled();
  });
});
