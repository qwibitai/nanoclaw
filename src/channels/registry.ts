import type { Application } from 'express';

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
  registeredGroups: () => Record<string, RegisteredGroup>;
  registerGroup?: (jid: string, group: RegisteredGroup) => void;
  getActiveTasks?: () => ScheduledTask[];
  cancelTask?: (taskId: string) => void;
  pauseTask?: (taskId: string) => void;
  resumeTask?: (taskId: string) => void;
  /** Shared Express app for webhook channels to mount routes on */
  app?: Application;
  requestRestart?: () => void;
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
