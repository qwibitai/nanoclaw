// Reply bus — shared event bus for inbound channel messages.
//
// The nanoclaw channel adapters (Telegram, Slack) live outside this repo
// (in ~/nanoclaw on XPS). They emit into this bus whenever they receive a
// message from an authenticated user; the bash tool's approval flow
// subscribes with a one-shot filter to implement ask-tier approval.
//
// Keeping the bus in this repo lets the service-bot code own the contract
// and ship tests. Channel adapters that want to wire into it call
// `replyBus.emit('reply', { channel, userId, text })` from their inbound
// message handler. A one-line addition, and the existing behaviour is
// unaffected.

import { EventEmitter } from 'node:events';

export type ChannelKind = 'telegram' | 'slack' | string;

export interface ReplyEvent {
  channel: ChannelKind;
  userId: string;      // stringified user ID (Telegram number or Slack U...)
  text: string;
  raw?: unknown;       // optional original payload, for debug
}

class ReplyBus extends EventEmitter {
  constructor() {
    super();
    // Avoid MaxListenersExceededWarning for legit concurrent approval waits.
    this.setMaxListeners(50);
  }

  emitReply(ev: ReplyEvent): void {
    this.emit('reply', ev);
  }
}

export const replyBus = new ReplyBus();

/** @internal Test helper — drop all listeners. */
export function _resetReplyBus(): void {
  replyBus.removeAllListeners();
}
