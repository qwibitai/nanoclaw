// Voice command integration for reactions
// Allows natural language reaction commands like:
// "React thumbs up to that last message"
// "Mark that message with a bookmark"
// "Remove my reaction"

import { Channel } from './types.js';
import { logger } from './logger.js';

interface ReactionCommand {
  pattern: RegExp;
  emoji: string;
  description: string;
}

// Common reaction commands
const REACTION_COMMANDS: ReactionCommand[] = [
  // Thumbs up/down
  { pattern: /thumbs?\s*up|👍/i, emoji: '👍', description: 'Thumbs up' },
  { pattern: /thumbs?\s*down|👎/i, emoji: '👎', description: 'Thumbs down' },

  // Love/heart
  { pattern: /\b(love|heart|❤️|❤)\b/i, emoji: '❤️', description: 'Heart/love' },
  { pattern: /red\s*heart/i, emoji: '❤️', description: 'Red heart' },

  // Task/productivity
  { pattern: /\b(check|done|complete|finish|✅)\b/i, emoji: '✅', description: 'Check mark' },
  { pattern: /\b(pin|bookmark|save|🔖|📌)\b/i, emoji: '📌', description: 'Pin/bookmark' },
  { pattern: /\b(todo|task|action)\b/i, emoji: '📋', description: 'Todo/task' },
  { pattern: /\b(calendar|schedule|📅)\b/i, emoji: '📅', description: 'Calendar/schedule' },
  { pattern: /\b(important|priority|urgent|🔥|⭐)\b/i, emoji: '⭐', description: 'Important/star' },

  // Acknowledgment
  { pattern: /\b(ok|okay|ack|acknowledge|seen)\b/i, emoji: '👍', description: 'Acknowledged' },
  { pattern: /\b(yes|yep|yeah|correct|right)\b/i, emoji: '✅', description: 'Yes/correct' },
  { pattern: /\b(no|nope|wrong|incorrect)\b/i, emoji: '❌', description: 'No/wrong' },

  // Questions/help
  { pattern: /\b(question|help|confused|❓)\b/i, emoji: '❓', description: 'Question' },
  { pattern: /\b(think|thinking|consider|💭)\b/i, emoji: '💭', description: 'Thinking' },

  // Emotions
  { pattern: /\b(fire|hot|lit|🔥)\b/i, emoji: '🔥', description: 'Fire/hot' },
  { pattern: /\b(celebrate|party|congrats|🎉)\b/i, emoji: '🎉', description: 'Celebration' },
  { pattern: /\b(pray|prayer|tefilla|🙏)\b/i, emoji: '🙏', description: 'Prayer' },
  { pattern: /\b(laugh|lol|funny|😂)\b/i, emoji: '😂', description: 'Laughing' },

  // Jewish-specific
  { pattern: /\b(shabbat|shalom)\b/i, emoji: '🕎', description: 'Menorah' },
  { pattern: /\b(torah|sefer)\b/i, emoji: '📜', description: 'Scroll/Torah' },
  { pattern: /\b(mitz(?:vah|va))\b/i, emoji: '✨', description: 'Mitzvah/sparkles' },
];

/**
 * Parse a message for reaction commands
 * Returns the emoji to react with, or null if no command found
 */
export function parseReactionCommand(message: string): string | null {
  const normalized = message.toLowerCase().trim();

  // Check for explicit reaction patterns
  for (const cmd of REACTION_COMMANDS) {
    if (cmd.pattern.test(normalized)) {
      return cmd.emoji;
    }
  }

  // Check for direct emoji in message
  const emojiMatch = message.match(/[\u{1F300}-\u{1F9FF}]/u);
  if (emojiMatch) {
    return emojiMatch[0];
  }

  return null;
}

/**
 * Check if a message is a reaction command
 * Examples:
 * - "react thumbs up"
 * - "mark that with a bookmark"
 * - "add a heart to that message"
 */
export function isReactionCommand(message: string): boolean {
  const normalized = message.toLowerCase().trim();

  // Common reaction trigger phrases
  const triggers = [
    /^react\s+/i,
    /^add\s+(?:a\s+)?reaction/i,
    /^mark\s+(?:that|this|the\s+last)/i,
    /^put\s+(?:a\s+)?/i,
    /^send\s+(?:a\s+)?/i,
  ];

  return triggers.some(pattern => pattern.test(normalized));
}

/**
 * Process a reaction command and send the appropriate reaction
 */
export async function handleReactionCommand(
  message: string,
  chatJid: string,
  channel: Channel
): Promise<boolean> {
  if (!isReactionCommand(message)) {
    return false;
  }

  const emoji = parseReactionCommand(message);
  if (!emoji) {
    logger.debug({ message }, 'Could not parse emoji from reaction command');
    return false;
  }

  if (!channel.reactToLatestMessage) {
    logger.warn('Channel does not support reactions');
    return false;
  }

  try {
    await channel.reactToLatestMessage(chatJid, emoji);
    logger.info({ chatJid, emoji }, 'Reaction command executed');
    return true;
  } catch (err) {
    logger.error({ err, chatJid, emoji }, 'Failed to execute reaction command');
    return false;
  }
}

/**
 * Get a description of all available reaction commands
 */
export function getReactionCommandsHelp(): string {
  const examples = REACTION_COMMANDS.slice(0, 10)
    .map(cmd => `- "${cmd.description}" -> ${cmd.emoji}`)
    .join('\n');

  return `*Available Reaction Commands:*

You can say things like:
- "React thumbs up to that"
- "Mark that with a bookmark"
- "Add a heart to that message"

Common reactions:
${examples}

You can also use the emoji directly in your command!`;
}
