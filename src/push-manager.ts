import type { Action } from './types.js';

export interface PushMessageInput {
  source: string;
  title: string;
  sender: string;
  summary: string | null;
  lastReply?: string;
  lastReplyAge?: string;
}

export function formatPushMessage(input: PushMessageInput): string {
  const lines: string[] = [];

  const icon = input.source === 'calendar' ? '🟡' : '🔴';
  const sourceLabel =
    input.source === 'gmail'
      ? 'Email'
      : input.source === 'calendar'
        ? 'Calendar'
        : input.source;

  lines.push(
    `${icon} <b>ACTION: ${sourceLabel}${input.sender ? ` from ${input.sender}` : ''}</b>`,
  );
  lines.push(`Re: ${input.title}`);

  if (input.summary) {
    lines.push('');
    lines.push(`<i>"${truncate(input.summary, 200)}"</i>`);
  }

  if (input.lastReply) {
    lines.push('');
    lines.push(
      `📝 <b>Your last reply</b> (${input.lastReplyAge ?? 'earlier'}):`,
    );
    lines.push(`<i>"${truncate(input.lastReply, 140)}"</i>`);
  }

  return lines.join('\n');
}

export function getPushActions(itemId: string): Action[] {
  return [
    { label: '✅ Approve', callbackData: `approve:${itemId}` },
    { label: '❌ Dismiss', callbackData: `dismiss:${itemId}` },
    { label: '⏰ Snooze 2h', callbackData: `snooze:${itemId}` },
    { label: '🤖 Handle it', callbackData: `handle:${itemId}` },
  ];
}

function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen - 3) + '...';
}

export class PushRateLimiter {
  private timestamps: number[] = [];
  private limit: number;
  private windowMs: number;

  constructor(limit: number, windowMs: number) {
    this.limit = limit;
    this.windowMs = windowMs;
  }

  canPush(): boolean {
    this.prune();
    return this.timestamps.length < this.limit;
  }

  record(): void {
    this.timestamps.push(Date.now());
  }

  private prune(): void {
    const cutoff = Date.now() - this.windowMs;
    this.timestamps = this.timestamps.filter((t) => t > cutoff);
  }

  getCount(): number {
    this.prune();
    return this.timestamps.length;
  }
}
