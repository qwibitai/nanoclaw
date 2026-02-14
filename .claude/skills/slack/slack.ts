#!/usr/bin/env bun
/**
 * Slack Integration for NanoClaw
 *
 * A standalone TypeScript/Bun script to interact with Slack.
 * Provides CLI interface for reading/sending messages, managing threads.
 *
 * Usage:
 *   bun run slack.ts read --channel C123456 --limit 10
 *   bun run slack.ts send --channel C123456 --text "Hello!"
 *   bun run slack.ts reply --channel C123456 --thread-ts 1234567890.123456 --text "Reply"
 *   bun run slack.ts thread --channel C123456 --thread-ts 1234567890.123456
 */

import { WebClient } from '@slack/web-api';
import { parseArgs } from 'util';

function getClient(): WebClient {
  const token = process.env.SLACK_BOT_TOKEN;
  if (!token) {
    console.error('Error: SLACK_BOT_TOKEN environment variable not set');
    process.exit(1);
  }
  return new WebClient(token);
}

async function readMessages(channel: string, limit: number = 10, oldest?: string) {
  const client = getClient();

  try {
    const result = await client.conversations.history({
      channel,
      limit,
      oldest,
    });

    console.log(JSON.stringify({
      ok: true,
      messages: result.messages,
      has_more: result.has_more,
    }, null, 2));

  } catch (error: any) {
    console.error(JSON.stringify({
      ok: false,
      error: error.message,
    }));
    process.exit(1);
  }
}

async function sendMessage(channel: string, text: string, thread_ts?: string) {
  const client = getClient();

  try {
    const result = await client.chat.postMessage({
      channel,
      text,
      thread_ts,
    });

    console.log(JSON.stringify({
      ok: true,
      ts: result.ts,
      channel: result.channel,
    }, null, 2));

  } catch (error: any) {
    console.error(JSON.stringify({
      ok: false,
      error: error.message,
    }));
    process.exit(1);
  }
}

async function readThread(channel: string, thread_ts: string) {
  const client = getClient();

  try {
    const result = await client.conversations.replies({
      channel,
      ts: thread_ts,
    });

    console.log(JSON.stringify({
      ok: true,
      messages: result.messages,
    }, null, 2));

  } catch (error: any) {
    console.error(JSON.stringify({
      ok: false,
      error: error.message,
    }));
    process.exit(1);
  }
}

async function listChannels() {
  const client = getClient();

  try {
    const result = await client.conversations.list({
      types: 'public_channel,private_channel',
    });

    const channels = result.channels?.map(ch => ({
      id: ch.id,
      name: ch.name,
      is_private: ch.is_private,
      is_member: ch.is_member,
    }));

    console.log(JSON.stringify({
      ok: true,
      channels,
    }, null, 2));

  } catch (error: any) {
    console.error(JSON.stringify({
      ok: false,
      error: error.message,
    }));
    process.exit(1);
  }
}

// CLI argument parsing
const { values, positionals } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    channel: { type: 'string' },
    limit: { type: 'string' },
    oldest: { type: 'string' },
    text: { type: 'string' },
    'thread-ts': { type: 'string' },
  },
  allowPositionals: true,
});

const command = positionals[0];

(async () => {
  switch (command) {
    case 'read':
      if (!values.channel) {
        console.error('Error: --channel is required');
        process.exit(1);
      }
      await readMessages(
        values.channel,
        values.limit ? parseInt(values.limit) : 10,
        values.oldest
      );
      break;

    case 'send':
      if (!values.channel || !values.text) {
        console.error('Error: --channel and --text are required');
        process.exit(1);
      }
      await sendMessage(values.channel, values.text);
      break;

    case 'reply':
      if (!values.channel || !values.text || !values['thread-ts']) {
        console.error('Error: --channel, --text, and --thread-ts are required');
        process.exit(1);
      }
      await sendMessage(values.channel, values.text, values['thread-ts']);
      break;

    case 'thread':
      if (!values.channel || !values['thread-ts']) {
        console.error('Error: --channel and --thread-ts are required');
        process.exit(1);
      }
      await readThread(values.channel, values['thread-ts']);
      break;

    case 'list':
      await listChannels();
      break;

    default:
      console.error(`Unknown command: ${command}`);
      console.error('Available commands: read, send, reply, thread, list');
      process.exit(1);
  }
})();
