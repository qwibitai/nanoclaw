/**
 * IPC Handler Registry
 * Mirrors src/channels/registry.ts. Skills register JSON-RPC method handlers.
 */

export type IpcHandler = (
  params: Record<string, unknown>,
  groupFolder: string,
  isMain: boolean,
) => Promise<unknown>;

const registry = new Map<string, IpcHandler>();

export function registerIpcHandler(type: string, handler: IpcHandler): void {
  registry.set(type, handler);
}

export function getRegisteredHandlers(): ReadonlyMap<string, IpcHandler> {
  return registry;
}
