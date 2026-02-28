// Merge into src/index.ts
// These snippets show what to add/modify in the main orchestrator.

// --- 1. Add imports (at the top, with other imports) ---

import { SignalChannel } from './channels/signal.js';
import {
  SIGNAL_ACCOUNT,
  SIGNAL_HTTP_HOST,
  SIGNAL_HTTP_PORT,
  SIGNAL_ALLOW_FROM,
  SIGNAL_ONLY,
} from './config.js';

// --- 2. Ensure channels array exists (near existing whatsapp variable) ---

// let whatsapp: WhatsAppChannel;
// const channels: Channel[] = [];

// --- 3. Channel initialisation in main() ---
// Replace the unconditional WhatsApp setup with conditional:

if (!SIGNAL_ONLY) {
  whatsapp = new WhatsAppChannel(channelOpts);
  channels.push(whatsapp);
  await whatsapp.connect();
}

if (SIGNAL_ACCOUNT) {
  const signal = new SignalChannel({
    ...channelOpts,
    account: SIGNAL_ACCOUNT,
    httpHost: SIGNAL_HTTP_HOST,
    httpPort: SIGNAL_HTTP_PORT,
    allowFrom: SIGNAL_ALLOW_FROM,
  });
  channels.push(signal);
  await signal.connect();
}

if (channels.length === 0) {
  logger.error('No channels configured. Set SIGNAL_ACCOUNT or disable SIGNAL_ONLY.');
  process.exit(1);
}

// --- 4. Update getAvailableGroups filter to include Signal ---
// Add c.jid.startsWith('signal:') to the filter:

.filter((c) =>
  c.jid !== '__group_sync__' &&
  (c.jid.endsWith('@g.us') || c.jid.startsWith('signal:')),
)

// --- 5. Update shutdown handler to disconnect all channels ---

const shutdown = async (signal: string) => {
  logger.info({ signal }, 'Shutdown signal received');
  await queue.shutdown(10000);
  for (const ch of channels) await ch.disconnect();
  process.exit(0);
};
