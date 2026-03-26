import { describe, it, expect, vi } from 'vitest';
import { WhatsAppPairingRelay } from './whatsapp-relay.js';
import { EventEmitter } from 'events';

describe('WhatsAppPairingRelay', () => {
  it('should forward QR data via onQr() to whatsapp.qr event', () => {
    const emitFn = vi.fn();
    const relay = new WhatsAppPairingRelay(null, { emit: emitFn });

    relay.onQr('qr-code-data-here');

    expect(emitFn).toHaveBeenCalledWith('whatsapp.qr', {
      qr: 'qr-code-data-here',
      expiresIn: 60,
    });
  });

  it('should relay QR code events from an EventEmitter-style channel', () => {
    const mockWhatsApp = new EventEmitter();
    // Satisfy the Channel interface minimally
    Object.assign(mockWhatsApp, {
      name: 'whatsapp',
      connect: vi.fn(),
      sendMessage: vi.fn(),
      isConnected: () => false,
      ownsJid: () => true,
      disconnect: vi.fn(),
    });

    const emitFn = vi.fn();
    const relay = new WhatsAppPairingRelay(mockWhatsApp as any, {
      emit: emitFn,
    });
    relay.start();

    mockWhatsApp.emit('qr', 'qr-code-data-here');

    expect(emitFn).toHaveBeenCalledWith('whatsapp.qr', {
      qr: 'qr-code-data-here',
      expiresIn: 60,
    });
  });

  it('should handle initiate pairing request', async () => {
    const mockWhatsApp = {
      name: 'whatsapp',
      connect: vi.fn().mockResolvedValue(undefined),
      sendMessage: vi.fn(),
      isConnected: () => false,
      ownsJid: () => true,
      disconnect: vi.fn(),
    };

    const relay = new WhatsAppPairingRelay(mockWhatsApp as any, {
      emit: vi.fn(),
    });
    const result = await relay.initiatePairing();

    expect(result).toEqual({ started: true });
    expect(mockWhatsApp.connect).toHaveBeenCalled();
  });

  it('should return error if WhatsApp channel not available', async () => {
    const relay = new WhatsAppPairingRelay(null, { emit: vi.fn() });
    await expect(relay.initiatePairing()).rejects.toThrow(
      /whatsapp.*not.*available/i,
    );
  });

  it('start() should be a no-op when channel is null', () => {
    const emitFn = vi.fn();
    const relay = new WhatsAppPairingRelay(null, { emit: emitFn });
    // Should not throw
    relay.start();
    expect(emitFn).not.toHaveBeenCalled();
  });
});
