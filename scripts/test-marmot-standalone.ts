/**
 * Standalone Marmot / White Noise test script.
 *
 * Boots just the Marmot channel for interactive testing with the White Noise
 * app, without needing the full NanoClaw Docker stack.
 *
 * Usage:
 *   cd /tmp/nanoclaw-fork
 *   npx tsx scripts/test-marmot-standalone.ts
 *
 * Environment variables:
 *   MARMOT_NOSTR_PRIVATE_KEY  - hex-encoded 32-byte Nostr private key
 *                                (optional; generates a fresh one if missing)
 *   MARMOT_NOSTR_RELAYS       - comma-separated relay URLs
 *                                (default: wss://relay.damus.io,wss://nos.lol,wss://relay.nostr.band)
 *
 * Once running:
 *   1. Copy the npub (bech32) shown at startup
 *   2. In White Noise, add this npub as a contact and invite it to a group
 *   3. The script will print incoming messages as they arrive
 *   4. Type a message on stdin + Enter to send it to the most recently joined group
 *   5. Press Ctrl+C to quit
 */

import * as readline from 'node:readline';

import { getPublicKey, generateSecretKey, finalizeEvent, type UnsignedEvent } from 'nostr-tools';
import { SimplePool, type SubCloser } from 'nostr-tools/pool';
import { hexToBytes, bytesToHex } from 'nostr-tools/utils';
import { npubEncode } from 'nostr-tools/nip19';
import * as nip44 from 'nostr-tools/nip44';

import {
  MarmotClient,
  KeyValueGroupStateBackend,
  KeyPackageStore,
  InviteReader,
  deserializeApplicationRumor,
  GROUP_EVENT_KIND,
  KEY_PACKAGE_KIND,
} from '@internet-privacy/marmot-ts';
import type {
  NostrNetworkInterface,
  PublishResponse,
  Subscribable,
} from '@internet-privacy/marmot-ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function ts(): string {
  return new Date().toISOString().replace('T', ' ').slice(0, 23);
}

function log(tag: string, msg: string, data?: Record<string, unknown>): void {
  const extra = data ? '  ' + JSON.stringify(data) : '';
  console.log(`[${ts()}] [${tag}] ${msg}${extra}`);
}

// ---------------------------------------------------------------------------
// Config from environment
// ---------------------------------------------------------------------------

const DEFAULT_RELAYS = [
  'wss://relay.damus.io',
  'wss://nos.lol',
  'wss://relay.nostr.band',
];

const POLL_INTERVAL_MS = 5000;

let privateKeyHex = process.env.MARMOT_NOSTR_PRIVATE_KEY?.trim() || '';
if (!privateKeyHex) {
  const sk = generateSecretKey();
  privateKeyHex = bytesToHex(sk);
  log('INIT', 'No MARMOT_NOSTR_PRIVATE_KEY set -- generated a fresh key pair');
  log('INIT', `Private key (save this to reuse): ${privateKeyHex}`);
}

const relays: string[] = process.env.MARMOT_NOSTR_RELAYS
  ? process.env.MARMOT_NOSTR_RELAYS.split(',').map((r) => r.trim()).filter(Boolean)
  : DEFAULT_RELAYS;

// ---------------------------------------------------------------------------
// In-memory KeyValueStoreBackend (same as marmot.ts)
// ---------------------------------------------------------------------------

class InMemoryKVStore<T = any> {
  private store = new Map<string, T>();

  async getItem(key: string): Promise<T | null> {
    return this.store.get(key) ?? null;
  }
  async setItem(key: string, value: T): Promise<T> {
    this.store.set(key, value);
    return value;
  }
  async removeItem(key: string): Promise<void> {
    this.store.delete(key);
  }
  async clear(): Promise<void> {
    this.store.clear();
  }
  async keys(): Promise<string[]> {
    return Array.from(this.store.keys());
  }
}

// ---------------------------------------------------------------------------
// EventSigner adapter (same as marmot.ts MarmotEventSigner)
// ---------------------------------------------------------------------------

class TestEventSigner {
  private secretKey: Uint8Array;
  public pubkeyHex: string;

  constructor(nsecHex: string) {
    this.secretKey = hexToBytes(nsecHex);
    this.pubkeyHex = getPublicKey(this.secretKey);
  }

  getPublicKey(): string {
    return this.pubkeyHex;
  }

  signEvent(event: UnsignedEvent): any {
    return finalizeEvent(event, this.secretKey);
  }

  nip44 = {
    encrypt: (pubkey: string, plaintext: string): string => {
      const conversationKey = nip44.v2.utils.getConversationKey(
        this.secretKey,
        pubkey,
      );
      return nip44.v2.encrypt(plaintext, conversationKey);
    },
    decrypt: (pubkey: string, ciphertext: string): string => {
      const conversationKey = nip44.v2.utils.getConversationKey(
        this.secretKey,
        pubkey,
      );
      return nip44.v2.decrypt(ciphertext, conversationKey);
    },
  };
}

// ---------------------------------------------------------------------------
// NostrNetworkInterface adapter (same as marmot.ts MarmotNetworkAdapter)
// ---------------------------------------------------------------------------

class TestNetworkAdapter implements NostrNetworkInterface {
  private pool: SimplePool;
  private defaultRelays: string[];

  constructor(relayList: string[]) {
    this.pool = new SimplePool();
    this.defaultRelays = relayList;
  }

  async publish(
    targetRelays: string[],
    event: any,
  ): Promise<Record<string, PublishResponse>> {
    const targets = targetRelays.length > 0 ? targetRelays : this.defaultRelays;
    const results: Record<string, PublishResponse> = {};

    const promises = this.pool.publish(targets, event);
    await Promise.allSettled(
      promises.map(async (p, i) => {
        try {
          const msg = await p;
          results[targets[i]] = { from: targets[i], ok: true, message: msg };
        } catch (err: any) {
          results[targets[i]] = {
            from: targets[i],
            ok: false,
            message: err?.message || 'publish failed',
          };
          log('RELAY', `Publish failed to ${targets[i]}`, { error: err?.message });
        }
      }),
    );

    return results;
  }

  async request(
    targetRelays: string[],
    filters: any | any[],
  ): Promise<any[]> {
    const targets = targetRelays.length > 0 ? targetRelays : this.defaultRelays;
    const filter = Array.isArray(filters) ? filters[0] : filters;
    return await this.pool.querySync(targets, filter);
  }

  subscription(
    targetRelays: string[],
    filters: any | any[],
  ): Subscribable<any> {
    const targets = targetRelays.length > 0 ? targetRelays : this.defaultRelays;
    const pool = this.pool;
    const filter = Array.isArray(filters) ? filters[0] : filters;

    return {
      subscribe: (observer: {
        next?: (value: any) => void;
        error?: (err: unknown) => void;
        complete?: () => void;
      }) => {
        const sub = pool.subscribeMany(targets, filter, {
          onevent: (event: any) => {
            observer.next?.(event);
          },
          oneose: () => {
            // End of stored events -- keep subscription open for real-time
          },
        });

        return {
          unsubscribe: () => {
            sub.close();
          },
        };
      },
    };
  }

  async getUserInboxRelays(_pubkey: string): Promise<string[]> {
    return this.defaultRelays;
  }

  /** Subscribe using SimplePool's native API (for polling) */
  subscribeNative(
    targetRelays: string[],
    filter: Record<string, any>,
    handlers: { onevent: (event: any) => void; oneose?: () => void },
  ): SubCloser {
    const targets = targetRelays.length > 0 ? targetRelays : this.defaultRelays;
    return this.pool.subscribeMany(targets, filter as any, handlers);
  }

  close(): void {
    this.pool.close(this.defaultRelays);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  // --- Key pair ---
  const signer = new TestEventSigner(privateKeyHex);
  const pubkey = signer.getPublicKey();
  const npub = npubEncode(pubkey);

  console.log('');
  console.log('==========================================================');
  console.log('  Marmot / White Noise Standalone Test');
  console.log('==========================================================');
  console.log('');
  console.log(`  Pubkey (hex):    ${pubkey}`);
  console.log(`  Pubkey (bech32): ${npub}`);
  console.log(`  Relays:          ${relays.join(', ')}`);
  console.log('');
  console.log('  Add the npub above in White Noise, then invite this');
  console.log('  identity to a group. Messages will appear below.');
  console.log('');
  console.log('  Type a message + Enter to send to the last joined group.');
  console.log('  Press Ctrl+C to quit.');
  console.log('');
  console.log('==========================================================');
  console.log('');

  // --- Nostr network adapter ---
  const network = new TestNetworkAdapter(relays);

  // --- Storage (in-memory, ephemeral) ---
  const groupStateBackend = new KeyValueGroupStateBackend(new InMemoryKVStore());
  const keyPackageStore = new KeyPackageStore(new InMemoryKVStore());

  // --- MarmotClient ---
  const marmotClient = new MarmotClient({
    signer: signer as any,
    groupStateBackend,
    keyPackageStore,
    network,
  });

  // --- InviteReader ---
  const inviteReader = new InviteReader({
    signer: signer as any,
    store: {
      received: new InMemoryKVStore(),
      unread: new InMemoryKVStore(),
      seen: new InMemoryKVStore(),
    },
  });

  // --- Publish KeyPackage (kind 443) ---
  log('INIT', 'Publishing KeyPackage (kind 443)...');
  try {
    await marmotClient.keyPackages.create({
      relays,
      client: 'NanoClaw/marmot-test',
      isLastResort: true,
    });
    log('INIT', 'KeyPackage published successfully');
  } catch (err: any) {
    log('ERROR', 'Failed to publish KeyPackage', { error: err?.message });
  }

  // --- Load existing groups (none expected on first run) ---
  try {
    await marmotClient.loadAllGroups();
  } catch {
    // No existing groups in ephemeral store
  }

  // --- Track joined groups and subscriptions ---
  let lastJoinedGroupId: string | null = null;
  const subscriptions = new Map<string, { close: () => void }>();

  /**
   * Subscribe to kind 445 events for a group and print decrypted messages.
   */
  function subscribeToGroup(groupIdHex: string, groupName: string): void {
    if (subscriptions.has(groupIdHex)) return;

    log('GROUP', `Subscribing to group ${groupName}`, { groupIdHex: groupIdHex.slice(0, 24) + '...' });

    const sub = network.subscribeNative(
      relays,
      {
        kinds: [GROUP_EVENT_KIND],
        '#h': [groupIdHex],
        since: Math.floor(Date.now() / 1000),
      },
      {
        onevent: async (event: any) => {
          // Skip our own events
          if (event.pubkey === pubkey) return;

          try {
            const group = await marmotClient.getGroup(groupIdHex);

            for await (const result of group.ingest([event])) {
              if (
                result.kind === 'processed' &&
                result.result.kind === 'applicationMessage'
              ) {
                try {
                  const rumor = deserializeApplicationRumor(
                    result.result.message,
                  );

                  const senderPubkey = rumor.pubkey || event.pubkey || 'unknown';
                  const senderShort = senderPubkey.slice(0, 12) + '...';
                  const content = rumor.content || '';
                  const timestamp = rumor.created_at
                    ? new Date(rumor.created_at * 1000).toISOString()
                    : new Date().toISOString();

                  console.log('');
                  log('MSG', `[${groupName}] <${senderShort}> ${content}`, {
                    timestamp,
                    eventId: event.id?.slice(0, 16),
                  });
                  console.log('');
                } catch (deserializeErr: any) {
                  log('WARN', 'Failed to deserialize application rumor', {
                    error: deserializeErr?.message,
                  });
                }
              } else if (result.kind === 'unreadable') {
                log('DEBUG', 'Unreadable event (may be commit/proposal)', {
                  eventId: event.id?.slice(0, 16),
                });
              } else if (result.kind === 'skipped') {
                log('DEBUG', `Skipped event: ${result.reason}`, {
                  eventId: event.id?.slice(0, 16),
                });
              }
            }

            // Save group state after processing
            await group.save();
          } catch (err: any) {
            log('ERROR', 'Failed to process group event', {
              eventId: event.id?.slice(0, 16),
              error: err?.message,
            });
          }
        },
      },
    );

    subscriptions.set(groupIdHex, sub);
    log('GROUP', `Subscribed to kind ${GROUP_EVENT_KIND} events for group`, {
      groupIdHex: groupIdHex.slice(0, 24) + '...',
    });
  }

  // --- Listen for new groups joined via welcome ---
  marmotClient.on('groupJoined', (group) => {
    const groupIdHex = group.idStr;
    const groupName = group.groupData?.name || `marmot:${groupIdHex.slice(0, 12)}`;

    console.log('');
    log('JOIN', `Joined new Marmot group: ${groupName}`, {
      groupIdHex: groupIdHex.slice(0, 24) + '...',
    });
    console.log('');

    lastJoinedGroupId = groupIdHex;
    subscribeToGroup(groupIdHex, groupName);

    // Perform self-update for forward secrecy (MIP-02)
    group.selfUpdate().catch((err: any) => {
      log('WARN', 'Failed self-update after join', { error: err?.message });
    });
  });

  // --- Welcome poller (kind 1059 gift wraps) ---
  let lastCheck = Math.floor(Date.now() / 1000);

  const pollTimer = setInterval(async () => {
    try {
      const events = await network.request(relays, {
        kinds: [1059],
        '#p': [pubkey],
        since: lastCheck,
      });

      if (events.length > 0) {
        log('WELCOME', `Received ${events.length} potential welcome event(s)`);

        const newCount = await inviteReader.ingestEvents(events);

        if (newCount > 0) {
          log('WELCOME', `${newCount} new gift wrap(s) ingested, decrypting...`);

          const invites = await inviteReader.decryptGiftWraps();
          log('WELCOME', `Decrypted ${invites.length} invite(s)`);

          for (const invite of invites) {
            try {
              const { group } = await marmotClient.joinGroupFromWelcome({
                welcomeRumor: invite,
              });

              log('WELCOME', `Joined group from welcome`, {
                groupId: group.idStr.slice(0, 24) + '...',
              });

              await inviteReader.markAsRead(invite.id);
            } catch (joinErr: any) {
              log('ERROR', 'Failed to join from welcome', {
                error: joinErr?.message,
              });
            }
          }
        }
      }

      lastCheck = Math.floor(Date.now() / 1000);
    } catch (err: any) {
      log('WARN', 'Welcome poll failed', { error: err?.message });
    }
  }, POLL_INTERVAL_MS);

  log('POLL', `Welcome poller started (every ${POLL_INTERVAL_MS}ms)`);

  // --- Stdin reader for sending messages ---
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: '',
  });

  rl.on('line', async (line: string) => {
    const text = line.trim();
    if (!text) return;

    if (!lastJoinedGroupId) {
      log('SEND', 'No group joined yet -- wait for a White Noise invite first');
      return;
    }

    try {
      const group = await marmotClient.getGroup(lastJoinedGroupId);
      await group.sendChatMessage(text);
      log('SEND', `Message sent to group ${lastJoinedGroupId.slice(0, 16)}...`, {
        length: text.length,
      });
    } catch (err: any) {
      log('ERROR', 'Failed to send message', { error: err?.message });
    }
  });

  // --- Graceful shutdown ---
  function shutdown() {
    console.log('');
    log('SHUTDOWN', 'Cleaning up...');

    clearInterval(pollTimer);

    for (const [, sub] of subscriptions) {
      sub.close();
    }
    subscriptions.clear();

    network.close();
    rl.close();

    log('SHUTDOWN', 'Done. Goodbye.');
    process.exit(0);
  }

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
