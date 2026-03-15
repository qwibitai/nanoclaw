#!/usr/bin/env node
/**
 * Proton MCP Server — Phase 1: Mail
 *
 * Connects to Proton Bridge via IMAP/SMTP and exposes mail tools.
 * Bridge handles all authentication, SRP, and PGP decryption transparently.
 */

import fs from 'fs';
import path from 'path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import { getUnread, listMessages, getMessage, searchMessages } from './mail/imap-client.js';
import { sendMessage } from './mail/smtp-client.js';

// --- Config ---

function loadConfig() {
  // Try bridge.json first
  const configPaths = [
    path.join(process.env.HOME || '/home/node', '.proton-mcp', 'bridge.json'),
    '/home/node/.proton-mcp/bridge.json',
  ];

  for (const p of configPaths) {
    if (fs.existsSync(p)) {
      try {
        return JSON.parse(fs.readFileSync(p, 'utf-8'));
      } catch { /* try next */ }
    }
  }

  // Fall back to env vars
  if (process.env.PROTON_BRIDGE_USERNAME && process.env.PROTON_BRIDGE_PASSWORD) {
    return {
      imap_host: process.env.PROTON_BRIDGE_IMAP_HOST || '127.0.0.1',
      imap_port: parseInt(process.env.PROTON_BRIDGE_IMAP_PORT || '1143', 10),
      smtp_host: process.env.PROTON_BRIDGE_SMTP_HOST || '127.0.0.1',
      smtp_port: parseInt(process.env.PROTON_BRIDGE_SMTP_PORT || '1025', 10),
      username: process.env.PROTON_BRIDGE_USERNAME,
      password: process.env.PROTON_BRIDGE_PASSWORD,
    };
  }

  throw new Error(
    'Proton Bridge credentials not found. Create ~/.proton-mcp/bridge.json or set PROTON_BRIDGE_USERNAME and PROTON_BRIDGE_PASSWORD env vars.',
  );
}

// --- MCP Server ---

const server = new McpServer({
  name: 'proton',
  version: '1.0.0',
});

let config;
try {
  config = loadConfig();
} catch (err) {
  // Config will be loaded on first tool call if not available at startup
  config = null;
}

function getConfig() {
  if (!config) {
    config = loadConfig();
  }
  return config;
}

function errorResult(msg) {
  return { content: [{ type: 'text', text: JSON.stringify({ error: msg }) }], isError: true };
}

// --- Tool: get_unread ---
server.tool(
  'mail__get_unread',
  'Get unread emails from Proton Mail inbox',
  {},
  async () => {
    try {
      const result = await getUnread(getConfig());
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    } catch (err) {
      return errorResult(err.message);
    }
  },
);

// --- Tool: list_messages ---
server.tool(
  'mail__list_messages',
  'List recent emails from Proton Mail inbox',
  {
    limit: z.number().min(1).max(50).optional().describe('Number of messages to fetch (default 10)'),
  },
  async (args) => {
    try {
      const result = await listMessages(getConfig(), args.limit || 10);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    } catch (err) {
      return errorResult(err.message);
    }
  },
);

// --- Tool: get_message ---
server.tool(
  'mail__get_message',
  'Get a single email by message ID (sequence number)',
  {
    message_id: z.number().describe('Message sequence number from list_messages'),
  },
  async (args) => {
    try {
      const result = await getMessage(getConfig(), args.message_id);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    } catch (err) {
      return errorResult(err.message);
    }
  },
);

// --- Tool: search_messages ---
server.tool(
  'mail__search_messages',
  'Search emails by keyword in subject and body',
  {
    query: z.string().describe('Search query'),
  },
  async (args) => {
    try {
      const result = await searchMessages(getConfig(), args.query);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    } catch (err) {
      return errorResult(err.message);
    }
  },
);

// --- Tool: send_message ---
server.tool(
  'mail__send_message',
  'Send an email via Proton Mail',
  {
    to: z.string().describe('Recipient email address'),
    subject: z.string().describe('Email subject'),
    body: z.string().describe('Email body (plain text)'),
  },
  async (args) => {
    try {
      const result = await sendMessage(getConfig(), args);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    } catch (err) {
      return errorResult(err.message);
    }
  },
);

// --- Start ---

const transport = new StdioServerTransport();
await server.connect(transport);
