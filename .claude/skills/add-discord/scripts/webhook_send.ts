import { WebhookClient, type WebhookMessageCreateOptions } from 'discord.js';

import { formatDiscordError, type SkillResult } from '../lib/types.js';

export interface WebhookInput {
  webhookUrl: string;
  content: string;
  username?: string;
  avatarUrl?: string;
}

export async function sendDiscordWebhook(
  input: WebhookInput,
): Promise<SkillResult> {
  const webhook = new WebhookClient({ url: input.webhookUrl });
  try {
    const options: WebhookMessageCreateOptions = {
      content: input.content.slice(0, 2000),
    };
    if (input.username) options.username = input.username;
    if (input.avatarUrl) options.avatarURL = input.avatarUrl;

    await webhook.send(options);
    return { success: true, message: 'Webhook message sent' };
  } catch (err) {
    return formatDiscordError(err, 'Failed to send webhook');
  } finally {
    webhook.destroy();
  }
}
