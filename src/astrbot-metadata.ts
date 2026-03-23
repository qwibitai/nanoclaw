import { NewMessage } from './types.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function getMetadata(msg: NewMessage): Record<string, unknown> | null {
  return isRecord(msg.metadata) ? msg.metadata : null;
}

export function isContextOnlyMessage(msg: NewMessage): boolean {
  const metadata = getMetadata(msg);
  return metadata?.context_only === true;
}

export function isAstrBotWakeMessage(msg: NewMessage): boolean {
  const metadata = getMetadata(msg);
  return metadata?.source === 'astrbot' && metadata?.is_at_or_wake_command === true;
}
