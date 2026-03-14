/**
 * Pipeline type definitions.
 * All message filtering/gating flows through these interfaces.
 */

/** Enriched inbound message for pipeline processing. */
export interface InboundMessage {
  id: string;
  chatJid: string;
  sender: string;
  senderName: string;
  content: string;
  timestamp: string;
  channel: 'whatsapp' | 'quo' | 'gmail' | 'messenger' | 'web';
  /** Raw email headers for autoresponder detection (email only). */
  rawHeaders?: string;
  /** Email subject line (email only). */
  subject?: string;
}

/** Outbound message for pipeline processing. */
export interface OutboundMessage {
  chatJid: string;
  text: string;
  channel: string;
}

export type StageVerdict =
  | { action: 'pass' }
  | { action: 'reject'; reason: string };

export type OutboundVerdict =
  | StageVerdict
  | { action: 'transform'; text: string };

export interface InboundStage {
  name: string;
  process(msg: InboundMessage): StageVerdict;
}

export interface OutboundStage {
  name: string;
  process(msg: OutboundMessage): OutboundVerdict;
}
