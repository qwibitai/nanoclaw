#!/usr/bin/env node
/**
 * Nostr Signing Daemon
 *
 * Reads the nsec from the Linux kernel keyring at startup,
 * holds it only in process memory, and signs Nostr events
 * on request via a Unix socket.
 *
 * The agent can USE the key without ever SEEING the key.
 */

import { execSync } from 'child_process';
import { createServer } from 'net';
import { existsSync, unlinkSync } from 'fs';
import { finalizeEvent, getPublicKey } from 'nostr-tools/pure';
import { decode as decodeNsec } from 'nostr-tools/nip19';
import { unwrapEvent as nip17Unwrap, wrapManyEvents as nip17WrapMany } from 'nostr-tools/nip17';
import * as nip44 from 'nostr-tools/nip44';
import * as nip04 from 'nostr-tools/nip04';

// --- Load key from kernel keyring ---
let secretKeyHex;
try {
  const keyId = execSync('keyctl search @u user wn_nsec', { encoding: 'utf8' }).trim();
  const nsec = execSync(`keyctl print ${keyId}`, { encoding: 'utf8' }).trim();
  const decoded = decodeNsec(nsec);
  if (decoded.type !== 'nsec') throw new Error('Keyring value is not an nsec');
  secretKeyHex = decoded.data;
  console.log('[nostr-signer] Key loaded from kernel keyring');
} catch (err) {
  // NEVER log err.message — nostr-tools includes the raw key value in decode errors
  console.error('[nostr-signer] Failed to load key from keyring. Ensure wn_nsec contains ONLY the nsec1... string (no extra lines or whitespace).');
  process.exit(1);
}

const pubkey = getPublicKey(secretKeyHex);
console.log(`[nostr-signer] Public key: ${pubkey}`);

// --- Socket path ---
const SOCKET_PATH = process.env.NOSTR_SIGNER_SOCKET
  || `${process.env.XDG_RUNTIME_DIR || '/run/user/1000'}/nostr-signer.sock`;

// Clean up stale socket
if (existsSync(SOCKET_PATH)) unlinkSync(SOCKET_PATH);

// --- Handle requests ---
async function handleRequest(data) {
  try {
    const req = JSON.parse(data);

    if (req.method === 'get_public_key') {
      return JSON.stringify({ pubkey });
    }

    if (req.method === 'sign_event') {
      const p = req.params || {};
      if (p.kind === undefined) return JSON.stringify({ error: 'Missing required field: kind' });
      if (p.content === undefined) return JSON.stringify({ error: 'Missing required field: content' });

      const eventTemplate = {
        kind: p.kind,
        content: p.content,
        tags: p.tags || [],
        created_at: p.created_at || Math.floor(Date.now() / 1000),
      };

      const signedEvent = finalizeEvent(eventTemplate, secretKeyHex);
      return JSON.stringify({ event: signedEvent });
    }

    if (req.method === 'unwrap_gift_wrap') {
      const p = req.params || {};
      if (!p.event) return JSON.stringify({ error: 'Missing required field: event' });
      try {
        const rumor = nip17Unwrap(p.event, secretKeyHex);
        return JSON.stringify({ rumor });
      } catch (err) {
        return JSON.stringify({ error: `Unwrap failed: ${err.message}` });
      }
    }

    if (req.method === 'wrap_dm') {
      const p = req.params || {};
      if (!p.recipientPubkey) return JSON.stringify({ error: 'Missing required field: recipientPubkey' });
      if (p.message === undefined) return JSON.stringify({ error: 'Missing required field: message' });
      try {
        const recipients = [{ publicKey: p.recipientPubkey }];
        const events = nip17WrapMany(secretKeyHex, recipients, p.message, p.conversationTitle, p.replyTo);
        return JSON.stringify({ events });
      } catch (err) {
        return JSON.stringify({ error: `Wrap failed: ${err.message}` });
      }
    }

    if (req.method === 'nip44_encrypt') {
      const p = req.params || {};
      if (!p.plaintext) return JSON.stringify({ error: 'Missing required field: plaintext' });
      if (!p.peer_pubkey) return JSON.stringify({ error: 'Missing required field: peer_pubkey' });
      try {
        const convKey = nip44.v2.utils.getConversationKey(secretKeyHex, p.peer_pubkey);
        const ciphertext = nip44.v2.encrypt(p.plaintext, convKey);
        return JSON.stringify({ result: ciphertext, error: null });
      } catch (err) {
        return JSON.stringify({ result: null, error: `nip44_encrypt failed: ${err.message}` });
      }
    }

    if (req.method === 'nip44_decrypt') {
      const p = req.params || {};
      if (!p.ciphertext) return JSON.stringify({ error: 'Missing required field: ciphertext' });
      if (!p.peer_pubkey) return JSON.stringify({ error: 'Missing required field: peer_pubkey' });
      try {
        const convKey = nip44.v2.utils.getConversationKey(secretKeyHex, p.peer_pubkey);
        const plaintext = nip44.v2.decrypt(p.ciphertext, convKey);
        return JSON.stringify({ result: plaintext, error: null });
      } catch (err) {
        return JSON.stringify({ result: null, error: `nip44_decrypt failed: ${err.message}` });
      }
    }

    if (req.method === 'nip04_encrypt') {
      const p = req.params || {};
      if (!p.plaintext && !p.message) return JSON.stringify({ error: 'Missing required field: plaintext' });
      if (!p.recipientPubkey && !p.peer_pubkey) return JSON.stringify({ error: 'Missing required field: recipientPubkey' });
      try {
        const text = p.plaintext || p.message;
        const peer = p.recipientPubkey || p.peer_pubkey;
        const ciphertext = await nip04.encrypt(secretKeyHex, peer, text);
        return JSON.stringify({ ciphertext, error: null });
      } catch (err) {
        return JSON.stringify({ error: `nip04_encrypt failed: ${err.message}` });
      }
    }

    if (req.method === 'nip04_decrypt') {
      const p = req.params || {};
      if (!p.ciphertext && !p.content) return JSON.stringify({ error: 'Missing required field: ciphertext' });
      if (!p.senderPubkey && !p.peer_pubkey) return JSON.stringify({ error: 'Missing required field: senderPubkey' });
      try {
        const cipher = p.ciphertext || p.content;
        const peer = p.senderPubkey || p.peer_pubkey;
        const plaintext = await nip04.decrypt(secretKeyHex, peer, cipher);
        return JSON.stringify({ plaintext, error: null });
      } catch (err) {
        return JSON.stringify({ error: `nip04_decrypt failed: ${err.message}` });
      }
    }

    return JSON.stringify({ error: `Unknown method: ${req.method}` });
  } catch (err) {
    return JSON.stringify({ error: `Parse error: ${err.message}` });
  }
}

// --- Start server ---
const server = createServer((conn) => {
  let buf = '';
  conn.setEncoding('utf8');
  conn.on('data', async (chunk) => {
    buf += chunk;
    // Process when we get a complete JSON object (ends with } or newline)
    if (buf.trimEnd().endsWith('}')) {
      const input = buf;
      buf = '';
      try {
        const response = await handleRequest(input);
        conn.end(response + '\n');
      } catch (err) {
        conn.end(JSON.stringify({ error: err.message }) + '\n');
      }
    }
  });
});

server.listen(SOCKET_PATH, () => {
  // Set socket permissions to owner-only
  execSync(`chmod 600 ${SOCKET_PATH}`);
  console.log(`[nostr-signer] Listening on ${SOCKET_PATH}`);
});

// --- Graceful shutdown ---
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    console.log(`[nostr-signer] ${sig} received, shutting down`);
    server.close();
    if (existsSync(SOCKET_PATH)) unlinkSync(SOCKET_PATH);
    process.exit(0);
  });
}
