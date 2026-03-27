/**
 * Shared WhatsApp connection state.
 * Imported by both index.ts (writer) and web-server.ts (reader)
 * to expose live WA status to the dashboard without circular deps.
 */

export type WhatsAppStatus =
  | 'connecting'
  | 'connected'
  | 'disconnected'
  | 'needs_qr';

export interface WhatsAppState {
  status: WhatsAppStatus;
  qrDataUrl: string | null; // PNG data URL for dashboard display
  qrExpiresAt: number | null; // Unix ms when the current QR expires (~60s)
}

export const waState: WhatsAppState = {
  status: 'connecting',
  qrDataUrl: null,
  qrExpiresAt: null,
};
