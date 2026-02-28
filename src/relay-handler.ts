/**
 * Relay Handler for Sovereign
 * Watches IPC for relay-outbox messages, routes them to target agent's
 * relay-inbox, logs all traffic for human observability.
 */
import fs from 'fs';
import path from 'path';

import { DATA_DIR } from './config.js';
import { logger } from './logger.js';
import {
  RelayMessage,
  validateRelayMessage,
  buildDelivery,
  buildLogEntry,
  formatRelayMessage,
} from './agent-relay.js';

// Track active relay deliveries to prevent duplicates
const activeRelays = new Set<string>();

export interface RelayHandlerDeps {
  /** Check if a group folder is registered (valid target). */
  isRegisteredGroup: (folder: string) => boolean;
  /** Optional: notify channel when relay message is delivered (observable). */
  onRelayLog?: (entry: ReturnType<typeof buildLogEntry>) => void;
}

export function startRelayHandler(deps: RelayHandlerDeps): void {
  const ipcBaseDir = path.join(DATA_DIR, 'ipc');
  const relayLogDir = path.join(DATA_DIR, 'relay-log');
  fs.mkdirSync(relayLogDir, { recursive: true });

  const processRelays = async () => {
    let groupFolders: string[];
    try {
      groupFolders = fs.readdirSync(ipcBaseDir).filter((f) => {
        try {
          return fs.statSync(path.join(ipcBaseDir, f)).isDirectory() && f !== 'errors';
        } catch {
          return false;
        }
      });
    } catch {
      setTimeout(processRelays, 1000);
      return;
    }

    for (const sourceGroup of groupFolders) {
      const outboxDir = path.join(ipcBaseDir, sourceGroup, 'relay-outbox');
      if (!fs.existsSync(outboxDir)) continue;

      let files: string[];
      try {
        files = fs.readdirSync(outboxDir).filter((f) => f.endsWith('.json'));
      } catch {
        continue;
      }

      for (const file of files) {
        const filePath = path.join(outboxDir, file);
        let msg: RelayMessage;

        try {
          msg = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        } catch (err) {
          logger.error({ file, err }, 'Failed to parse relay message');
          try { fs.unlinkSync(filePath); } catch {}
          continue;
        }

        if (activeRelays.has(msg.id)) continue;

        // Remove outbox file immediately
        try { fs.unlinkSync(filePath); } catch {}
        activeRelays.add(msg.id);

        try {
          routeMessage(msg, ipcBaseDir, relayLogDir, deps);
        } finally {
          activeRelays.delete(msg.id);
        }
      }
    }

    setTimeout(processRelays, 500);
  };

  processRelays();
  logger.info('Relay handler started');
}

function routeMessage(
  msg: RelayMessage,
  ipcBaseDir: string,
  relayLogDir: string,
  deps: RelayHandlerDeps,
): void {
  // Validate message
  const validationError = validateRelayMessage(msg);
  if (validationError) {
    logger.warn({ msgId: msg.id, error: validationError }, 'Invalid relay message');
    writeDeliveryReceipt(ipcBaseDir, msg.from, msg.id, 'undeliverable', validationError);
    return;
  }

  // Check target exists
  if (!deps.isRegisteredGroup(msg.to)) {
    const reason = `Target agent '${msg.to}' is not registered`;
    logger.warn({ msgId: msg.id, to: msg.to }, reason);
    writeDeliveryReceipt(ipcBaseDir, msg.from, msg.id, 'undeliverable', reason);
    logRelayMessage(relayLogDir, msg, buildDelivery(msg.id, 'undeliverable', reason), deps);
    return;
  }

  // Deliver to target's inbox
  const inboxDir = path.join(ipcBaseDir, msg.to, 'relay-inbox');
  fs.mkdirSync(inboxDir, { recursive: true });

  const inboxPath = path.join(inboxDir, `${msg.id}.json`);
  const tempPath = `${inboxPath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(msg, null, 2));
  fs.renameSync(tempPath, inboxPath);

  // Write delivery receipt to sender
  writeDeliveryReceipt(ipcBaseDir, msg.from, msg.id, 'delivered');

  const delivery = buildDelivery(msg.id, 'delivered');
  logRelayMessage(relayLogDir, msg, delivery, deps);

  logger.info(
    { msgId: msg.id, from: msg.from, to: msg.to },
    'Relay message delivered',
  );
}

function writeDeliveryReceipt(
  ipcBaseDir: string,
  senderGroup: string,
  messageId: string,
  status: 'delivered' | 'undeliverable',
  reason?: string,
): void {
  const receiptsDir = path.join(ipcBaseDir, senderGroup, 'relay-receipts');
  fs.mkdirSync(receiptsDir, { recursive: true });

  const delivery = buildDelivery(messageId, status, reason);
  const receiptPath = path.join(receiptsDir, `${messageId}.json`);
  const tempPath = `${receiptPath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(delivery, null, 2));
  fs.renameSync(tempPath, receiptPath);
}

function logRelayMessage(
  relayLogDir: string,
  msg: RelayMessage,
  delivery: ReturnType<typeof buildDelivery>,
  deps: RelayHandlerDeps,
): void {
  const entry = buildLogEntry(msg, delivery);

  // Append to daily log file (JSONL)
  const date = new Date().toISOString().split('T')[0];
  const logPath = path.join(relayLogDir, `${date}.jsonl`);
  fs.appendFileSync(logPath, JSON.stringify(entry) + '\n');

  // Notify callback (for human observability)
  deps.onRelayLog?.(entry);
}
