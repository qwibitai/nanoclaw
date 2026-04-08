/**
 * Discord Thread IPC Handlers
 * Appended to src/ipc.ts (bottom of file, after processTaskIpc)
 *
 * These functions handle thread operations received via IPC from container agents.
 * They use discord.js REST API directly (no Client instance needed).
 */

async function handleDiscordCreateThread(
  data: Record<string, unknown>,
  sourceGroup: string,
): Promise<void> {
  const { REST, Routes } = await import('discord.js');
  const { readEnvFile } = await import('./env.js');

  const requestId = data.requestId as string;
  const chatJid = data.chatJid as string;
  const name = data.name as string;
  const autoArchiveMinutes = (data.auto_archive_minutes as number) || 1440;
  const initialMessage = data.initial_message as string | undefined;
  const resultsDir = path.join(DATA_DIR, 'ipc', sourceGroup, 'thread_results');

  fs.mkdirSync(resultsDir, { recursive: true });

  const writeResult = (result: object) => {
    const resultPath = path.join(resultsDir, `${requestId}.json`);
    const tempPath = `${resultPath}.tmp`;
    fs.writeFileSync(tempPath, JSON.stringify(result, null, 2));
    fs.renameSync(tempPath, resultPath);
  };

  try {
    const envVars = readEnvFile(['DISCORD_BOT_TOKEN']);
    const token =
      process.env.DISCORD_BOT_TOKEN || envVars.DISCORD_BOT_TOKEN;
    if (!token) {
      writeResult({
        success: false,
        message: 'DISCORD_BOT_TOKEN not configured',
      });
      return;
    }

    const channelId = chatJid.replace(/^dc:/, '');
    const rest = new REST({ version: '10' }).setToken(token);

    let threadId: string;

    if (initialMessage) {
      const msg = (await rest.post(Routes.channelMessages(channelId), {
        body: { content: initialMessage },
      })) as { id: string };

      const thread = (await rest.post(
        Routes.threads(channelId, msg.id),
        {
          body: {
            name,
            auto_archive_duration: autoArchiveMinutes,
          },
        },
      )) as { id: string };

      threadId = thread.id;
    } else {
      const thread = (await rest.post(Routes.threads(channelId), {
        body: {
          name,
          auto_archive_duration: autoArchiveMinutes,
          type: 11, // PUBLIC_THREAD
        },
      })) as { id: string };

      threadId = thread.id;
    }

    writeResult({
      success: true,
      threadId,
      threadJid: `dc:${threadId}`,
    });

    logger.info(
      { threadId, channelId, sourceGroup },
      'Discord thread created via IPC',
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ err, sourceGroup }, 'Failed to create Discord thread');
    writeResult({ success: false, message });
  }
}

async function handleDiscordManageThread(
  data: Record<string, unknown>,
  sourceGroup: string,
): Promise<void> {
  const { REST, Routes } = await import('discord.js');
  const { readEnvFile } = await import('./env.js');

  const requestId = data.requestId as string;
  const threadId = data.thread_id as string;
  const action = data.action as string;
  const newName = data.name as string | undefined;
  const resultsDir = path.join(
    DATA_DIR,
    'ipc',
    sourceGroup,
    'thread_results',
  );

  fs.mkdirSync(resultsDir, { recursive: true });

  const writeResult = (result: object) => {
    const resultPath = path.join(resultsDir, `${requestId}.json`);
    const tempPath = `${resultPath}.tmp`;
    fs.writeFileSync(tempPath, JSON.stringify(result, null, 2));
    fs.renameSync(tempPath, resultPath);
  };

  try {
    const envVars = readEnvFile(['DISCORD_BOT_TOKEN']);
    const token =
      process.env.DISCORD_BOT_TOKEN || envVars.DISCORD_BOT_TOKEN;
    if (!token) {
      writeResult({
        success: false,
        message: 'DISCORD_BOT_TOKEN not configured',
      });
      return;
    }

    const rest = new REST({ version: '10' }).setToken(token);

    let body: Record<string, unknown>;
    switch (action) {
      case 'archive':
        body = { archived: true };
        break;
      case 'unarchive':
        body = { archived: false };
        break;
      case 'lock':
        body = { locked: true };
        break;
      case 'unlock':
        body = { locked: false };
        break;
      case 'rename':
        body = { name: newName };
        break;
      default:
        writeResult({
          success: false,
          message: `Unknown action: ${action}`,
        });
        return;
    }

    await rest.patch(Routes.channel(threadId), { body });

    writeResult({
      success: true,
      message: `Thread ${action} successful`,
    });
    logger.info(
      { threadId, action, sourceGroup },
      'Discord thread managed via IPC',
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error(
      { err, action, sourceGroup },
      'Failed to manage Discord thread',
    );
    writeResult({ success: false, message });
  }
}
