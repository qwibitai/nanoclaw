import { AvailableGroup } from '../container-runner.js';
import { RegisteredGroup } from '../types.js';

export interface HandlerContext {
  sourceGroup: string;
  isMain: boolean;
  chatJid: string;
}

export interface HandlerDeps {
  sendMessage: (jid: string, text: string, sender?: string) => Promise<void>;
  sendReaction?: (jid: string, emoji: string, messageId?: string) => Promise<void>;
  registeredGroups: () => Record<string, RegisteredGroup>;
  registerGroup: (jid: string, group: RegisteredGroup) => void;
  unregisterGroup: (jid: string) => boolean;
  syncGroups: (force: boolean) => Promise<void>;
  getAvailableGroups: () => AvailableGroup[];
}

export type Handler = (
  params: any,
  context: HandlerContext,
  deps: HandlerDeps,
) => Promise<any>;

const registry = new Map<string, Handler>();

export function registerHandler(method: string, handler: Handler): void {
  registry.set(method, handler);
}

export function getRegisteredHandlers(): Map<string, Handler> {
  return registry;
}
