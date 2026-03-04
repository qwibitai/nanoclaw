/**
 * IPC Handler Registry
 * Mirrors src/channels/registry.ts. Skills register handlers by message-type prefix.
 */

export type IpcHandler = (
  msg: Record<string, unknown>,
  groupFolder: string,
  isMain: boolean,
) => Promise<{ success: boolean; message: string; data?: unknown } | null>;

const registry = new Map<string, IpcHandler>();

export function registerIpcHandler(type: string, handler: IpcHandler): void {
  registry.set(type, handler);
}

export async function resolveIpcHandler(
  msg: Record<string, unknown>,
  groupFolder: string,
  isMain: boolean,
): Promise<{ success: boolean; message: string; data?: unknown } | null> {
  const type = msg.type as string;
  const handler = registry.get(type);
  if (handler) {
    return handler(msg, groupFolder, isMain);
  }
  return null;
}
