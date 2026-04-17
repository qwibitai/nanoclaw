import { Action, Channel, NewMessage, MessageMeta } from './types.js';
import { formatLocalTime } from './timezone.js';
import { classifyMessage } from './message-classifier.js';
import { formatWithMeta } from './message-formatter.js';
import { detectQuestion } from './question-detector.js';
import { detectActions } from './action-detector.js';
import { truncatePreview } from './email-preview.js';
import { MINI_APP_URL } from './config.js';

export function escapeXml(s: string): string {
  if (!s) return '';
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function formatMessages(
  messages: NewMessage[],
  timezone: string,
): string {
  const lines = messages.map((m) => {
    const displayTime = formatLocalTime(m.timestamp, timezone);
    const replyAttr = m.reply_to_message_id
      ? ` reply_to="${escapeXml(m.reply_to_message_id)}"`
      : '';
    const replySnippet =
      m.reply_to_message_content && m.reply_to_sender_name
        ? `\n  <quoted_message from="${escapeXml(m.reply_to_sender_name)}">${escapeXml(m.reply_to_message_content)}</quoted_message>`
        : '';
    return `<message sender="${escapeXml(m.sender_name)}" time="${escapeXml(displayTime)}"${replyAttr}>${replySnippet}${escapeXml(m.content)}</message>`;
  });

  const header = `<context timezone="${escapeXml(timezone)}" />\n`;

  return `${header}<messages>\n${lines.join('\n')}\n</messages>`;
}

export function stripInternalTags(text: string): string {
  return text.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();
}

/**
 * Normalize confidence markers in agent output for channel delivery.
 *
 * The agent emits:
 *   ✓ Verified: ...  — KNOWN fact with a source
 *   ~ Unverified: ... — REMEMBERED claim
 *   ? Unknown: ...   — unconfirmed claim
 *
 * For channels that support Unicode (WhatsApp, Telegram, Signal, Discord),
 * the markers pass through unchanged. For plain-text channels, map to text.
 */
export function normalizeConfidenceMarkers(
  text: string,
  plainText: boolean = false,
): string {
  if (!plainText) return text;
  return text
    .replace(/^✓ Verified:/gm, '[confirmed]')
    .replace(/^~ Unverified:/gm, '[from memory]')
    .replace(/^\? Unknown:/gm, '[uncertain]');
}

export interface ConfidenceAnnotation {
  claim: string;
  confidence: 'verified' | 'unverified' | 'unknown';
  source?: string;
}

export function addConfidenceMarkers(
  text: string,
  annotations: ConfidenceAnnotation[],
): string {
  if (annotations.length === 0) return text;

  const footnotes: string[] = [];
  for (const ann of annotations) {
    const marker =
      ann.confidence === 'verified'
        ? '✓'
        : ann.confidence === 'unverified'
          ? '?'
          : '~';
    const sourceInfo = ann.source ? ` (${ann.source})` : '';
    footnotes.push(`${marker} ${ann.claim}${sourceInfo}`);
  }

  return text + '\n\n' + footnotes.join('\n');
}

export function formatOutbound(
  rawText: string,
  plainText: boolean = false,
): string {
  const text = stripInternalTags(rawText);
  if (!text) return '';
  return normalizeConfidenceMarkers(text, plainText);
}

export function routeOutbound(
  channels: Channel[],
  jid: string,
  text: string,
): Promise<void> {
  const channel = channels.find((c) => c.ownsJid(jid) && c.isConnected());
  if (!channel) throw new Error(`No channel for JID: ${jid}`);
  return channel.sendMessage(jid, text);
}

export function findChannel(
  channels: Channel[],
  jid: string,
): Channel | undefined {
  return channels.find((c) => c.ownsJid(jid));
}

export interface ClassifiedMessage {
  text: string;
  meta: MessageMeta;
}

/**
 * Full classification + formatting pipeline.
 * Classifies the message, detects questions, formats with category prefix.
 */
export function classifyAndFormat(
  rawText: string,
  opts: { gmailOpsAvailable?: boolean } = {},
): ClassifiedMessage {
  const gmailOpsAvailable = opts.gmailOpsAvailable ?? true;
  const text = stripInternalTags(rawText);
  if (!text)
    return {
      text: '',
      meta: {
        category: 'auto-handled',
        urgency: 'info',
        actions: [],
        batchable: true,
      },
    };

  const meta = classifyMessage(text);

  // Detect actionable items (forward, RSVP, open URL) — takes priority over generic questions
  const detectedActions = detectActions(text, meta);
  if (detectedActions.length > 0) {
    const actionButtons = detectedActions.flatMap((a) => a.actions);
    meta.actions = [...meta.actions, ...actionButtons];
  } else {
    // Fall back to generic question detection only if no specific actions found
    const question = detectQuestion(text);
    if (question) {
      meta.questionType = question.type;
      meta.questionId = question.questionId;
      meta.actions = [...meta.actions, ...question.actions];
    }
  }

  let displayText = text;

  // Email: attach action buttons (Full Email always, Expand only for long bodies)
  if (meta.category === 'email') {
    const accountMatch = text.match(/\[Email(?:\s*\[(\w+)\])?\s+from\s/);
    const account = accountMatch?.[1] || '';

    const bodyStart = text.indexOf('\n\n');
    if (bodyStart !== -1 && text.length - bodyStart > 302) {
      const header = text.slice(0, bodyStart + 2);
      const body = text.slice(bodyStart + 2);
      displayText = header + truncatePreview(body, 300);

      if (meta.emailId && gmailOpsAvailable) {
        meta.actions.push({
          label: '📧 Expand',
          callbackData: `expand:${meta.emailId}:${account}`,
          style: 'secondary' as const,
        });
      }
    }

    // Full Email works via Mini App URL even without Gmail channel;
    // Archive requires Gmail channel to be registered.
    if (meta.emailId) {
      if (MINI_APP_URL) {
        const fullUrl = `${MINI_APP_URL}/email/${meta.emailId}${account ? `?account=${account}` : ''}`;
        meta.actions.push({
          label: '🌐 Full Email',
          callbackData: `noop:${meta.emailId}`,
          style: 'secondary' as const,
          webAppUrl: fullUrl,
        });
      }
      if (gmailOpsAvailable) {
        meta.actions.push({
          label: '🗄 Archive',
          callbackData: `archive:${meta.emailId}`,
          style: 'secondary' as const,
        });
      }
    }
  }

  const formatted = formatWithMeta(displayText, meta);
  return { text: formatted, meta };
}
