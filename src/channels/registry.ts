import {
  Channel,
  OnInboundMessage,
  OnChatMetadata,
  RegisteredGroup,
  ScheduledTask,
} from '../types.js';

export interface ChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  onRegisterGroup: (jid: string, group: RegisteredGroup) => void;
  registeredGroups: () => Record<string, RegisteredGroup>;
  runTask: (task: ScheduledTask) => Promise<void>;
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
