import {
  Channel,
  OnInboundMessage,
  OnChatMetadata,
  RegisteredGroup,
} from '../types.js';

export interface ChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

export type ChannelFactory = (opts: ChannelOpts) => Channel | null;

const registry = new Map<string, ChannelFactory>();

type IdentityWrapper = (name: string, factory: ChannelFactory) => ChannelFactory;
let _identityWrapper: IdentityWrapper | null = null;

export function setIdentityWrapper(fn: IdentityWrapper): void {
  _identityWrapper = fn;
}

export function registerChannel(name: string, factory: ChannelFactory): void {
  registry.set(name, _identityWrapper ? _identityWrapper(name, factory) : factory);
}

export function getChannelFactory(name: string): ChannelFactory | undefined {
  return registry.get(name);
}

export function getRegisteredChannelNames(): string[] {
  return [...registry.keys()];
}
