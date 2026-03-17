export interface SendResponseDeps {
  sendMessage: (jid: string, text: string) => Promise<void>;
  sendPoolMessage?: (
    jid: string,
    text: string,
    sender: string,
    groupFolder: string,
  ) => Promise<boolean>;
}

/**
 * Send an agent response through the bot pool when available (Telegram only),
 * falling back to direct channel send.
 */
export async function sendResponse(
  jid: string,
  text: string,
  groupFolder: string,
  senderName: string,
  deps: SendResponseDeps,
): Promise<void> {
  // Pool bots only work in group chats (negative Telegram IDs).
  // In private chats, each bot has its own conversation — using a pool bot
  // would reply in a different chat than the one the user messaged.
  const tgChatId = jid.startsWith('tg:') ? jid.slice(3) : '';
  const isTelegramGroup = tgChatId.startsWith('-');
  if (deps.sendPoolMessage && isTelegramGroup) {
    const sent = await deps.sendPoolMessage(jid, text, senderName, groupFolder);
    if (sent) return;
  }
  await deps.sendMessage(jid, text);
}
