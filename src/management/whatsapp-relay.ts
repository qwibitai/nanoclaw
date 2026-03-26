import type { Channel } from '../types.js';

export interface RelayOptions {
  emit: (event: string, payload: any) => void;
}

/**
 * Relays WhatsApp pairing (QR code) events to the management API.
 *
 * The WhatsApp channel (Baileys) emits QR codes during its connection.update
 * flow but does not expose them via the Channel interface.  The relay exposes
 * an `onQr()` hook that can be called by the channel (or a wrapper) to
 * forward QR data to connected management clients.
 *
 * `initiatePairing()` triggers a fresh `connect()` on the underlying channel
 * so that Baileys starts the QR handshake.
 */
export class WhatsAppPairingRelay {
  private whatsApp: Channel | null;
  private opts: RelayOptions;

  constructor(whatsApp: Channel | null, opts: RelayOptions) {
    this.whatsApp = whatsApp;
    this.opts = opts;
  }

  /**
   * Call this when the WhatsApp channel receives a QR code from Baileys.
   * It will be forwarded as a `whatsapp.qr` event to management clients.
   */
  onQr(qr: string): void {
    this.opts.emit('whatsapp.qr', {
      qr,
      expiresIn: 60,
    });
  }

  /**
   * Wire up automatic QR forwarding by listening for events on the channel.
   * If the channel exposes an EventEmitter-style `on('qr', ...)` this will
   * bind automatically; otherwise callers should push QR data via `onQr()`.
   */
  start(): void {
    if (!this.whatsApp) return;

    // If the channel exposes an EventEmitter `on` method with 'qr' events
    // (future-proofing), wire it up automatically.
    const maybeEmitter = this.whatsApp as any;
    if (typeof maybeEmitter.on === 'function') {
      maybeEmitter.on('qr', (qr: string) => {
        this.onQr(qr);
      });
    }
  }

  /**
   * Initiate the WhatsApp pairing flow by calling connect() on the channel.
   * QR codes will be emitted via the `whatsapp.qr` event as they arrive.
   */
  async initiatePairing(): Promise<{ started: true }> {
    if (!this.whatsApp) {
      throw new Error('WhatsApp channel not available');
    }
    // connect() triggers the Baileys socket creation, which will emit QR
    // codes via connection.update.  The relay's onQr() hook must be wired
    // to forward those to management clients.
    await this.whatsApp.connect();
    return { started: true };
  }
}
