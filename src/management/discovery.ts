export type EmitFn = (event: string, payload: any) => void;

export class DiscoveryEmitter {
  private discoveredJids = new Set<string>();
  private emit: EmitFn;

  constructor(emit: EmitFn) {
    this.emit = emit;
  }

  /**
   * Called when a message arrives from an unregistered chat.
   * Returns true on first discovery (event emitted + ack should be sent).
   * Returns false for repeat messages (silently dropped).
   */
  onUnregisteredMessage(
    chatJid: string,
    name: string,
    channel: string,
    chatType: string,
  ): boolean {
    if (this.discoveredJids.has(chatJid)) return false;
    this.discoveredJids.add(chatJid);
    this.emit('groups.discovered', { chatJid, name, channel, chatType });
    return true;
  }
}
