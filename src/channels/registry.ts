import {
  Channel,
  OnInboundMessage,
  OnChatMetadata,
  RegisteredGroup,
} from '../types.js';

export interface UsageInfo {
  inputTokens: number;
  outputTokens: number;
  numTurns: number;
}

export interface StatusInfo {
  activeContainers: number;
  uptimeSeconds: number;
  sessions: Record<string, string>;
  lastUsage: Record<string, UsageInfo>;
}

export interface ChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
  getStatus: () => StatusInfo;
  sendIpcMessage: (chatJid: string, text: string) => boolean;
  clearSession: (groupFolder: string) => void;
}

export type ChannelFactory = (opts: ChannelOpts) => Channel | null;

const registry = new Map<string, ChannelFactory>();

export function registerChannel(name: string, factory: ChannelFactory): void {
  registry.set(name, factory);
}

export function getChannelFactory(name: string): ChannelFactory | undefined {
  return registry.get(name);
}

export function getRegisteredChannelNames(): string[] {
  return [...registry.keys()];
}
