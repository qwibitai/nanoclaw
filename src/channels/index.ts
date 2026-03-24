// Channel self-registration barrel file.
// Each import triggers the channel's registerChannel() call.

import { registerChannel } from './registry.js';
import { SignalChannel } from './signal.js';
import { WhiteNoiseChannel } from './whitenoise.js';
import { NostrDMChannel } from './nostr-dm.js';
import { SIGNAL_PHONE_NUMBER, WN_ACCOUNT_PUBKEY, NOSTR_DM_ALLOWLIST } from '../config.js';

registerChannel('signal', (opts) => {
  if (!SIGNAL_PHONE_NUMBER) return null;
  return new SignalChannel(opts);
});

registerChannel('whitenoise', (opts) => {
  if (!WN_ACCOUNT_PUBKEY) return null;
  return new WhiteNoiseChannel(opts);
});

registerChannel('nostr-dm', (opts) => {
  if (!NOSTR_DM_ALLOWLIST) return null;
  return new NostrDMChannel(opts);
});
