#!/usr/bin/env node

/**
 * CLI tool to send messages to the NanoClaw agent.
 *
 * Usage:
 *   bin/send "message"                        # send to main group
 *   bin/send -g work "@Andy check status"     # send to specific group
 *   bin/send -s sddk "progress report"        # custom sender name
 *   sddk check | bin/send -s sddk             # pipe from stdin
 */

import crypto from 'crypto';

import { MAIN_GROUP_FOLDER } from './config.js';
import {
  getAllRegisteredGroups,
  initDatabase,
  storeChatMetadata,
  storeMessageDirect,
} from './db.js';

export interface SendOptions {
  message: string;
  group?: string; // folder name, defaults to MAIN_GROUP_FOLDER
  sender?: string; // defaults to 'cli'
}

export interface SendResult {
  jid: string;
  messageId: string;
  sender: string;
  group: string;
}

/**
 * Core logic: resolve group, insert message, return result.
 * Exported for testing. Assumes initDatabase() has been called.
 */
const VALID_SENDER = /^[a-z0-9_-]+$/;

export function sendMessage(opts: SendOptions): SendResult {
  const folder = opts.group || MAIN_GROUP_FOLDER;
  const sender = opts.sender || 'cli';
  const message = opts.message;

  if (!VALID_SENDER.test(sender)) {
    throw new Error(
      `Invalid sender name "${sender}". Use only lowercase letters, digits, hyphens, and underscores.`,
    );
  }

  if (!message || !message.trim()) {
    throw new Error('Empty message');
  }

  const groups = getAllRegisteredGroups();
  const entry = Object.entries(groups).find(([, g]) => g.folder === folder);
  if (!entry) {
    const available = Object.values(groups)
      .map((g) => g.folder)
      .join(', ');
    throw new Error(
      `No registered group with folder "${folder}". Available: ${available || '(none)'}`,
    );
  }

  const [jid, group] = entry;
  const now = new Date();
  const timestamp = now.toISOString();

  // Ensure chat record exists (FK constraint on messages table)
  storeChatMetadata(jid, timestamp, group.name);
  const messageId = `cli-${sender}-${Math.floor(now.getTime() / 1000)}-${crypto.randomBytes(4).toString('hex')}`;

  storeMessageDirect({
    id: messageId,
    chat_jid: jid,
    sender: `cli:${sender}`,
    sender_name: sender,
    content: message,
    timestamp,
    is_from_me: false,
    is_bot_message: false,
  });

  return { jid, messageId, sender, group: folder };
}

// --- CLI entry point ---

const isDirectRun =
  process.argv[1] &&
  new URL(import.meta.url).pathname ===
    new URL(`file://${process.argv[1]}`).pathname;

if (isDirectRun) {
  const args = process.argv.slice(2);
  let group: string | undefined;
  let sender: string | undefined;
  const messageArgs: string[] = [];

  for (let i = 0; i < args.length; i++) {
    if ((args[i] === '-g' || args[i] === '--group') && i + 1 < args.length) {
      group = args[++i];
    } else if (
      (args[i] === '-s' || args[i] === '--sender') &&
      i + 1 < args.length
    ) {
      sender = args[++i];
    } else if (args[i] === '-h' || args[i] === '--help') {
      console.log('Usage: bin/send [-g group] [-s sender] [message]');
      console.log('       command | bin/send [-g group] [-s sender]');
      console.log('');
      console.log('Options:');
      console.log(
        '  -g, --group <folder>   Target group folder (default: main)',
      );
      console.log('  -s, --sender <name>    Sender name (default: cli)');
      console.log('  -h, --help             Show this help');
      process.exit(0);
    } else {
      messageArgs.push(args[i]);
    }
  }

  let message: string;
  if (messageArgs.length > 0) {
    message = messageArgs.join(' ');
  } else if (!process.stdin.isTTY) {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) {
      chunks.push(chunk as Buffer);
    }
    message = Buffer.concat(chunks).toString('utf-8').trim();
  } else {
    console.error('Usage: bin/send [-g group] [-s sender] [message]');
    console.error('       command | bin/send [-g group] [-s sender]');
    process.exit(1);
  }

  try {
    initDatabase();
    const result = sendMessage({ message, group, sender });
    console.log(
      `Sent to agent (jid=${result.jid}, sender=${result.sender}, id=${result.messageId})`,
    );
  } catch (err: unknown) {
    console.error(`Error: ${(err as Error).message}`);
    process.exit(1);
  }
}
