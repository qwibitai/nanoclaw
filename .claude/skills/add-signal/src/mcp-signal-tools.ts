// Signal MCP tools for the container agent
// Merge into container/agent-runner/src/ipc-mcp-stdio.ts before the stdio transport startup line.
//
// Prerequisites (already available in ipc-mcp-stdio.ts):
//   - server, z, writeIpcFile, TASKS_DIR, MESSAGES_DIR, RESPONSES_DIR, IPC_DIR
//   - path, fs
//   - chatJid / CHAT_JID, chatName, groupFolder, isMain
//
// The updated send_message tool replaces the existing one to support
// timestamp responses (needed for edit/delete).

// -- Updated send_message (replaces existing) --

server.tool(
  'send_message',
  "Send a message to the user or group immediately while you're still running. Returns the message timestamp which can be used with signal_edit_message or signal_delete_message.",
  {
    text: z.string().describe('The message text to send'),
    sender: z.string().optional().describe('Your role/identity name (e.g. "Researcher"). When set, messages appear from a dedicated bot in Telegram.'),
  },
  async (args) => {
    const responseId = `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const data: Record<string, string | undefined> = {
      type: 'message',
      chatJid,
      text: args.text,
      sender: args.sender || undefined,
      groupFolder,
      responseId,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(MESSAGES_DIR, data);

    // Wait for the host to write back the sent message timestamp
    const responsePath = path.join(RESPONSES_DIR, `${responseId}.json`);
    const maxWait = 10000;
    const start = Date.now();
    while (Date.now() - start < maxWait) {
      try {
        const result = fs.readFileSync(responsePath, 'utf-8');
        fs.unlinkSync(responsePath);
        const parsed = JSON.parse(result);
        return { content: [{ type: 'text' as const, text: `Message sent. Timestamp: ${parsed.timestamp}` }] };
      } catch {
        await new Promise((r) => setTimeout(r, 200));
      }
    }
    return { content: [{ type: 'text' as const, text: 'Message sent (timestamp unavailable).' }] };
  },
);

// -- Context tools --

server.tool(
  'get_chat_info',
  'Get metadata about the current chat (name, JID, group folder, whether this is the main channel).',
  {},
  async () => {
    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({ chatJid: CHAT_JID, chatName, groupFolder, isMain }, null, 2),
      }],
    };
  },
);

server.tool(
  'get_recent_messages',
  'Get recent messages in this chat with their sender phone numbers and source timestamps. Use this to find the correct target_author and target_timestamp values for signal_react, signal_remove_reaction, signal_delete_message, and similar tools.',
  {
    limit: z.number().optional().default(20).describe('Number of recent messages to return (default 20, max 50)'),
  },
  async (args) => {
    const file = path.join(IPC_DIR, 'recent_messages.json');
    try {
      const data = JSON.parse(fs.readFileSync(file, 'utf-8'));
      const messages = data.messages.slice(-(args.limit || 20));
      return { content: [{ type: 'text' as const, text: JSON.stringify(messages, null, 2) }] };
    } catch {
      return { content: [{ type: 'text' as const, text: 'No recent messages available.' }] };
    }
  },
);

// -- Signal messaging tools (all groups) --

server.tool(
  'signal_react',
  'React to a Signal message with an emoji. Call get_recent_messages first to look up the correct sender_id and source_timestamp. The host validates these values against the message snapshot and rejects fabricated references.',
  {
    recipient: z.string().default(CHAT_JID).describe('The recipient JID (defaults to current chat)'),
    target_author: z.string().describe('Phone number of the message author (sender_id from get_recent_messages)'),
    target_timestamp: z.number().describe('Numeric millisecond timestamp of the message (source_timestamp from get_recent_messages)'),
    reaction: z.string().describe('Emoji reaction (e.g., "👍")'),
  },
  async (args) => {
    writeIpcFile(TASKS_DIR, {
      type: 'signal_react',
      recipient: args.recipient,
      targetAuthor: args.target_author,
      targetTimestamp: args.target_timestamp,
      reaction: args.reaction,
      chatJid: CHAT_JID,
      timestamp: new Date().toISOString(),
    });
    return { content: [{ type: 'text' as const, text: `Reaction ${args.reaction} sent.` }] };
  },
);

server.tool(
  'signal_remove_reaction',
  'Remove a reaction from a Signal message. Call get_recent_messages first to look up the correct sender_id and source_timestamp. The host validates these values against the message snapshot and rejects fabricated references.',
  {
    recipient: z.string().default(CHAT_JID).describe('The recipient JID (defaults to current chat)'),
    target_author: z.string().describe('Phone number of the message author (sender_id from get_recent_messages)'),
    target_timestamp: z.number().describe('Numeric millisecond timestamp of the message (source_timestamp from get_recent_messages)'),
    reaction: z.string().describe('The emoji reaction to remove'),
  },
  async (args) => {
    writeIpcFile(TASKS_DIR, {
      type: 'signal_remove_reaction',
      recipient: args.recipient,
      targetAuthor: args.target_author,
      targetTimestamp: args.target_timestamp,
      reaction: args.reaction,
      chatJid: CHAT_JID,
      timestamp: new Date().toISOString(),
    });
    return { content: [{ type: 'text' as const, text: `Reaction ${args.reaction} removed.` }] };
  },
);

server.tool(
  'signal_create_poll',
  'Create a poll in a Signal chat.',
  {
    recipient: z.string().default(CHAT_JID).describe('The recipient JID (defaults to current chat)'),
    question: z.string().describe('Poll question'),
    answers: z.array(z.string()).describe('Poll answer options'),
    allow_multiple: z.boolean().default(true).describe('Allow selecting multiple answers'),
  },
  async (args) => {
    writeIpcFile(TASKS_DIR, {
      type: 'signal_create_poll',
      recipient: args.recipient,
      question: args.question,
      answers: args.answers,
      allowMultipleSelections: args.allow_multiple,
      chatJid: CHAT_JID,
      timestamp: new Date().toISOString(),
    });
    return { content: [{ type: 'text' as const, text: `Poll created: ${args.question}` }] };
  },
);

server.tool(
  'signal_close_poll',
  'Close an existing Signal poll. Call get_recent_messages first to find the poll message source_timestamp.',
  {
    recipient: z.string().default(CHAT_JID).describe('The recipient JID (defaults to current chat)'),
    poll_timestamp: z.string().describe('Source timestamp of the poll message (from get_recent_messages)'),
  },
  async (args) => {
    writeIpcFile(TASKS_DIR, {
      type: 'signal_close_poll',
      recipient: args.recipient,
      pollTimestamp: args.poll_timestamp,
      chatJid: CHAT_JID,
      timestamp: new Date().toISOString(),
    });
    return { content: [{ type: 'text' as const, text: 'Poll closed.' }] };
  },
);

server.tool(
  'signal_get_poll_results',
  'Get current vote tallies for Signal polls in this chat. Returns voter names and selected options. Can query a specific poll by timestamp or list all polls. Note: only tracks votes received while NanoClaw is running.',
  {
    poll_timestamp: z.string().optional().describe('Timestamp of a specific poll. Omit to get all polls.'),
    open_only: z.boolean().default(false).describe('If true, only return polls that are still open'),
  },
  async (args) => {
    const responseId = `poll-results-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    writeIpcFile(TASKS_DIR, {
      type: 'signal_get_poll_results',
      pollTimestamp: args.poll_timestamp,
      openOnly: args.open_only,
      chatJid: CHAT_JID,
      responseId,
      timestamp: new Date().toISOString(),
    });

    // Poll for the response file written by the host
    const responsePath = path.join(RESPONSES_DIR, `${responseId}.json`);
    const maxWait = 5000;
    const start = Date.now();
    while (Date.now() - start < maxWait) {
      try {
        const data = fs.readFileSync(responsePath, 'utf-8');
        fs.unlinkSync(responsePath);
        return { content: [{ type: 'text' as const, text: data }] };
      } catch {
        await new Promise((r) => setTimeout(r, 200));
      }
    }
    return { content: [{ type: 'text' as const, text: 'Poll results not available (timeout or no polls tracked).' }], isError: true };
  },
);

server.tool(
  'signal_typing',
  'Set typing indicator on or off in a Signal chat.',
  {
    recipient: z.string().default(CHAT_JID).describe('The recipient JID (defaults to current chat)'),
    is_typing: z.boolean().describe('true to start typing, false to stop'),
  },
  async (args) => {
    writeIpcFile(TASKS_DIR, {
      type: 'signal_typing',
      recipient: args.recipient,
      isTyping: args.is_typing,
      chatJid: CHAT_JID,
      timestamp: new Date().toISOString(),
    });
    return { content: [{ type: 'text' as const, text: args.is_typing ? 'Typing indicator started.' : 'Typing indicator stopped.' }] };
  },
);

server.tool(
  'signal_send_sticker',
  'Send a sticker to a Signal chat.',
  {
    recipient: z.string().default(CHAT_JID).describe('The recipient JID (defaults to current chat)'),
    pack_id: z.string().describe('Sticker pack ID'),
    sticker_id: z.number().describe('Sticker index within the pack'),
  },
  async (args) => {
    writeIpcFile(TASKS_DIR, {
      type: 'signal_send_sticker',
      recipient: args.recipient,
      packId: args.pack_id,
      stickerId: args.sticker_id,
      chatJid: CHAT_JID,
      timestamp: new Date().toISOString(),
    });
    return { content: [{ type: 'text' as const, text: 'Sticker sent.' }] };
  },
);

server.tool(
  'signal_list_sticker_packs',
  'List installed Signal sticker packs.',
  {},
  async () => {
    writeIpcFile(TASKS_DIR, {
      type: 'signal_list_sticker_packs',
      timestamp: new Date().toISOString(),
    });
    return { content: [{ type: 'text' as const, text: 'Sticker pack list requested. Check responses directory.' }] };
  },
);

server.tool(
  'signal_send_receipt',
  'Send a read or viewed receipt for a Signal message. Call get_recent_messages first to look up the correct source_timestamp. The host validates the timestamp exists in the message snapshot and rejects fabricated references.',
  {
    recipient: z.string().default(CHAT_JID).describe('The recipient JID (defaults to current chat)'),
    message_timestamp: z.number().describe('Numeric millisecond timestamp of the message (source_timestamp from get_recent_messages)'),
    receipt_type: z.enum(['read', 'viewed']).default('read').describe('Receipt type'),
  },
  async (args) => {
    writeIpcFile(TASKS_DIR, {
      type: 'signal_send_receipt',
      recipient: args.recipient,
      timestamp: args.message_timestamp,
      receiptType: args.receipt_type,
      chatJid: CHAT_JID,
      submittedAt: new Date().toISOString(),
    });
    return { content: [{ type: 'text' as const, text: 'Receipt sent.' }] };
  },
);

server.tool(
  'signal_delete_message',
  'Delete a Signal message for everyone (remote delete). Call get_recent_messages first to look up the correct source_timestamp. The host validates the timestamp exists as your own message and rejects fabricated references.',
  {
    recipient: z.string().default(CHAT_JID).describe('The recipient JID (defaults to current chat)'),
    message_timestamp: z.number().describe('Numeric millisecond timestamp of the message (source_timestamp from get_recent_messages)'),
  },
  async (args) => {
    writeIpcFile(TASKS_DIR, {
      type: 'signal_delete_message',
      recipient: args.recipient,
      timestamp: args.message_timestamp,
      chatJid: CHAT_JID,
      submittedAt: new Date().toISOString(),
    });
    return { content: [{ type: 'text' as const, text: 'Message deletion requested.' }] };
  },
);

server.tool(
  'signal_edit_message',
  'Edit a previously sent Signal message by replacing its content. Use the timestamp returned by send_message for your own messages, or source_timestamp from get_recent_messages. The host validates the timestamp exists as your own message and rejects fabricated references.',
  {
    recipient: z.string().default(CHAT_JID).describe('The recipient JID (defaults to current chat)'),
    original_timestamp: z.number().describe('Numeric millisecond timestamp of the original message'),
    new_text: z.string().describe('The replacement message text'),
  },
  async (args) => {
    writeIpcFile(TASKS_DIR, {
      type: 'signal_edit_message',
      recipient: args.recipient,
      originalTimestamp: args.original_timestamp,
      newText: args.new_text,
      chatJid: CHAT_JID,
      timestamp: new Date().toISOString(),
    });
    return { content: [{ type: 'text' as const, text: 'Message edit requested.' }] };
  },
);

server.tool(
  'signal_download_attachment',
  'Download an attachment from an inbound Signal message. The attachment ID is provided in the message content as [Image: photo.jpg | id:abc123]. Returns the file path where the attachment was saved.',
  {
    attachment_id: z.string().describe('Attachment ID from the inbound message placeholder'),
    filename: z.string().describe('Filename to save the attachment as'),
  },
  async (args) => {
    const responseId = `attachment-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    writeIpcFile(TASKS_DIR, {
      type: 'signal_download_attachment',
      attachmentId: args.attachment_id,
      filename: args.filename,
      chatJid: CHAT_JID,
      responseId,
      timestamp: new Date().toISOString(),
    });

    const responsePath = path.join(RESPONSES_DIR, path.basename(args.filename));
    const maxWait = 15000;
    const start = Date.now();
    while (Date.now() - start < maxWait) {
      try {
        fs.statSync(responsePath);
        return { content: [{ type: 'text' as const, text: `Attachment saved to ${responsePath}` }] };
      } catch {
        await new Promise((r) => setTimeout(r, 500));
      }
    }
    return { content: [{ type: 'text' as const, text: 'Attachment download timed out.' }], isError: true };
  },
);

server.tool(
  'signal_send_with_preview',
  'Send a Signal message with a rich link preview (title, description, optional thumbnail).',
  {
    recipient: z.string().default(CHAT_JID).describe('The recipient JID (defaults to current chat)'),
    message: z.string().describe('The message text'),
    url: z.string().describe('The URL to preview'),
    title: z.string().optional().describe('Preview title'),
    description: z.string().optional().describe('Preview description'),
    thumbnail_base64: z.string().optional().describe('Base64-encoded thumbnail image'),
  },
  async (args) => {
    writeIpcFile(TASKS_DIR, {
      type: 'signal_send_with_preview',
      recipient: args.recipient,
      message: args.message,
      url: args.url,
      title: args.title,
      description: args.description,
      thumbnailBase64: args.thumbnail_base64,
      chatJid: CHAT_JID,
      timestamp: new Date().toISOString(),
    });
    return { content: [{ type: 'text' as const, text: 'Message with link preview sent.' }] };
  },
);

// -- Admin tools (main channel only) --

server.tool(
  'signal_update_profile',
  'Update the bot\'s Signal profile name or status text. Main group only.',
  {
    name: z.string().optional().describe('Display name (max 26 chars)'),
    about: z.string().optional().describe('Status text (max 140 chars)'),
  },
  async (args) => {
    if (!isMain) {
      return { content: [{ type: 'text' as const, text: 'Only the main group can update the bot profile.' }], isError: true };
    }
    writeIpcFile(TASKS_DIR, {
      type: 'update_signal_profile',
      name: args.name,
      about: args.about,
      timestamp: new Date().toISOString(),
    });
    return { content: [{ type: 'text' as const, text: 'Profile update requested.' }] };
  },
);

server.tool(
  'signal_create_group',
  'Create a new Signal group. Main group only.',
  {
    group_name: z.string().describe('Name for the new group'),
    members: z.array(z.string()).describe('Phone numbers to add (E.164 format)'),
    description: z.string().optional().describe('Group description'),
  },
  async (args) => {
    if (!isMain) {
      return { content: [{ type: 'text' as const, text: 'Only the main group can create Signal groups.' }], isError: true };
    }
    writeIpcFile(TASKS_DIR, {
      type: 'signal_create_group',
      groupName: args.group_name,
      members: args.members,
      description: args.description,
      timestamp: new Date().toISOString(),
    });
    return { content: [{ type: 'text' as const, text: `Group "${args.group_name}" creation requested.` }] };
  },
);
