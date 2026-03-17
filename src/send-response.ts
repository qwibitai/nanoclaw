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
  if (deps.sendPoolMessage && jid.startsWith('tg:')) {
    const sent = await deps.sendPoolMessage(jid, text, senderName, groupFolder);
    if (sent) return;
  }
  await deps.sendMessage(jid, text);
}
