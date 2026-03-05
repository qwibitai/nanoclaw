/**
 * IPC Handler Registry
 * Mirrors src/channels/registry.ts. Skills register JSON-RPC method handlers.
 */

export interface HandlerContext {
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
}

export type IpcHandler = (
  params: Record<string, unknown>,
  ctx: HandlerContext,
) => Promise<unknown>;

const registry = new Map<string, IpcHandler>();

export function registerIpcHandler(type: string, handler: IpcHandler): void {
  registry.set(type, handler);
}

export function getRegisteredHandlers(): ReadonlyMap<string, IpcHandler> {
  return registry;
}
