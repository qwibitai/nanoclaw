/**
 * Agent Relay — peer-to-peer messaging between agent instances.
 * Pure types and helpers — no I/O.
 *
 * Agents write messages to relay-outbox/, host routes them to the target
 * agent's relay-inbox/. All messages logged for human observability.
 */

export interface RelayMessage {
  id: string;
  from: string;       // source group folder (agent identity)
  to: string;         // target group folder
  content: string;    // message body
  replyTo?: string;   // optional: ID of message being replied to
  timestamp: string;
}

export interface RelayDelivery {
  id: string;
  status: 'delivered' | 'undeliverable';
  reason?: string;    // set when undeliverable (target not registered, etc.)
  timestamp: string;
}

export interface RelayLogEntry {
  message: RelayMessage;
  delivery: RelayDelivery;
}

/**
 * Validate a relay message has required fields.
 * Returns null if valid, error string if invalid.
 */
export function validateRelayMessage(msg: unknown): string | null {
  if (!msg || typeof msg !== 'object') return 'Message must be an object';
  const m = msg as Record<string, unknown>;

  if (typeof m.id !== 'string' || !m.id) return 'Missing or empty id';
  if (typeof m.from !== 'string' || !m.from) return 'Missing or empty from';
  if (typeof m.to !== 'string' || !m.to) return 'Missing or empty to';
  if (typeof m.content !== 'string' || !m.content) return 'Missing or empty content';
  if (typeof m.timestamp !== 'string' || !m.timestamp) return 'Missing or empty timestamp';
  if (m.from === m.to) return 'Cannot send message to self';

  return null;
}

/**
 * Build a delivery receipt.
 */
export function buildDelivery(
  messageId: string,
  status: 'delivered' | 'undeliverable',
  reason?: string,
): RelayDelivery {
  return {
    id: messageId,
    status,
    reason,
    timestamp: new Date().toISOString(),
  };
}

/**
 * Build a log entry combining message + delivery.
 */
export function buildLogEntry(
  message: RelayMessage,
  delivery: RelayDelivery,
): RelayLogEntry {
  return { message, delivery };
}

/**
 * Format a relay message for human-readable display.
 * Used when showing relay traffic in the observable log.
 */
export function formatRelayMessage(msg: RelayMessage): string {
  const lines = [
    `[Relay] ${msg.from} → ${msg.to}`,
    msg.content,
  ];
  if (msg.replyTo) {
    lines.splice(1, 0, `(reply to ${msg.replyTo})`);
  }
  return lines.join('\n');
}
