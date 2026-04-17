import { sendTelegramMessage } from '../channels/telegram.js';

export interface PushAttentionInput {
  chatId: string;
  itemId: string;
  title: string;
  reason: string;
  sender: string;
}

/**
 * Post a per-email attention message to Telegram with inline action buttons.
 * Button callback_data strings match the handlers registered by the
 * triage callback router (snooze 1h/tomorrow, dismiss, archive, override).
 */
export async function pushAttentionItem(
  input: PushAttentionInput,
): Promise<void> {
  const text = `📌 *${input.title}*\nfrom: ${input.sender}\nreason: ${input.reason}`;

  // Single row of four compact actions. "Move to archive queue" was dropped
  // — its learning signal (negative override) is now what Archive records
  // by default when clicked from an attention card, since an archive action
  // on a classifier-escalated item IS the classifier being wrong.
  const keyboard = [
    [
      { text: '⏰ 1h', callback_data: `triage:snooze:1h:${input.itemId}` },
      {
        text: '⏰ Tomorrow',
        callback_data: `triage:snooze:tomorrow:${input.itemId}`,
      },
      { text: '✕ Dismiss', callback_data: `triage:dismiss:${input.itemId}` },
      { text: '🗃 Archive', callback_data: `triage:archive:${input.itemId}` },
    ],
  ];

  await sendTelegramMessage(input.chatId, text, {
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: keyboard },
  });
}
