/**
 * Pure helper: turn the host's (kind, parsed-content, files) inputs into the
 * `OutboundMessage` shape the per-channel adapters consume.
 *
 * The non-trivial part is the attachments lift: the path-based
 * `OutboundAttachment` contract (PR #18) is what the Telegram adapter's
 * `deliver()` loop reads, but the host's delivery loop only knows about
 * `messages_out.content` and the buffer-based `OutboundFile[]`. MCP tools
 * that want to ship a real file (the `baget_send_document_file` deck-send
 * path is the canonical example) embed a path-based attachment array
 * inside `content.attachments`. This helper lifts that array onto the
 * outer `OutboundMessage.attachments` field so the adapter sees it.
 *
 * Without the lift: the MCP tool returns "✅ Sent the deck", the host
 * silently drops the file (Telegram adapter's `extractText(message)`
 * returns null for a file-only message and it returns undefined), and
 * the founder sees an empty reply. That regression is the entire reason
 * this helper exists.
 *
 * Defensive on the input shape: a malformed `attachments` (not an
 * array, missing kind, etc.) is dropped silently here and re-asserted
 * by the per-channel adapter on each entry. Keeping validation per-item
 * preserves the "one bad attachment doesn't kill the whole message"
 * contract (see baget-telegram.ts deliver() loop).
 */
import type { OutboundAttachment, OutboundFile, OutboundMessage } from './adapter.js';

export function buildOutboundMessage(
  kind: string,
  parsedContent: unknown,
  files: OutboundFile[] | undefined,
): OutboundMessage {
  const attachments =
    parsedContent &&
    typeof parsedContent === 'object' &&
    Array.isArray((parsedContent as { attachments?: unknown }).attachments)
      ? ((parsedContent as { attachments: unknown[] }).attachments as OutboundAttachment[])
      : undefined;
  return {
    kind,
    content: parsedContent,
    ...(files ? { files } : {}),
    ...(attachments ? { attachments } : {}),
  };
}
