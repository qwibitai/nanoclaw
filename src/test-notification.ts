#!/usr/bin/env node
/**
 * nanoclaw-test-notification — send a test notification through Telegram.
 *
 * Usage:
 *   nanoclaw-test-notification <type> [message]
 *
 * Types:
 *   task-complete     Simulates a task-complete notification
 *   sprint-complete   Simulates a sprint-complete notification
 *   custom            Sends a custom message (message argument required)
 *
 * All messages are prefixed with [TEST] and sent to the main/CEO Telegram chat.
 * Ephemeral: no database writes, no side effects.
 */
import path from 'path';

import { Api } from 'grammy';

import { readEnvFile } from './env.js';

// --- Types ---

export const VALID_TYPES = [
  'task-complete',
  'sprint-complete',
  'custom',
] as const;
export type NotificationType = (typeof VALID_TYPES)[number];

// --- Message templates ---

export function buildMessage(
  type: NotificationType,
  customMessage?: string,
): string {
  switch (type) {
    case 'task-complete':
      return '[TEST] Task completed: sample-task-id — "Implement feature X" finished successfully.';
    case 'sprint-complete':
      return '[TEST] Sprint completed: Sprint 42 — all tasks delivered. Ready for retrospective.';
    case 'custom':
      return `[TEST] ${customMessage}`;
  }
}

// --- Resolve Telegram target ---

export interface TelegramTarget {
  chatId: string;
  label: string;
}

/**
 * Find the main or CEO chat JID from the registered_groups table.
 * Opens the SQLite DB read-only so we never write anything.
 */
export async function findTelegramTarget(
  storeDir: string,
): Promise<TelegramTarget | null> {
  const Database = (await import('better-sqlite3')).default;
  const dbPath = path.join(storeDir, 'messages.db');

  let db;
  try {
    db = new Database(dbPath, { readonly: true });
  } catch {
    return null;
  }

  try {
    // Prefer explicit main group
    const mainRow = db
      .prepare(
        "SELECT jid, name FROM registered_groups WHERE is_main = 1 AND jid LIKE 'tg:%' LIMIT 1",
      )
      .get() as { jid: string; name: string } | undefined;

    if (mainRow) {
      return { chatId: mainRow.jid.replace(/^tg:/, ''), label: mainRow.name };
    }

    // Fall back to CEO group
    const ceoRow = db
      .prepare(
        "SELECT jid, name FROM registered_groups WHERE folder = 'ceo' AND jid LIKE 'tg:%' LIMIT 1",
      )
      .get() as { jid: string; name: string } | undefined;

    if (ceoRow) {
      return { chatId: ceoRow.jid.replace(/^tg:/, ''), label: ceoRow.name };
    }

    // Fall back to any Telegram group
    const anyRow = db
      .prepare(
        "SELECT jid, name FROM registered_groups WHERE jid LIKE 'tg:%' LIMIT 1",
      )
      .get() as { jid: string; name: string } | undefined;

    if (anyRow) {
      return { chatId: anyRow.jid.replace(/^tg:/, ''), label: anyRow.name };
    }

    return null;
  } finally {
    db.close();
  }
}

// --- CLI argument parsing ---

export interface ParsedArgs {
  type: NotificationType;
  customMessage: string | undefined;
  chatIdOverride: string | null;
  showHelp: boolean;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const args = argv.slice(2);

  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    return {
      type: 'custom',
      customMessage: undefined,
      chatIdOverride: null,
      showHelp: true,
    };
  }

  const type = args[0] as NotificationType;

  let chatIdOverride: string | null = null;
  const positionalArgs: string[] = [];

  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--chat-id' && i + 1 < args.length) {
      chatIdOverride = args[++i];
    } else {
      positionalArgs.push(args[i]);
    }
  }

  return {
    type,
    customMessage: positionalArgs.join(' ') || undefined,
    chatIdOverride,
    showHelp: false,
  };
}

// --- Main ---

const HELP_TEXT = `Usage: nanoclaw-test-notification <type> [message]

Types:
  task-complete     Simulates a task-complete notification
  sprint-complete   Simulates a sprint-complete notification
  custom            Sends a custom test message (message argument required)

Options:
  --chat-id <id>    Override the target Telegram chat ID
  --help, -h        Show this help message`;

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv);

  if (parsed.showHelp) {
    console.log(HELP_TEXT);
    process.exit(0);
  }

  if (!VALID_TYPES.includes(parsed.type)) {
    console.error(
      `Error: Unknown type "${parsed.type}". Valid types: ${VALID_TYPES.join(', ')}`,
    );
    process.exit(1);
  }

  if (parsed.type === 'custom' && !parsed.customMessage) {
    console.error('Error: "custom" type requires a message argument.');
    console.error(
      '  Usage: nanoclaw-test-notification custom "Your message here"',
    );
    process.exit(1);
  }

  // Resolve bot token
  const envVars = readEnvFile(['TELEGRAM_BOT_TOKEN']);
  const botToken = process.env.TELEGRAM_BOT_TOKEN || envVars.TELEGRAM_BOT_TOKEN;

  if (!botToken) {
    console.error(
      'Error: TELEGRAM_BOT_TOKEN not found in environment or .env file.',
    );
    process.exit(1);
  }

  // Resolve target chat
  let chatId: string;
  let chatLabel: string;

  if (parsed.chatIdOverride) {
    chatId = parsed.chatIdOverride;
    chatLabel = `chat ${chatId}`;
  } else {
    const projectRoot = process.cwd();
    const storeDir = path.resolve(projectRoot, 'store');
    const target = await findTelegramTarget(storeDir);

    if (!target) {
      console.error(
        'Error: No Telegram chat found in registered groups. Use --chat-id to specify one manually.',
      );
      process.exit(1);
    }

    chatId = target.chatId;
    chatLabel = target.label;
  }

  // Build and send the message
  const message = buildMessage(parsed.type, parsed.customMessage);
  const api = new Api(botToken);

  try {
    await api.sendMessage(chatId, message);
    console.log(
      `Sent ${parsed.type} test notification to ${chatLabel}: ${message}`,
    );
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error(`Error sending notification: ${errMsg}`);
    process.exit(1);
  }
}

main();
