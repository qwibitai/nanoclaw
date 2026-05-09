/**
 * Jibrain shared-intake observer.
 *
 * Captures every inbound chat message on a non-confidential messaging group
 * by batching per-{messaging_group, sender} for a quiet window, then exec'ing
 * `~/scripts/nanoclaw-jibrain-hook.sh process <ch> <sender> <merged> <slug>
 * <capture_mode>`. The hook script writes a markdown intake file under
 * `~/jibrain/intake/` (Syncthing-synced).
 *
 * This is the v2 port of the v1 `queueJibrainIntake` flow that lived in
 * `_legacy/v1.2.49/src/index.ts:142-171,1542-1550`. The v1 host invoked the
 * hook directly inside its WhatsApp/Signal/etc. message-receive callback;
 * the 2.0 rewrite dropped that integration entirely. This module restores it
 * via the `setInboundObserver` hook in `src/router.ts`, which fires once a
 * `messaging_groups` row has been resolved (or auto-created) for the event.
 *
 * Skips
 *   - mg.confidential_intake = 1 (sensitive — handled by a separate path)
 *   - event.message.kind !== 'chat' (chat-sdk cards, system events, etc.)
 *   - parsed.fromMe / parsed.isBotMessage
 *   - content text < 20 chars (matches v1 noise threshold)
 *
 * Configuration
 *   - JIBRAIN_HOOK_SCRIPT  (default ~/scripts/nanoclaw-jibrain-hook.sh)
 *   - JIBRAIN_QUIET_MS     (default 180000, i.e. 3 min — matches v1)
 *   - JIBRAIN_DISABLE      (set to '1' to disable the observer entirely)
 *
 * Per-channel state (listening_mode / confidential_intake / capture_mode)
 * lives on `messaging_groups` (migration 015). The YAML→DB backfill at
 * `scripts/backfill-listening-modes.ts` populates these from the legacy
 * `~/switchboard/ops/jibot/channels/*.yaml` files.
 */

import { execFile } from 'child_process';
import os from 'os';
import path from 'path';

import type { InboundEvent } from '../../channels/adapter.js';
import { log } from '../../log.js';
import { setInboundObserver } from '../../router.js';
import type { MessagingGroup } from '../../types.js';

const HOOK_SCRIPT = process.env.JIBRAIN_HOOK_SCRIPT || path.join(os.homedir(), 'scripts/nanoclaw-jibrain-hook.sh');
const QUIET_MS = Number(process.env.JIBRAIN_QUIET_MS) || 3 * 60 * 1000;
const MIN_CONTENT_LEN = 20;

/** Map v2 channel_type → the short prefix the hook script logs against. */
function shortChannel(channelType: string, platformId: string): string {
  // WhatsApp: pass the JID through; the hook script auto-normalizes
  // *@g.us / *@s.whatsapp.net / *@lid → 'wa'.
  if (channelType === 'whatsapp') return platformId;
  // Other platforms: use a stable short prefix that matches what v1 emitted
  // and what the existing intake/.archive/ filenames already use.
  switch (channelType) {
    case 'signal':
      return 'sig';
    case 'discord':
      return 'dc';
    case 'telegram':
      return 'tg';
    case 'slack':
      return 'slack';
    case 'email':
      return 'email';
    case 'imessage':
      return 'imessage';
    case 'matrix':
      return 'matrix';
    case 'linear':
      return 'linear';
    case 'github':
      return 'github';
    default:
      return channelType;
  }
}

interface BatchEntry {
  msgs: string[];
  timer: ReturnType<typeof setTimeout>;
}

const batches = new Map<string, BatchEntry>();

/** Test-only: drop pending batches without firing them. */
export function _resetBatchesForTests(): void {
  for (const b of batches.values()) clearTimeout(b.timer);
  batches.clear();
}

/** Test-only: number of in-flight batches (no introspection of contents). */
export function _batchCountForTests(): number {
  return batches.size;
}

interface ParsedChatContent {
  text?: string;
  sender?: string;
  senderName?: string;
  fromMe?: boolean;
  isBotMessage?: boolean;
}

function safeParseContent(raw: string): ParsedChatContent {
  try {
    const obj = JSON.parse(raw);
    return obj && typeof obj === 'object' ? (obj as ParsedChatContent) : {};
  } catch {
    return { text: raw };
  }
}

function flushBatch(
  key: string,
  ch: string,
  rawSender: string,
  channelSlug: string,
  captureMode: 'standalone' | 'digest',
): void {
  const batch = batches.get(key);
  if (!batch) return;
  batches.delete(key);
  const merged = batch.msgs.join('\n\n---\n\n');
  execFile(
    '/bin/bash',
    [HOOK_SCRIPT, 'process', ch, rawSender, merged, channelSlug, captureMode],
    { timeout: 60_000 },
    (err, _stdout, stderr) => {
      if (err) {
        log.warn('jibrain hook failed', {
          channelSlug,
          ch,
          err: err.message,
          stderr: stderr ? String(stderr).slice(0, 500) : undefined,
        });
      }
    },
  );
}

/**
 * Channel slug resolution. The hook script uses this to name digest files
 * and tag intake markdown frontmatter. v1 derived it from the in-process
 * RegisteredGroup.folder field; v2 doesn't have a per-mg folder concept,
 * so we synthesize a stable slug from `mg.name` (preferred) with a fallback
 * to a short hash of the platform_id. Special chars normalized.
 */
function resolveChannelSlug(mg: MessagingGroup): string {
  const base = mg.name && mg.name.trim() ? mg.name : `mg-${mg.platform_id.slice(0, 12)}`;
  return (
    base
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 64) || 'unknown'
  );
}

export const jibrainIntakeObserver = (event: InboundEvent, mg: MessagingGroup): void => {
  if (process.env.JIBRAIN_DISABLE === '1') return;
  if (event.message.kind !== 'chat') return;
  if (mg.confidential_intake === 1) return;

  const parsed = safeParseContent(event.message.content);
  if (parsed.fromMe) return;
  if (parsed.isBotMessage) return;

  const text = parsed.text;
  if (typeof text !== 'string' || text.trim().length < MIN_CONTENT_LEN) return;

  const sender = parsed.sender || parsed.senderName || 'unknown';
  const ch = shortChannel(event.channelType, event.platformId);
  const channelSlug = resolveChannelSlug(mg);
  const captureMode: 'standalone' | 'digest' = mg.capture_mode === 'digest' ? 'digest' : 'standalone';

  const key = `${mg.id}:${sender}`;
  const existing = batches.get(key);
  if (existing) {
    existing.msgs.push(text);
    clearTimeout(existing.timer);
    existing.timer = setTimeout(() => flushBatch(key, ch, sender, channelSlug, captureMode), QUIET_MS);
    // setTimeout returns a Timeout in Node; unref so a pending batch never
    // blocks shutdown if the host is exiting.
    if (typeof (existing.timer as { unref?: () => void }).unref === 'function') {
      (existing.timer as { unref: () => void }).unref();
    }
    return;
  }
  const timer = setTimeout(() => flushBatch(key, ch, sender, channelSlug, captureMode), QUIET_MS);
  if (typeof (timer as { unref?: () => void }).unref === 'function') {
    (timer as { unref: () => void }).unref();
  }
  batches.set(key, { msgs: [text], timer });
};

setInboundObserver(jibrainIntakeObserver);
