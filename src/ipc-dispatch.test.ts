import { describe, test, expect, vi, beforeEach } from 'vitest';

import fs from 'fs';

// Mock group-folder to use predictable test paths
vi.mock('./group-folder.js', async (importOriginal) => {
  const original = (await importOriginal()) as Record<string, unknown>;
  return {
    ...original,
    resolveGroupFolderPath: (folder: string) => `/test-groups/${folder}`,
  };
});

import {
  dispatchIpcMessage,
  dispatchIpcImage,
  dispatchIpcDocument,
  IpcDeps,
} from './ipc.js';
import { RegisteredGroup } from './types.js';

const MAIN_GROUP: RegisteredGroup = {
  name: 'Main',
  folder: 'telegram_main',
  trigger: 'always',
  added_at: '2024-01-01T00:00:00.000Z',
  isMain: true,
};

const OTHER_GROUP: RegisteredGroup = {
  name: 'Other',
  folder: 'telegram_other',
  trigger: '@Andy',
  added_at: '2024-01-01T00:00:00.000Z',
};

let groups: Record<string, RegisteredGroup>;
let sendMessage: ReturnType<typeof vi.fn<IpcDeps['sendMessage']>>;
let sendImage: ReturnType<typeof vi.fn<NonNullable<IpcDeps['sendImage']>>>;
let sendDocument: ReturnType<
  typeof vi.fn<NonNullable<IpcDeps['sendDocument']>>
>;
let sendPoolMessage: ReturnType<
  typeof vi.fn<NonNullable<IpcDeps['sendPoolMessage']>>
>;

function makeDeps(
  opts: {
    withPool?: boolean;
    withImage?: boolean;
    withDocument?: boolean;
  } = {},
): IpcDeps {
  return {
    sendMessage,
    sendImage: opts.withImage ? sendImage : undefined,
    sendDocument: opts.withDocument ? sendDocument : undefined,
    sendPoolMessage: opts.withPool ? sendPoolMessage : undefined,
    registeredGroups: () => groups,
    registerGroup: vi.fn(),
    syncGroups: vi.fn(),
    getAvailableGroups: () => [],
    writeGroupsSnapshot: vi.fn(),
  };
}

beforeEach(() => {
  groups = {
    'tg:111': MAIN_GROUP,
    'tg:222': OTHER_GROUP,
  };
  sendMessage = vi.fn().mockResolvedValue(undefined);
  sendImage = vi.fn().mockResolvedValue(undefined);
  sendDocument = vi.fn().mockResolvedValue(undefined);
  sendPoolMessage = vi.fn().mockResolvedValue(true);
});

describe('dispatchIpcMessage', () => {
  // INVARIANT: Messages with sender + pool configured route through sendPoolMessage
  // SUT: dispatchIpcMessage routing branch
  test('routes through pool when sender present and pool configured', async () => {
    const result = await dispatchIpcMessage(
      { chatJid: 'tg:111', text: 'hello', sender: 'Researcher' },
      'telegram_main',
      true,
      makeDeps({ withPool: true }),
    );

    expect(result).toBe('sent');
    expect(sendPoolMessage).toHaveBeenCalledWith(
      'tg:111',
      'hello',
      'Researcher',
      'telegram_main',
    );
    expect(sendMessage).not.toHaveBeenCalled();
  });

  // INVARIANT: Messages without sender always use sendMessage
  // SUT: dispatchIpcMessage fallback path
  test('routes through sendMessage when no sender', async () => {
    const result = await dispatchIpcMessage(
      { chatJid: 'tg:111', text: 'hello' },
      'telegram_main',
      true,
      makeDeps({ withPool: true }),
    );

    expect(result).toBe('sent');
    expect(sendPoolMessage).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledWith('tg:111', 'hello');
  });

  // INVARIANT: When pool is not configured, sender field is ignored
  // SUT: dispatchIpcMessage without sendPoolMessage dep
  test('routes through sendMessage when pool not configured', async () => {
    const result = await dispatchIpcMessage(
      { chatJid: 'tg:111', text: 'hello', sender: 'Researcher' },
      'telegram_main',
      true,
      makeDeps({ withPool: false }),
    );

    expect(result).toBe('sent');
    expect(sendMessage).toHaveBeenCalledWith('tg:111', 'hello');
  });

  // INVARIANT: Pool returning false triggers fallback to sendMessage
  // SUT: dispatchIpcMessage pool-exhausted fallback
  test('falls back to sendMessage when pool returns false', async () => {
    sendPoolMessage.mockResolvedValue(false);

    const result = await dispatchIpcMessage(
      { chatJid: 'tg:111', text: 'hello', sender: 'Researcher' },
      'telegram_main',
      true,
      makeDeps({ withPool: true }),
    );

    expect(result).toBe('sent');
    expect(sendPoolMessage).toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledWith('tg:111', 'hello');
  });

  // INVARIANT: Non-main groups can only send to their own chatJid
  // SUT: dispatchIpcMessage authorization
  test('blocks unauthorized cross-group messages', async () => {
    const result = await dispatchIpcMessage(
      { chatJid: 'tg:111', text: 'sneaky' },
      'telegram_other', // other group trying to send to main's jid
      false,
      makeDeps(),
    );

    expect(result).toBe('unauthorized');
    expect(sendMessage).not.toHaveBeenCalled();
  });

  // INVARIANT: Non-main groups can send to their own chatJid
  // SUT: dispatchIpcMessage authorization for self
  test('allows non-main group to send to own chatJid', async () => {
    const result = await dispatchIpcMessage(
      { chatJid: 'tg:222', text: 'allowed' },
      'telegram_other',
      false,
      makeDeps(),
    );

    expect(result).toBe('sent');
    expect(sendMessage).toHaveBeenCalledWith('tg:222', 'allowed');
  });

  // INVARIANT: Main group can send to any chatJid
  // SUT: dispatchIpcMessage main group privilege
  test('main group can send to any chatJid', async () => {
    const result = await dispatchIpcMessage(
      { chatJid: 'tg:222', text: 'from main' },
      'telegram_main',
      true,
      makeDeps(),
    );

    expect(result).toBe('sent');
    expect(sendMessage).toHaveBeenCalledWith('tg:222', 'from main');
  });
  // INVARIANT: Pool is not used for non-Telegram JIDs even when sender is present
  // SUT: dispatchIpcMessage tg: prefix guard
  test('does not use pool for non-telegram JIDs', async () => {
    const result = await dispatchIpcMessage(
      { chatJid: 'wa:123@g.us', text: 'hello', sender: 'Researcher' },
      'telegram_main',
      true,
      makeDeps({ withPool: true }),
    );

    expect(result).toBe('sent');
    expect(sendPoolMessage).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledWith('wa:123@g.us', 'hello');
  });
});

describe('dispatchIpcImage', () => {
  // INVARIANT: Image messages are sent via sendImage when channel supports it
  test('sends image via sendImage when available', async () => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(true);

    const result = await dispatchIpcImage(
      {
        chatJid: 'tg:111',
        imagePath: '/test-groups/telegram_main/output/chart.png',
        caption: 'chart',
      },
      'telegram_main',
      true,
      makeDeps({ withImage: true }),
    );

    expect(result).toBe('sent');
    expect(sendImage).toHaveBeenCalledWith(
      'tg:111',
      '/test-groups/telegram_main/output/chart.png',
      'chart',
    );
    expect(sendMessage).not.toHaveBeenCalled();

    vi.restoreAllMocks();
  });

  // INVARIANT: When sendImage is not available, caption is sent as text
  test('falls back to sendMessage when sendImage not available', async () => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(true);

    const result = await dispatchIpcImage(
      {
        chatJid: 'tg:111',
        imagePath: '/test-groups/telegram_main/output/img.png',
        caption: 'chart',
      },
      'telegram_main',
      true,
      makeDeps({ withImage: false }),
    );

    expect(result).toBe('sent');
    expect(sendMessage).toHaveBeenCalledWith('tg:111', 'chart');

    vi.restoreAllMocks();
  });

  // INVARIANT: When sendImage is not available and no caption, sends default text
  test('sends default text when no sendImage and no caption', async () => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(true);

    const result = await dispatchIpcImage(
      {
        chatJid: 'tg:111',
        imagePath: '/test-groups/telegram_main/output/img.png',
      },
      'telegram_main',
      true,
      makeDeps({ withImage: false }),
    );

    expect(result).toBe('sent');
    expect(sendMessage).toHaveBeenCalledWith(
      'tg:111',
      '(Image sent but channel does not support images)',
    );

    vi.restoreAllMocks();
  });

  // INVARIANT: Container paths are translated to host paths
  test('translates /workspace/group/ container paths to host paths', async () => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(true);

    await dispatchIpcImage(
      {
        chatJid: 'tg:111',
        imagePath: '/workspace/group/output/chart.png',
        caption: 'A chart',
      },
      'telegram_main',
      true,
      makeDeps({ withImage: true }),
    );

    // The path should be translated from container to host
    expect(sendImage).toHaveBeenCalledWith(
      'tg:111',
      expect.stringContaining('telegram_main/output/chart.png'),
      'A chart',
    );

    vi.restoreAllMocks();
  });

  // INVARIANT: Non-main groups cannot send images to other groups
  test('blocks unauthorized cross-group image sends', async () => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(true);

    const result = await dispatchIpcImage(
      { chatJid: 'tg:111', imagePath: '/tmp/img.png' },
      'telegram_other',
      false,
      makeDeps({ withImage: true }),
    );

    expect(result).toBe('unauthorized');
    expect(sendImage).not.toHaveBeenCalled();

    vi.restoreAllMocks();
  });

  // INVARIANT: When image file doesn't exist, falls back to text with error
  test('sends fallback text when image file not found', async () => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(false);

    const result = await dispatchIpcImage(
      {
        chatJid: 'tg:111',
        imagePath: '/test-groups/telegram_main/output/missing.png',
        caption: 'A chart',
      },
      'telegram_main',
      true,
      makeDeps({ withImage: true }),
    );

    expect(result).toBe('sent');
    expect(sendImage).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledWith(
      'tg:111',
      expect.stringContaining('Image not found'),
    );

    vi.restoreAllMocks();
  });

  // INVARIANT: When image file doesn't exist and no caption, user still gets feedback
  test('sends fallback text when image file not found without caption', async () => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(false);

    const result = await dispatchIpcImage(
      {
        chatJid: 'tg:111',
        imagePath: '/test-groups/telegram_main/output/missing.png',
      },
      'telegram_main',
      true,
      makeDeps({ withImage: true }),
    );

    expect(result).toBe('sent');
    expect(sendImage).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledWith(
      'tg:111',
      expect.stringContaining('Image not found'),
    );

    vi.restoreAllMocks();
  });

  // INVARIANT: Path traversal via ../ is blocked
  test('blocks path traversal attempts', async () => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(true);

    const result = await dispatchIpcImage(
      {
        chatJid: 'tg:111',
        imagePath: '/workspace/group/../../.env',
      },
      'telegram_main',
      true,
      makeDeps({ withImage: true }),
    );

    expect(result).toBe('unauthorized');
    expect(sendImage).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();

    vi.restoreAllMocks();
  });
});

describe('dispatchIpcDocument', () => {
  // INVARIANT: Document messages are sent via sendDocument when channel supports it
  test('sends document via sendDocument when available', async () => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(true);

    const result = await dispatchIpcDocument(
      {
        chatJid: 'tg:111',
        documentPath: '/test-groups/telegram_main/output/report.pdf',
        filename: 'report.pdf',
        caption: 'Your report',
      },
      'telegram_main',
      true,
      makeDeps({ withDocument: true }),
    );

    expect(result).toBe('sent');
    expect(sendDocument).toHaveBeenCalledWith(
      'tg:111',
      '/test-groups/telegram_main/output/report.pdf',
      'report.pdf',
      'Your report',
    );
    expect(sendMessage).not.toHaveBeenCalled();

    vi.restoreAllMocks();
  });

  // INVARIANT: When sendDocument is not available, caption is sent as text
  test('falls back to sendMessage when sendDocument not available', async () => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(true);

    const result = await dispatchIpcDocument(
      {
        chatJid: 'tg:111',
        documentPath: '/test-groups/telegram_main/output/report.pdf',
        caption: 'Your report',
      },
      'telegram_main',
      true,
      makeDeps({ withDocument: false }),
    );

    expect(result).toBe('sent');
    expect(sendMessage).toHaveBeenCalledWith('tg:111', 'Your report');

    vi.restoreAllMocks();
  });

  // INVARIANT: When sendDocument is not available and no caption, sends default text
  test('sends default text when no sendDocument and no caption', async () => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(true);

    const result = await dispatchIpcDocument(
      {
        chatJid: 'tg:111',
        documentPath: '/test-groups/telegram_main/output/report.pdf',
      },
      'telegram_main',
      true,
      makeDeps({ withDocument: false }),
    );

    expect(result).toBe('sent');
    expect(sendMessage).toHaveBeenCalledWith(
      'tg:111',
      '(Document sent but channel does not support documents)',
    );

    vi.restoreAllMocks();
  });

  // INVARIANT: Container paths are translated to host paths
  test('translates /workspace/group/ container paths to host paths', async () => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(true);

    await dispatchIpcDocument(
      {
        chatJid: 'tg:111',
        documentPath: '/workspace/group/output/report.pdf',
        filename: 'report.pdf',
        caption: 'A report',
      },
      'telegram_main',
      true,
      makeDeps({ withDocument: true }),
    );

    expect(sendDocument).toHaveBeenCalledWith(
      'tg:111',
      expect.stringContaining('telegram_main/output/report.pdf'),
      'report.pdf',
      'A report',
    );

    vi.restoreAllMocks();
  });

  // INVARIANT: Non-main groups cannot send documents to other groups
  test('blocks unauthorized cross-group document sends', async () => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(true);

    const result = await dispatchIpcDocument(
      { chatJid: 'tg:111', documentPath: '/tmp/doc.pdf' },
      'telegram_other',
      false,
      makeDeps({ withDocument: true }),
    );

    expect(result).toBe('unauthorized');
    expect(sendDocument).not.toHaveBeenCalled();

    vi.restoreAllMocks();
  });

  // INVARIANT: When document file doesn't exist, falls back to text with error
  test('sends fallback text when document file not found', async () => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(false);

    const result = await dispatchIpcDocument(
      {
        chatJid: 'tg:111',
        documentPath: '/test-groups/telegram_main/output/missing.pdf',
        caption: 'A report',
      },
      'telegram_main',
      true,
      makeDeps({ withDocument: true }),
    );

    expect(result).toBe('sent');
    expect(sendDocument).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledWith(
      'tg:111',
      expect.stringContaining('Document not found'),
    );

    vi.restoreAllMocks();
  });

  // INVARIANT: When document file doesn't exist and no caption, user still gets feedback
  test('sends fallback text when document file not found without caption', async () => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(false);

    const result = await dispatchIpcDocument(
      {
        chatJid: 'tg:111',
        documentPath: '/test-groups/telegram_main/output/missing.pdf',
      },
      'telegram_main',
      true,
      makeDeps({ withDocument: true }),
    );

    expect(result).toBe('sent');
    expect(sendDocument).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledWith(
      'tg:111',
      expect.stringContaining('Document not found'),
    );

    vi.restoreAllMocks();
  });

  // INVARIANT: Path traversal via ../ is blocked
  test('blocks path traversal attempts', async () => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(true);

    const result = await dispatchIpcDocument(
      {
        chatJid: 'tg:111',
        documentPath: '/workspace/group/../../.env',
      },
      'telegram_main',
      true,
      makeDeps({ withDocument: true }),
    );

    expect(result).toBe('unauthorized');
    expect(sendDocument).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();

    vi.restoreAllMocks();
  });
});
