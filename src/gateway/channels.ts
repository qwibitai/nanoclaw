import type { ChannelInfo } from '../shared/types.ts';

const channels = new Map<string, ChannelInfo>();

export function registerChannel(info: ChannelInfo): void {
  channels.set(info.id, info);
}

export function updateChannel(
  id: string,
  update: Partial<ChannelInfo>,
): void {
  const existing = channels.get(id);
  if (existing) {
    channels.set(id, { ...existing, ...update });
  }
}

export function getChannels(): ChannelInfo[] {
  return [...channels.values()];
}

export function getChannel(id: string): ChannelInfo | undefined {
  return channels.get(id);
}
