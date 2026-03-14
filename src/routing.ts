import { createComplaint } from './db.js';
import { RATE_LIMITS } from './filters.js';
import { logger } from './logger.js';
import {
  InboundPipeline,
  OutboundPipeline,
  DedupStage,
  SenderFilter,
  RelevanceGate,
  ErrorSuppressor,
  OutboundRateLimiter,
  OutboundDedup,
  ReplyLoopDetector,
  EscalationDetector,
} from './pipeline/index.js';
import type { InboundMessage } from './pipeline/types.js';
import type { Channel } from './types.js';
import { MAIN_GROUP_FOLDER } from './config.js';
import { getRegisteredGroups } from './registry.js';

// ── Pipeline stats ───────────────────────────────────────────────

let inboundProcessed = 0;
let inboundRejected = 0;
let outboundProcessed = 0;
let outboundSuppressed = 0;

export function getPipelineStats() {
  return { inboundProcessed, inboundRejected, outboundProcessed, outboundSuppressed };
}

// ── Escalation alerting ──────────────────────────────────────────

let escalationAlertFn: ((jid: string, text: string) => Promise<void>) | undefined;

/** Called by bootstrap to wire the alert function after channels are ready. */
export function setEscalationAlert(fn: (jid: string, text: string) => Promise<void>): void {
  escalationAlertFn = fn;
}

function getMainGroupJid(): string | null {
  for (const [jid, group] of Object.entries(getRegisteredGroups())) {
    if (group.folder === MAIN_GROUP_FOLDER) return jid;
  }
  return null;
}

// ── Pipelines (created once, used everywhere) ─────────────────────

const replyLoopDetector = new ReplyLoopDetector();

function categorizeComplaint(matches: string[]): string {
  const joined = matches.join(' ').toLowerCase();
  if (/dispense|vend|open|stuck|jammed/.test(joined)) return 'machine-issue';
  if (/stale|expired|old|gross|moldy/.test(joined)) return 'product-quality';
  if (/charged|money|refund/.test(joined)) return 'payment-dispute';
  if (/lawyer|attorney|sue|bbb/.test(joined)) return 'legal-threat';
  if (/damaged|not working|broke/.test(joined)) return 'equipment-damage';
  return 'general';
}

const escalationDetector = new EscalationDetector((msg, matches) => {
  // Persist complaint to database
  const category = categorizeComplaint(matches);
  try {
    createComplaint({
      customerJid: msg.sender,
      customerName: msg.senderName !== msg.sender ? msg.senderName : undefined,
      channel: msg.channel,
      category,
      matchedPatterns: matches,
      messageSnippet: msg.content.slice(0, 500),
    });
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'Failed to persist complaint');
  }

  // Send WhatsApp alert (existing behavior)
  const mainJid = getMainGroupJid();
  if (mainJid && escalationAlertFn) {
    const alert = `⚠️ *Customer Issue*\n\nFrom: ${msg.sender} (${msg.channel})\nIssue: ${matches.join(', ')}\n\n"${msg.content.slice(0, 300)}"\n\nAndy is responding with standard complaint handling. Check if refund or product pull is needed.`;
    escalationAlertFn(mainJid, alert).catch((err) => {
      logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'Escalation alert failed');
    });
  }
});

const inboundPipeline = new InboundPipeline()
  .add(new SenderFilter())
  .add(new DedupStage())
  .add(new RelevanceGate())
  .add(escalationDetector)
  .add(replyLoopDetector);

const outboundRateLimiter = new OutboundRateLimiter(
  RATE_LIMITS.outbound,
  (jid) => getRegisteredGroups()[jid]?.folder,
  [MAIN_GROUP_FOLDER],
);

const outboundPipeline = new OutboundPipeline()
  .add(new ErrorSuppressor())
  .add(outboundRateLimiter)
  .add(new OutboundDedup());

// ── Channel registry ──────────────────────────────────────────────

const channels: Channel[] = [];

export function getChannels(): Channel[] {
  return channels;
}

export function addChannel(ch: Channel): void {
  channels.push(ch);
}

export function findChannel(jid: string): Channel | undefined {
  return channels.find((ch) => ch.ownsJid(jid));
}

// ── Pipeline gate — channels call this before onMessage ───────────

export function shouldProcessInbound(msg: {
  id: string;
  sender: string;
  content: string;
  channel: string;
  rawHeaders?: string;
  subject?: string;
  chatJid?: string;
}): boolean {
  const inbound: InboundMessage = {
    id: msg.id,
    // chatJid may not be known at filter time (channels resolve it after filtering).
    // Use sender as a surrogate key so downstream stages like ReplyLoopDetector
    // can still track per-conversation state. Callers may pass chatJid if available.
    chatJid: msg.chatJid || msg.sender,
    sender: msg.sender,
    senderName: msg.sender,
    content: msg.content,
    timestamp: '',
    channel: msg.channel as InboundMessage['channel'],
    rawHeaders: msg.rawHeaders,
    subject: msg.subject,
  };
  const verdict = inboundPipeline.process(inbound);
  if (verdict.action === 'pass') {
    inboundProcessed++;
    return true;
  }
  inboundRejected++;
  return false;
}

// ── Outbound routing ──────────────────────────────────────────────

/** Route outbound through the pipeline, then to the correct channel. */
export async function routeOutbound(jid: string, text: string): Promise<void> {
  const ch = findChannel(jid);
  if (!ch) {
    logger.warn({ jid }, 'No channel found for outbound message');
    return;
  }

  const finalText = outboundPipeline.process({
    chatJid: jid,
    text,
    channel: ch.name,
  });

  if (!finalText || !finalText.trim()) {
    logger.warn({ jid }, 'Outbound message empty after pipeline processing — suppressed');
    outboundSuppressed++;
    return;
  }

  // Attempt send with one retry (2s delay) before giving up
  let sent = false;
  try {
    await ch.sendMessage(jid, finalText);
    sent = true;
  } catch (firstErr) {
    logger.warn(
      { jid, channel: ch.name, err: firstErr instanceof Error ? firstErr.message : String(firstErr) },
      'Outbound send failed — retrying in 2s',
    );
    await new Promise((r) => setTimeout(r, 2000));
    try {
      await ch.sendMessage(jid, finalText);
      sent = true;
    } catch (retryErr) {
      logger.error(
        { jid, channel: ch.name, err: retryErr instanceof Error ? retryErr.message : String(retryErr) },
        'Outbound send failed after retry — message dropped',
      );
    }
  }

  if (!sent) return;

  // Only count against rate limit after a successful send
  outboundRateLimiter.recordSend(jid);
  outboundProcessed++;
  replyLoopDetector.recordOutbound(jid);
}
