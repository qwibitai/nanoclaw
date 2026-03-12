# Add Discord File Sending

Adds `sendFile` implementation to the Discord channel so the agent can send file attachments (screenshots, generated code, PDFs, etc.) as Discord message attachments.

## Prerequisites

- Discord channel must already be set up (`src/channels/discord.ts` exists)
- Core file-sending infrastructure must be in place (`sendFile?` on Channel interface in `src/types.ts`, IPC file handling in `src/ipc.ts`)

## Implementation

Add the `sendFile` method to the `DiscordChannel` class in `src/channels/discord.ts`.

### Step 1: Add `fs` import

Add `import fs from 'fs';` at the top of `src/channels/discord.ts` (if not already imported).

### Step 2: Add `sendFile` method

Add this method to the `DiscordChannel` class, after the existing `sendMessage` method:

```typescript
async sendFile(jid: string, text: string, filePaths: string[]): Promise<void> {
  if (!this.client) {
    logger.warn('Discord client not initialized');
    return;
  }

  try {
    const channelId = jid.replace(/^dc:/, '');
    const channel = await this.client.channels.fetch(channelId);

    if (!channel || !('send' in channel)) {
      logger.warn({ jid }, 'Discord channel not found or not text-based');
      return;
    }

    const textChannel = channel as TextChannel;
    const MAX_FILE_SIZE = 25 * 1024 * 1024; // 25MB Discord limit
    const MAX_FILES_PER_MESSAGE = 10;

    // Filter to valid, existing files under size limit
    const validFiles: string[] = [];
    for (const filePath of filePaths) {
      if (!fs.existsSync(filePath)) {
        logger.warn({ filePath }, 'Discord sendFile: file not found, skipping');
        continue;
      }
      const stat = fs.statSync(filePath);
      if (stat.size > MAX_FILE_SIZE) {
        logger.warn({ filePath, size: stat.size }, 'Discord sendFile: file exceeds 25MB limit, skipping');
        continue;
      }
      validFiles.push(filePath);
    }

    if (validFiles.length === 0) {
      // No valid files — fall back to text-only
      if (text) {
        await this.sendMessage(jid, text);
      }
      return;
    }

    // Batch files (Discord allows max 10 per message)
    for (let i = 0; i < validFiles.length; i += MAX_FILES_PER_MESSAGE) {
      const batch = validFiles.slice(i, i + MAX_FILES_PER_MESSAGE);
      const isFirstBatch = i === 0;

      await textChannel.send({
        content: isFirstBatch && text ? text : undefined,
        files: batch,
      });
    }

    logger.info({ jid, fileCount: validFiles.length }, 'Discord file message sent');
  } catch (err) {
    logger.error({ jid, err }, 'Failed to send Discord file message');
  }
}
```

### Step 3: Add tests

Add these tests to `src/channels/discord.test.ts` in a new `describe('sendFile', ...)` block:

```typescript
describe('sendFile', () => {
  it('sends single file with text', async () => {
    const opts = createTestOpts();
    const channel = new DiscordChannel('test-token', opts);
    await channel.connect();

    const mockChannel = {
      send: vi.fn().mockResolvedValue(undefined),
      sendTyping: vi.fn(),
    };
    currentClient().channels.fetch.mockResolvedValue(mockChannel);

    // Create a temp file
    const tmpFile = path.join(os.tmpdir(), `test-${Date.now()}.txt`);
    fs.writeFileSync(tmpFile, 'test content');

    try {
      await channel.sendFile('dc:1234567890123456', 'Here is the file', [tmpFile]);
      expect(mockChannel.send).toHaveBeenCalledWith({
        content: 'Here is the file',
        files: [tmpFile],
      });
    } finally {
      fs.unlinkSync(tmpFile);
    }
  });

  it('sends file without text', async () => {
    const opts = createTestOpts();
    const channel = new DiscordChannel('test-token', opts);
    await channel.connect();

    const mockChannel = {
      send: vi.fn().mockResolvedValue(undefined),
      sendTyping: vi.fn(),
    };
    currentClient().channels.fetch.mockResolvedValue(mockChannel);

    const tmpFile = path.join(os.tmpdir(), `test-${Date.now()}.txt`);
    fs.writeFileSync(tmpFile, 'test');

    try {
      await channel.sendFile('dc:1234567890123456', '', [tmpFile]);
      expect(mockChannel.send).toHaveBeenCalledWith({
        content: undefined,
        files: [tmpFile],
      });
    } finally {
      fs.unlinkSync(tmpFile);
    }
  });

  it('skips missing files, falls back to text-only', async () => {
    const opts = createTestOpts();
    const channel = new DiscordChannel('test-token', opts);
    await channel.connect();

    const mockChannel = {
      send: vi.fn().mockResolvedValue(undefined),
      sendTyping: vi.fn(),
    };
    currentClient().channels.fetch.mockResolvedValue(mockChannel);

    await channel.sendFile('dc:1234567890123456', 'fallback text', ['/nonexistent/file.png']);

    // Should fall back to sendMessage (text-only) since file doesn't exist
    // The send call comes from sendMessage's path
    expect(mockChannel.send).toHaveBeenCalledWith('fallback text');
  });

  it('does nothing when client is null', async () => {
    const opts = createTestOpts();
    const channel = new DiscordChannel('test-token', opts);
    // Don't connect
    await channel.sendFile('dc:1234567890123456', 'text', ['/some/file.png']);
    // No error
  });
});
```

Note: Add `import fs from 'fs';`, `import os from 'os';`, and `import path from 'path';` at the top of the test file if not already present.

## Verification

1. `npm run build` — clean compile
2. `npx vitest run src/channels/discord.test.ts` — Discord tests pass
3. `./container/build.sh` — rebuild container
4. `cp container/agent-runner/src/*.ts data/sessions/discord_main/agent-runner-src/` — sync
5. `launchctl kickstart -k gui/$(id -u)/com.nanoclaw` — restart
6. In Discord: "Take a screenshot of example.com and send it to me" — should receive the image as a Discord attachment
