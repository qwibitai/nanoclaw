import Anthropic from '@anthropic-ai/sdk';
import { readFileSync } from 'fs';
import { join } from 'path';
import { logger } from './logger.js';

interface GroupMessage {
  sender: string;
  content: string;
  timestamp: string;
}

let client: Anthropic | null = null;

function getClient(): Anthropic {
  if (client) return client;

  const credsPath = join(process.env.HOME!, '.claude/.credentials.json');
  const creds = JSON.parse(readFileSync(credsPath, 'utf8'));
  const token = creds.claudeAiOauth.accessToken;

  client = new Anthropic({ apiKey: token });
  return client;
}

/**
 * LLM-based classification gate for group chats.
 * Uses Claude Haiku via the Anthropic SDK to decide if the bot should
 * respond to recent messages. Authenticates using the host's Max
 * subscription OAuth token from ~/.claude/.credentials.json.
 * Fails closed (returns false) on any error.
 */
export async function shouldRespondToGroup(
  messages: GroupMessage[],
  assistantName: string,
): Promise<boolean> {
  const recent = messages.slice(-10);
  if (recent.length === 0) return false;

  const userContent = recent.map((m) => `${m.sender}: ${m.content}`).join('\n');

  try {
    const msg = await getClient().messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 8,
      system:
        `You are ${assistantName}, an AI assistant in a group chat. ` +
        'Decide if you should respond to the recent messages. ' +
        'Respond YES if: (1) you are being addressed directly or indirectly, ' +
        '(2) someone is asking a question you can answer, or ' +
        '(3) you genuinely have something valuable to contribute. ' +
        "Respond NO if the conversation doesn't involve you and you have " +
        "nothing meaningful to add. Reply with ONLY 'YES' or 'NO'.",
      messages: [{ role: 'user', content: userContent }],
    });

    const text =
      msg.content[0].type === 'text' ? msg.content[0].text.trim() : '';
    const shouldRespond = text.toUpperCase().startsWith('YES');

    logger.info(
      { response: text, shouldRespond, messageCount: recent.length },
      'smart-trigger: classification result',
    );

    return shouldRespond;
  } catch (err) {
    // Invalidate client on auth errors so it re-reads credentials
    if (err instanceof Anthropic.AuthenticationError) {
      client = null;
    }
    logger.error({ err }, 'smart-trigger: classification failed');
    return false;
  }
}
