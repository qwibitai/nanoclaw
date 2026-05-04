import {
  DeleteMessageCommand,
  ReceiveMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import { describe, expect, it, vi } from 'vitest';

import { Notifier, OutboundSender, renderEvent } from '../notifier.js';

function makeMockSqs(messages: { body: string; receiptHandle: string }[]): {
  client: SQSClient;
  sends: unknown[];
} {
  const sends: unknown[] = [];
  let drained = false;
  const send = vi.fn(async (cmd: unknown) => {
    sends.push(cmd);
    if (cmd instanceof ReceiveMessageCommand) {
      if (drained) return { Messages: [] };
      drained = true;
      return {
        Messages: messages.map((m) => ({
          Body: m.body,
          ReceiptHandle: m.receiptHandle,
          MessageId: `mid-${m.receiptHandle}`,
        })),
      };
    }
    if (cmd instanceof DeleteMessageCommand) {
      return {};
    }
    return {};
  });
  const client = { send } as unknown as SQSClient;
  return { client, sends };
}

const otpBody = JSON.stringify({
  event: 'wa.outbound.otp_requested',
  data: {
    waPhoneE164: '+5491100000001',
    otpCode: '847291',
    expiresAt: '2026-05-04T16:30:00Z',
  },
});

const notifBody = JSON.stringify({
  event: 'wa.outbound.notification_requested',
  data: {
    waPhoneE164: '+5491100000001',
    message: 'Verification CLM-XXX complete: verdict=clean',
    verificationId: 'vfy_abc',
  },
});

describe('renderEvent', () => {
  it('renders OTP with the canned format', () => {
    expect(
      renderEvent({
        event: 'wa.outbound.otp_requested',
        data: { waPhoneE164: '+54911', otpCode: '123456' },
      }),
    ).toBe('Your rial. code: 123456 (5 min)');
  });

  it('renders notification verbatim', () => {
    expect(
      renderEvent({
        event: 'wa.outbound.notification_requested',
        data: { waPhoneE164: '+54911', message: 'hello world' },
      }),
    ).toBe('hello world');
  });
});

describe('Notifier.pollOnce', () => {
  it('sends and deletes on success (OTP event)', async () => {
    const { client, sends } = makeMockSqs([
      { body: otpBody, receiptHandle: 'rh-1' },
    ]);
    const sender: OutboundSender = { sendMessage: vi.fn(async () => {}) };
    const findSender = vi.fn(() => sender);
    const notifier = new Notifier({
      queueUrl: 'https://sqs.example/queue',
      region: 'us-east-1',
      resolveJid: (p) => `${p.replace('+', '')}@s.whatsapp.net`,
      findSender,
      client,
    });

    await notifier.pollOnce();

    expect(sender.sendMessage).toHaveBeenCalledWith(
      '5491100000001@s.whatsapp.net',
      'Your rial. code: 847291 (5 min)',
    );
    const deletes = sends.filter((c) => c instanceof DeleteMessageCommand);
    expect(deletes).toHaveLength(1);
  });

  it('sends and deletes on success (notification event)', async () => {
    const { client } = makeMockSqs([
      { body: notifBody, receiptHandle: 'rh-1' },
    ]);
    const sender: OutboundSender = { sendMessage: vi.fn(async () => {}) };
    const notifier = new Notifier({
      queueUrl: 'https://sqs.example/queue',
      region: 'us-east-1',
      resolveJid: (p) => `${p.replace('+', '')}@s.whatsapp.net`,
      findSender: () => sender,
      client,
    });
    await notifier.pollOnce();
    expect(sender.sendMessage).toHaveBeenCalledWith(
      '5491100000001@s.whatsapp.net',
      'Verification CLM-XXX complete: verdict=clean',
    );
  });

  it('deletes poison-pill (unparseable JSON) without sending', async () => {
    const { client, sends } = makeMockSqs([
      { body: 'not-json', receiptHandle: 'rh-2' },
    ]);
    const sender: OutboundSender = { sendMessage: vi.fn(async () => {}) };
    const notifier = new Notifier({
      queueUrl: 'https://sqs.example/queue',
      region: 'us-east-1',
      resolveJid: () => 'jid',
      findSender: () => sender,
      client,
    });
    await notifier.pollOnce();
    expect(sender.sendMessage).not.toHaveBeenCalled();
    const deletes = sends.filter((c) => c instanceof DeleteMessageCommand);
    expect(deletes).toHaveLength(1);
  });

  it('deletes poison-pill on unknown event type', async () => {
    const body = JSON.stringify({
      event: 'wa.outbound.something_else',
      data: { waPhoneE164: '+5491100000001' },
    });
    const { client, sends } = makeMockSqs([{ body, receiptHandle: 'rh-3' }]);
    const sender: OutboundSender = { sendMessage: vi.fn(async () => {}) };
    const notifier = new Notifier({
      queueUrl: 'https://sqs.example/queue',
      region: 'us-east-1',
      resolveJid: () => 'jid',
      findSender: () => sender,
      client,
    });
    await notifier.pollOnce();
    expect(sender.sendMessage).not.toHaveBeenCalled();
    expect(sends.filter((c) => c instanceof DeleteMessageCommand)).toHaveLength(
      1,
    );
  });

  it('does NOT delete when send fails (so SQS can retry)', async () => {
    const { client, sends } = makeMockSqs([
      { body: otpBody, receiptHandle: 'rh-1' },
    ]);
    const sender: OutboundSender = {
      sendMessage: vi.fn(async () => {
        throw new Error('Baileys disconnected');
      }),
    };
    const notifier = new Notifier({
      queueUrl: 'https://sqs.example/queue',
      region: 'us-east-1',
      resolveJid: (p) => `${p.replace('+', '')}@s.whatsapp.net`,
      findSender: () => sender,
      client,
    });
    await notifier.pollOnce();
    expect(sender.sendMessage).toHaveBeenCalled();
    const deletes = sends.filter((c) => c instanceof DeleteMessageCommand);
    expect(deletes).toHaveLength(0);
  });

  it('does NOT delete when no channel is available (left for retry)', async () => {
    const { client, sends } = makeMockSqs([
      { body: otpBody, receiptHandle: 'rh-1' },
    ]);
    const notifier = new Notifier({
      queueUrl: 'https://sqs.example/queue',
      region: 'us-east-1',
      resolveJid: () => 'jid',
      findSender: () => null,
      client,
    });
    await notifier.pollOnce();
    const deletes = sends.filter((c) => c instanceof DeleteMessageCommand);
    expect(deletes).toHaveLength(0);
  });

  it('handles ReceiveMessage errors gracefully (logs, no crash)', async () => {
    const send = vi.fn(async () => {
      throw new Error('AWS unreachable');
    });
    const client = { send } as unknown as SQSClient;
    const sender: OutboundSender = { sendMessage: vi.fn(async () => {}) };
    const notifier = new Notifier({
      queueUrl: 'https://sqs.example/queue',
      region: 'us-east-1',
      resolveJid: () => 'jid',
      findSender: () => sender,
      client,
    });
    await expect(notifier.pollOnce()).resolves.toBeUndefined();
    expect(sender.sendMessage).not.toHaveBeenCalled();
  });
});
