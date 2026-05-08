/**
 * Core MCP tools: send_message, send_file, edit_message, add_reaction.
 *
 * All outbound tools resolve destinations via the local destination map
 * (see destinations.ts). Agents reference destinations by name; the map
 * translates name → routing tuple. Permission enforcement happens on
 * the host side in delivery.ts via the agent_destinations table.
 */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

import { getCurrentInReplyTo } from '../current-batch.js';
import { awaitDeliveryAck } from '../db/delivery-acks.js';
import { findByName, getAllDestinations } from '../destinations.js';
import { getMessageIdBySeq, getRoutingBySeq, writeMessageOut } from '../db/messages-out.js';
import { getSessionRouting } from '../db/session-routing.js';
import { registerTools } from './server.js';
import type { McpToolDefinition } from './types.js';

// send_file safety constants — mirror v1's ipc-mcp-stdio.ts behavior.
const SEND_FILE_MAX_BYTES = 50 * 1024 * 1024; // Slack's own cap is 1GB but most adapters fail long before
const SEND_FILE_ALLOWED_PREFIXES = [
  '/workspace/agent',
  '/workspace/worktrees',
  '/workspace/extra',
  '/tmp/',
];
const SEND_FILE_ACK_TIMEOUT_MS = 30_000;

// Content-hash dedup for send_file. Browser-driver agents often take
// snapshots of the same rendered page multiple times — without dedup the
// user gets flooded with identical images. Map is per-container, resets
// on restart; that's fine since the dedup window only needs to cover the
// lifespan of a turn-chain on the same topic.
const sentFileHashes = new Map<string, string>();

function isAllowedFilePath(p: string): boolean {
  return SEND_FILE_ALLOWED_PREFIXES.some((prefix) => p === prefix || p.startsWith(prefix));
}

function log(msg: string): void {
  console.error(`[mcp-tools] ${msg}`);
}

function generateId(): string {
  return `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function ok(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

function err(text: string) {
  return { content: [{ type: 'text' as const, text: `Error: ${text}` }], isError: true };
}

function destinationList(): string {
  const all = getAllDestinations();
  if (all.length === 0) return '(none)';
  return all.map((d) => d.name).join(', ');
}

/**
 * Resolve a destination name to routing fields.
 *
 * If `to` is omitted, use the session's default reply routing (channel +
 * thread the conversation is in) — the agent replies in place.
 *
 * If `to` is specified, look up the named destination. If it resolves to
 * the same channel the session is bound to, the session's thread_id is
 * preserved so replies land in the correct thread. Otherwise thread_id
 * is null (a cross-destination send starts a new conversation).
 */
function resolveRouting(
  to: string | undefined,
): { channel_type: string; platform_id: string; thread_id: string | null; resolvedName: string } | { error: string } {
  if (!to) {
    // Default: reply to whatever thread/channel this session is bound to.
    const session = getSessionRouting();
    if (session.channel_type && session.platform_id) {
      return {
        channel_type: session.channel_type,
        platform_id: session.platform_id,
        thread_id: session.thread_id,
        resolvedName: '(current conversation)',
      };
    }
    // No session routing (e.g., agent-shared or internal-only agent) —
    // fall back to the legacy single-destination shortcut.
    const all = getAllDestinations();
    if (all.length === 0) return { error: 'No destinations configured.' };
    if (all.length > 1) {
      return {
        error: `You have multiple destinations — specify "to". Options: ${all.map((d) => d.name).join(', ')}`,
      };
    }
    to = all[0].name;
  }
  const dest = findByName(to);
  if (!dest) return { error: `Unknown destination "${to}". Known: ${destinationList()}` };
  if (dest.type === 'channel') {
    // If the destination is the same channel the session is bound to,
    // preserve the thread_id so replies land in the correct thread.
    const session = getSessionRouting();
    const threadId =
      session.channel_type === dest.channelType && session.platform_id === dest.platformId ? session.thread_id : null;
    return {
      channel_type: dest.channelType!,
      platform_id: dest.platformId!,
      thread_id: threadId,
      resolvedName: to,
    };
  }
  return { channel_type: 'agent', platform_id: dest.agentGroupId!, thread_id: null, resolvedName: to };
}

export const sendMessage: McpToolDefinition = {
  tool: {
    name: 'send_message',
    description: 'Send a message to a named destination. If you have only one destination, you can omit `to`.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        to: {
          type: 'string',
          description: 'Destination name (e.g., "family", "worker-1"). Optional if you have only one destination.',
        },
        text: { type: 'string', description: 'Message content' },
      },
      required: ['text'],
    },
  },
  async handler(args) {
    const text = args.text as string;
    if (!text) return err('text is required');

    const routing = resolveRouting(args.to as string | undefined);
    if ('error' in routing) return err(routing.error);

    const id = generateId();
    const seq = writeMessageOut({
      id,
      in_reply_to: getCurrentInReplyTo(),
      kind: 'chat',
      platform_id: routing.platform_id,
      channel_type: routing.channel_type,
      thread_id: routing.thread_id,
      content: JSON.stringify({ text }),
    });

    log(`send_message: #${seq} → ${routing.resolvedName}`);
    return ok(`Message sent to ${routing.resolvedName} (id: ${seq})`);
  },
};

export const sendFile: McpToolDefinition = {
  tool: {
    name: 'send_file',
    description: 'Send a file to a named destination. If you have only one destination, you can omit `to`.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        to: { type: 'string', description: 'Destination name. Optional if you have only one destination.' },
        path: { type: 'string', description: 'File path (relative to /workspace/agent/ or absolute)' },
        text: { type: 'string', description: 'Optional accompanying message' },
        filename: { type: 'string', description: 'Display name (default: basename of path)' },
      },
      required: ['path'],
    },
  },
  async handler(args) {
    const filePath = args.path as string;
    if (!filePath) return err('path is required');

    const routing = resolveRouting(args.to as string | undefined);
    if ('error' in routing) return err(routing.error);

    const resolvedPath = path.isAbsolute(filePath) ? filePath : path.resolve('/workspace/agent', filePath);
    if (!fs.existsSync(resolvedPath)) return err(`File not found: ${filePath}`);

    // Follow symlinks for the allowlist check so a link inside /workspace
    // pointing to a host-sensitive file can't sneak out via send_file.
    let realPath: string;
    try {
      realPath = fs.realpathSync(resolvedPath);
    } catch {
      return err('Path not allowed for send_file.');
    }
    if (!isAllowedFilePath(realPath)) {
      return err(
        `Path not allowed for send_file. Files must be under ${SEND_FILE_ALLOWED_PREFIXES.join(', ')}.`,
      );
    }

    const stat = fs.statSync(realPath);
    if (stat.size === 0) return err('File is empty.');
    if (stat.size > SEND_FILE_MAX_BYTES) {
      return err(`File too large (${(stat.size / 1024 / 1024).toFixed(1)}MB). Max ${SEND_FILE_MAX_BYTES / 1024 / 1024}MB.`);
    }

    // path.basename strips any traversal in the optional display name.
    const filename = path.basename((args.filename as string) || path.basename(realPath));

    // SHA-256 dedup — browser-driver agents frequently snapshot the same
    // page, producing identical images the user doesn't need twice.
    const fileContent = fs.readFileSync(realPath);
    const contentHash = crypto.createHash('sha256').update(fileContent).digest('hex');
    const prior = sentFileHashes.get(contentHash);
    if (prior) {
      return err(
        `Duplicate content: "${filename}" is identical to previously sent "${prior}". NOT sent. If this is a browser screenshot, the page likely hasn't changed — navigate or wait for re-render, then re-capture.`,
      );
    }

    const id = generateId();
    const outboxDir = path.join('/workspace/outbox', id);
    fs.mkdirSync(outboxDir, { recursive: true });
    fs.writeFileSync(path.join(outboxDir, filename), fileContent);

    writeMessageOut({
      id,
      in_reply_to: getCurrentInReplyTo(),
      kind: 'chat',
      platform_id: routing.platform_id,
      channel_type: routing.channel_type,
      thread_id: routing.thread_id,
      content: JSON.stringify({ text: (args.text as string) || '', files: [filename] }),
    });

    log(`send_file: ${id} → ${routing.resolvedName} (${filename}), awaiting host ack`);

    // Wait for the host to actually deliver. Without this, the agent would
    // report success for Slack uploads that silently failed (missing OAuth
    // scope, size limit, adapter transient error past retry count). v2's
    // host-owned `delivered` table carries the outcome (migration adds the
    // `error` column).
    const ack = await awaitDeliveryAck(id, SEND_FILE_ACK_TIMEOUT_MS);
    if (!ack) {
      // Treat timeout as "sent — delivery unconfirmed". Record the hash
      // anyway so a retry with the same content is deduped.
      sentFileHashes.set(contentHash, filename);
      return ok(
        `File "${filename}" sent to ${routing.resolvedName} (id: ${id}) — delivery unconfirmed (host did not respond within ${SEND_FILE_ACK_TIMEOUT_MS / 1000}s).`,
      );
    }
    if (ack.status === 'delivered') {
      sentFileHashes.set(contentHash, filename);
      return ok(
        `File "${filename}" delivered to ${routing.resolvedName} (id: ${id}${ack.platformMessageId ? `, platform_message_id: ${ack.platformMessageId}` : ''}).`,
      );
    }
    // Failed — surface the host's error to the agent. Do not record the
    // hash: a corrected retry (different file, or after fixing the scope)
    // should be allowed through.
    return err(
      `File upload failed for "${filename}" to ${routing.resolvedName}: ${ack.error ?? 'unknown error'}. The file is staged at ${realPath}.`,
    );
  },
};

export const editMessage: McpToolDefinition = {
  tool: {
    name: 'edit_message',
    description: 'Edit a previously sent message. Targets the same destination the original message was sent to.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        messageId: { type: 'integer', description: 'Message ID (the numeric id shown in messages)' },
        text: { type: 'string', description: 'New message content' },
      },
      required: ['messageId', 'text'],
    },
  },
  async handler(args) {
    const seq = Number(args.messageId);
    const text = args.text as string;
    if (!seq || !text) return err('messageId and text are required');

    const platformId = getMessageIdBySeq(seq);
    if (!platformId) return err(`Message #${seq} not found`);

    const routing = getRoutingBySeq(seq);
    if (!routing || !routing.channel_type || !routing.platform_id) {
      return err(`Cannot determine destination for message #${seq}`);
    }

    const id = generateId();
    writeMessageOut({
      id,
      kind: 'chat',
      platform_id: routing.platform_id,
      channel_type: routing.channel_type,
      thread_id: routing.thread_id,
      content: JSON.stringify({ operation: 'edit', messageId: platformId, text }),
    });

    log(`edit_message: #${seq} → ${platformId}`);
    return ok(`Message edit queued for #${seq}`);
  },
};

export const addReaction: McpToolDefinition = {
  tool: {
    name: 'add_reaction',
    description: 'Add an emoji reaction to a message.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        messageId: { type: 'integer', description: 'Message ID (the numeric id shown in messages)' },
        emoji: { type: 'string', description: 'Emoji name (e.g., thumbs_up, heart, check)' },
      },
      required: ['messageId', 'emoji'],
    },
  },
  async handler(args) {
    const seq = Number(args.messageId);
    const emoji = args.emoji as string;
    if (!seq || !emoji) return err('messageId and emoji are required');

    const platformId = getMessageIdBySeq(seq);
    if (!platformId) return err(`Message #${seq} not found`);

    const routing = getRoutingBySeq(seq);
    if (!routing || !routing.channel_type || !routing.platform_id) {
      return err(`Cannot determine destination for message #${seq}`);
    }

    const id = generateId();
    writeMessageOut({
      id,
      kind: 'chat',
      platform_id: routing.platform_id,
      channel_type: routing.channel_type,
      thread_id: routing.thread_id,
      content: JSON.stringify({ operation: 'reaction', messageId: platformId, emoji }),
    });

    log(`add_reaction: #${seq} → ${emoji} on ${platformId}`);
    return ok(`Reaction queued for #${seq}`);
  },
};

registerTools([sendMessage, sendFile, editMessage, addReaction]);
