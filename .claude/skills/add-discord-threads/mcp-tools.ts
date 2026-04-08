/**
 * Discord Thread MCP Tools
 * Appended to container/agent-runner/src/ipc-mcp-stdio.ts
 *
 * These tools allow agents to create and manage Discord threads via IPC.
 * The host side (src/ipc.ts) handles the actual Discord API calls.
 */

// --- Discord Thread Tools ---

const THREAD_RESULTS_DIR = path.join(IPC_DIR, 'thread_results');

async function waitForThreadResult(requestId: string, maxWait = 30000): Promise<Record<string, unknown>> {
  const resultFile = path.join(THREAD_RESULTS_DIR, `${requestId}.json`);
  const pollInterval = 500;
  let elapsed = 0;

  while (elapsed < maxWait) {
    if (fs.existsSync(resultFile)) {
      try {
        const result = JSON.parse(fs.readFileSync(resultFile, 'utf-8'));
        fs.unlinkSync(resultFile);
        return result;
      } catch (err) {
        return { success: false, message: `Failed to read result: ${err}` };
      }
    }
    await new Promise(resolve => setTimeout(resolve, pollInterval));
    elapsed += pollInterval;
  }

  return { success: false, message: 'Request timed out waiting for thread operation result' };
}

server.tool(
  'discord_create_thread',
  `Create a new thread in the current Discord channel. Only works in Discord channels (chatJid starts with "dc:").
Returns the thread ID and JID that can be used for messaging.`,
  {
    name: z.string().max(100).describe('Thread title (max 100 characters)'),
    auto_archive_minutes: z.enum(['60', '1440', '4320', '10080']).optional()
      .describe('Auto-archive after inactivity: 60 (1hr), 1440 (1 day), 4320 (3 days), 10080 (7 days). Default: 1440'),
    initial_message: z.string().optional().describe('Optional first message to post in the thread'),
  },
  async (args) => {
    if (!chatJid.startsWith('dc:')) {
      return {
        content: [{ type: 'text' as const, text: 'discord_create_thread only works in Discord channels (chatJid must start with "dc:").' }],
        isError: true,
      };
    }

    const requestId = `thread-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    const data = {
      type: 'discord_create_thread',
      requestId,
      chatJid,
      name: args.name,
      auto_archive_minutes: args.auto_archive_minutes ? parseInt(args.auto_archive_minutes, 10) : 1440,
      initial_message: args.initial_message,
      groupFolder,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    const result = await waitForThreadResult(requestId);

    if (result.success) {
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ threadId: result.threadId, threadJid: result.threadJid }) }],
      };
    }

    return {
      content: [{ type: 'text' as const, text: `Failed to create thread: ${result.message}` }],
      isError: true,
    };
  },
);

server.tool(
  'discord_manage_thread',
  'Manage an existing Discord thread: archive, unarchive, lock, unlock, or rename.',
  {
    thread_id: z.string().describe('The Discord thread ID'),
    action: z.enum(['archive', 'unarchive', 'lock', 'unlock', 'rename']).describe('Action to perform'),
    name: z.string().max(100).optional().describe('New thread name (required when action is "rename")'),
  },
  async (args) => {
    if (args.action === 'rename' && !args.name) {
      return {
        content: [{ type: 'text' as const, text: 'The "name" parameter is required when action is "rename".' }],
        isError: true,
      };
    }

    const requestId = `thread-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    const data: Record<string, string | undefined> = {
      type: 'discord_manage_thread',
      requestId,
      thread_id: args.thread_id,
      action: args.action,
      groupFolder,
      timestamp: new Date().toISOString(),
    };
    if (args.name) data.name = args.name;

    writeIpcFile(TASKS_DIR, data);

    const result = await waitForThreadResult(requestId);

    if (result.success) {
      return {
        content: [{ type: 'text' as const, text: `Thread ${args.action} successful.` }],
      };
    }

    return {
      content: [{ type: 'text' as const, text: `Failed to ${args.action} thread: ${result.message}` }],
      isError: true,
    };
  },
);
