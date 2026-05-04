/**
 * SQS poller for outbound WA notifications from rial-platform.
 *
 * Loops `ReceiveMessage(WaitTime=20s)` against `RIAL_WA_NOTIFY_QUEUE_URL`.
 * For each message it parses the event, renders text, sends via the
 * existing channel registry's `sendMessage(jid, text)`, and on success
 * deletes the SQS message. Send-failures leave the message in flight
 * so SQS retries up to its configured `maxReceiveCount`; parse-errors
 * are deleted (poison-pill protection).
 *
 * The AWS SDK's default credential chain handles auth — on the EC2 VM
 * this resolves to the attached IAM role.
 *
 * The loop is structured so it stays alive forever; a clean shutdown
 * is signalled by an AbortSignal.
 */

import {
  DeleteMessageCommand,
  Message,
  ReceiveMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';

import { logger } from '../logger.js';
import { normalisePhone } from './allowlist.js';

/** Minimal channel facade we need from nanoclaw. */
export interface OutboundSender {
  sendMessage(jid: string, text: string): Promise<void>;
}

/** Resolves a wa_phone_e164 to the JID expected by the channel registry. */
export type JidResolver = (waPhoneE164: string) => string | null;

export interface NotifierOptions {
  queueUrl: string;
  region: string;
  /** Resolves a phone to the JID nanoclaw uses for the corresponding channel. */
  resolveJid: JidResolver;
  /** Used to look up the channel that owns the JID. */
  findSender: (jid: string) => OutboundSender | null;
  /** Test injection. */
  client?: SQSClient;
  /** Long-poll wait time. AWS max is 20s. */
  waitTimeSeconds?: number;
  /** Max messages per receive. AWS max is 10. */
  maxMessages?: number;
  /** Visibility timeout for in-flight messages. */
  visibilityTimeoutSeconds?: number;
  /** Hook for tests to observe one full cycle. */
  onCycle?: () => void;
}

interface OtpEvent {
  event: 'wa.outbound.otp_requested';
  data: {
    waPhoneE164: string;
    otpCode: string;
    expiresAt?: string;
  };
}

interface NotificationEvent {
  event: 'wa.outbound.notification_requested';
  data: {
    waPhoneE164: string;
    message: string;
    verificationId?: string;
  };
}

type OutboundEvent = OtpEvent | NotificationEvent;

export function renderEvent(event: OutboundEvent): string {
  if (event.event === 'wa.outbound.otp_requested') {
    return `Your rial. code: ${event.data.otpCode} (5 min)`;
  }
  return event.data.message;
}

function parseEvent(raw: string): OutboundEvent | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const obj = parsed as Record<string, unknown>;
  const event = obj.event;
  const data = obj.data;
  if (!data || typeof data !== 'object') return null;
  const d = data as Record<string, unknown>;
  const phone = typeof d.waPhoneE164 === 'string' ? d.waPhoneE164 : '';
  if (!phone) return null;

  if (event === 'wa.outbound.otp_requested') {
    if (typeof d.otpCode !== 'string' || !d.otpCode) return null;
    return {
      event,
      data: {
        waPhoneE164: phone,
        otpCode: d.otpCode,
        expiresAt: typeof d.expiresAt === 'string' ? d.expiresAt : undefined,
      },
    };
  }
  if (event === 'wa.outbound.notification_requested') {
    if (typeof d.message !== 'string' || !d.message) return null;
    return {
      event,
      data: {
        waPhoneE164: phone,
        message: d.message,
        verificationId:
          typeof d.verificationId === 'string' ? d.verificationId : undefined,
      },
    };
  }
  return null;
}

export class Notifier {
  private readonly client: SQSClient;
  private readonly opts: Required<
    Omit<NotifierOptions, 'client' | 'onCycle'>
  > & { onCycle?: () => void };
  private running = false;
  private abort: AbortController | null = null;

  constructor(opts: NotifierOptions) {
    this.client =
      opts.client ?? new SQSClient({ region: opts.region });
    this.opts = {
      queueUrl: opts.queueUrl,
      region: opts.region,
      resolveJid: opts.resolveJid,
      findSender: opts.findSender,
      waitTimeSeconds: opts.waitTimeSeconds ?? 20,
      maxMessages: opts.maxMessages ?? 10,
      visibilityTimeoutSeconds: opts.visibilityTimeoutSeconds ?? 60,
      onCycle: opts.onCycle,
    };
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.abort = new AbortController();
    logger.info(
      { queueUrl: this.opts.queueUrl },
      'rial-notifier: starting SQS poller',
    );
    void this.loop();
  }

  async stop(): Promise<void> {
    this.running = false;
    this.abort?.abort();
  }

  /** Single iteration — exposed for tests. Returns when one cycle completes. */
  async pollOnce(): Promise<void> {
    let res;
    try {
      res = await this.client.send(
        new ReceiveMessageCommand({
          QueueUrl: this.opts.queueUrl,
          WaitTimeSeconds: this.opts.waitTimeSeconds,
          MaxNumberOfMessages: this.opts.maxMessages,
          VisibilityTimeout: this.opts.visibilityTimeoutSeconds,
        }),
      );
    } catch (err: unknown) {
      logger.error({ err }, 'rial-notifier: ReceiveMessage failed');
      return;
    }

    const messages: Message[] = res.Messages ?? [];
    for (const msg of messages) {
      await this.handleMessage(msg);
    }
  }

  private async handleMessage(msg: Message): Promise<void> {
    const body = msg.Body ?? '';
    const handle = msg.ReceiptHandle;
    if (!handle) {
      logger.warn(
        { messageId: msg.MessageId },
        'rial-notifier: message has no ReceiptHandle, cannot ack',
      );
      return;
    }

    const event = parseEvent(body);
    if (!event) {
      logger.warn(
        { messageId: msg.MessageId, body: body.slice(0, 200) },
        'rial-notifier: unparseable message — deleting (poison pill)',
      );
      await this.deleteMessage(handle).catch((err) =>
        logger.error({ err }, 'rial-notifier: failed to delete poison pill'),
      );
      return;
    }

    const phone = normalisePhone(event.data.waPhoneE164);
    if (!phone) {
      logger.warn(
        { event: event.event },
        'rial-notifier: invalid phone — deleting (poison pill)',
      );
      await this.deleteMessage(handle).catch((err) =>
        logger.error({ err }, 'rial-notifier: failed to delete poison pill'),
      );
      return;
    }

    const jid = this.opts.resolveJid(phone);
    if (!jid) {
      logger.warn(
        { phone },
        'rial-notifier: no JID for phone — leaving in queue for retry',
      );
      return;
    }

    const sender = this.opts.findSender(jid);
    if (!sender) {
      logger.warn(
        { jid },
        'rial-notifier: no channel for JID — leaving in queue for retry',
      );
      return;
    }

    const text = renderEvent(event);
    try {
      await sender.sendMessage(jid, text);
    } catch (err: unknown) {
      logger.error(
        { err, jid, event: event.event },
        'rial-notifier: send failed — leaving in queue for retry',
      );
      return;
    }

    try {
      await this.deleteMessage(handle);
    } catch (err: unknown) {
      logger.error(
        { err, jid, event: event.event },
        'rial-notifier: send succeeded but delete failed — message will redeliver (idempotency advised)',
      );
    }
  }

  private async deleteMessage(receiptHandle: string): Promise<void> {
    await this.client.send(
      new DeleteMessageCommand({
        QueueUrl: this.opts.queueUrl,
        ReceiptHandle: receiptHandle,
      }),
    );
  }

  private async loop(): Promise<void> {
    while (this.running) {
      try {
        await this.pollOnce();
      } catch (err: unknown) {
        // pollOnce already logs; this is belt-and-suspenders so the loop
        // never dies on an unexpected throw.
        logger.error({ err }, 'rial-notifier: cycle threw unexpectedly');
        // Back off briefly so we don't spin a hot loop on a permanent failure.
        await new Promise((resolve) => setTimeout(resolve, 5_000));
      }
      this.opts.onCycle?.();
    }
    logger.info('rial-notifier: stopped');
  }
}

// Re-export for tests so they don't need to import the type from @aws-sdk
// directly (shaves a dependency from the test surface).
export { type Message } from '@aws-sdk/client-sqs';
