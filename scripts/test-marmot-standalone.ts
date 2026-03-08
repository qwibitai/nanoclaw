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
 *   2. In White Noise, add this npub as a contact and send a message
 *   3. The script will print incoming messages as they arrive
 *   4. Type a message on stdin + Enter to send it to the most recently joined group
 *   5. Press Ctrl+C to quit
 */

import * as readline from 'node:readline';
import * as fs from 'node:fs';
import * as path from 'node:path';

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
  getNostrGroupIdHex,
  GROUP_EVENT_KIND,
  KEY_PACKAGE_KIND,
  KEY_PACKAGE_RELAY_LIST_KIND,
  createKeyPackageRelayListEvent,
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

// Relays for message transport (MLS encrypted group events)
const DEFAULT_RELAYS = [
  'wss://relay.damus.io',
  'wss://nos.lol',
  'wss://relay.nostr.band',
];

// White Noise discovery relays — profiles & relay lists must be published here
// for White Noise to find us. See whitenoise-rs/src/relay_control/discovery.rs
const DISCOVERY_RELAYS = [
  'wss://purplepag.es',
  'wss://relay.primal.net',
  'wss://relay.damus.io',
  'wss://nos.lol',
  'wss://index.hzrd149.com',
  'wss://relay.ditto.pub',
];

const POLL_INTERVAL_MS = 3000; // Poll every 3 seconds (was 5)

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
// File-backed KeyValueStore (survives restarts!)
// ---------------------------------------------------------------------------

// State directory — persists MLS keys and group state across restarts
const STATE_DIR = path.join(process.cwd(), '.marmot-state');

class FileBackedKVStore<T = any> {
  private store = new Map<string, T>();
  private filePath: string;

  constructor(name: string) {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    this.filePath = path.join(STATE_DIR, `${name}.json`);
    this.loadFromDisk();
  }

  private loadFromDisk(): void {
    try {
      if (fs.existsSync(this.filePath)) {
        const data = JSON.parse(fs.readFileSync(this.filePath, 'utf-8'));
        for (const [k, v] of Object.entries(data)) {
          this.store.set(k, v as T);
        }
        log('STORE', `Loaded ${this.store.size} entries from ${path.basename(this.filePath)}`);
      }
    } catch (err: any) {
      log('WARN', `Failed to load store ${this.filePath}`, { error: err?.message });
    }
  }

  private saveToDisk(): void {
    try {
      const obj: Record<string, T> = {};
      for (const [k, v] of this.store) {
        obj[k] = v;
      }
      fs.writeFileSync(this.filePath, JSON.stringify(obj, (_key, value) =>
        typeof value === 'bigint' ? value.toString() : value, 2), 'utf-8');
    } catch (err: any) {
      log('WARN', `Failed to save store ${this.filePath}`, { error: err?.message });
    }
  }

  async getItem(key: string): Promise<T | null> {
    return this.store.get(key) ?? null;
  }
  async setItem(key: string, value: T): Promise<T> {
    this.store.set(key, value);
    this.saveToDisk();
    return value;
  }
  async removeItem(key: string): Promise<void> {
    this.store.delete(key);
    this.saveToDisk();
  }
  async clear(): Promise<void> {
    this.store.clear();
    this.saveToDisk();
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
  console.log(`  Transport:       ${relays.join(', ')}`);
  console.log(`  Discovery:       ${DISCOVERY_RELAYS.join(', ')}`);
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
  // Use ALL relays for the adapter so gift wraps can be received on any relay
  const allRelays = [...new Set([...relays, ...DISCOVERY_RELAYS])];
  const network = new TestNetworkAdapter(allRelays);

  // --- Storage (file-backed, survives restarts!) ---
  log('INIT', `State directory: ${STATE_DIR}`);
  const groupStateBackend = new KeyValueGroupStateBackend(new FileBackedKVStore('group-state'));
  const keyPackageStore = new KeyPackageStore(new FileBackedKVStore('key-packages'));

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
      received: new FileBackedKVStore('invites-received'),
      unread: new FileBackedKVStore('invites-unread'),
      seen: new FileBackedKVStore('invites-seen'),
    },
  });

  // --- Publish kind 0 profile metadata (so White Noise can find us in search) ---
  log('INIT', `Publishing profile metadata (kind 0) to ${allRelays.length} relays...`);
  try {
    const profileEvent = signer.signEvent({
      kind: 0,
      created_at: Math.floor(Date.now() / 1000),
      tags: [],
      content: JSON.stringify({
        name: 'NanoClaw Bot',
        about: 'NanoClaw Marmot/White Noise test bot',
        picture: '',
      }),
    } as any);
    await network.publish(allRelays, profileEvent);
    log('INIT', 'Profile metadata published (kind 0)');
  } catch (err: any) {
    log('ERROR', 'Failed to publish profile', { error: err?.message });
  }

  // --- Publish kind 10002 NIP-65 relay list (White Noise uses for user discovery AND gift wrap fallback) ---
  log('INIT', 'Publishing NIP-65 relay list (kind 10002)...');
  try {
    const nip65Event = signer.signEvent({
      kind: 10002,
      created_at: Math.floor(Date.now() / 1000),
      tags: allRelays.map((r) => ['r', r]),
      content: '',
    } as any);
    await network.publish(allRelays, nip65Event);
    log('INIT', `NIP-65 relay list published (kind 10002) with ${allRelays.length} relays`);
  } catch (err: any) {
    log('ERROR', 'Failed to publish NIP-65 relay list', { error: err?.message });
  }

  // --- Publish kind 10050 NIP-17 Inbox Relay List (White Noise sends gift wraps HERE first!) ---
  // This is the PRIMARY relay list White Noise checks for delivering
  // welcome messages (kind 1059 gift wraps). Without this, it falls back to NIP-65.
  log('INIT', 'Publishing NIP-17 Inbox relay list (kind 10050)...');
  try {
    const inboxRelayEvent = signer.signEvent({
      kind: 10050,
      created_at: Math.floor(Date.now() / 1000),
      tags: relays.map((r) => ['relay', r]),
      content: '',
    } as any);
    await network.publish(allRelays, inboxRelayEvent);
    log('INIT', `Inbox relay list published (kind 10050) with ${relays.length} relays`);
  } catch (err: any) {
    log('ERROR', 'Failed to publish inbox relay list', { error: err?.message });
  }

  // --- Publish kind 10051 KeyPackage Relay List (tells White Noise WHERE to find our KeyPackages) ---
  log('INIT', 'Publishing KeyPackage relay list (kind 10051)...');
  try {
    const relayListUnsigned = createKeyPackageRelayListEvent({
      pubkey,
      relays: allRelays,
      client: 'NanoClaw/marmot-test',
    });
    const relayListEvent = signer.signEvent(relayListUnsigned);
    await network.publish(allRelays, relayListEvent);
    log('INIT', `KeyPackage relay list published (kind ${KEY_PACKAGE_RELAY_LIST_KIND}) with ${allRelays.length} relays`);
  } catch (err: any) {
    log('ERROR', 'Failed to publish relay list', { error: err?.message });
  }

  // --- Publish KeyPackage (kind 443) ---
  log('INIT', 'Publishing KeyPackage (kind 443)...');
  try {
    await marmotClient.keyPackages.create({
      relays: allRelays,
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
   *
   * IMPORTANT: nostrGroupIdHex is the Marmot "nostrGroupId" from MarmotGroupData
   * (used in `#h` tags on kind 445 events). This is DIFFERENT from the MLS
   * internal group ID (group.idStr / groupContext.groupId).
   */
  async function subscribeToGroup(mlsGroupIdHex: string, nostrGroupIdHex: string, groupName: string): Promise<void> {
    if (subscriptions.has(nostrGroupIdHex)) return;

    // Get the group's configured relays (set by the group creator — White Noise)
    let groupRelays: string[] = [];
    try {
      const group = await marmotClient.getGroup(mlsGroupIdHex);
      groupRelays = group.relays || [];
      log('GROUP', `Group relays from MLS config: ${groupRelays.join(', ') || 'none'}`);
    } catch (err: any) {
      log('WARN', `Could not get group relays`, { error: err?.message });
    }

    // Subscribe to ALL relays: our relays + the group's relays
    const subscribeRelays = [...new Set([...allRelays, ...groupRelays])];
    log('GROUP', `Subscribing to group ${groupName} on ${subscribeRelays.length} relays`, {
      mlsGroupId: mlsGroupIdHex.slice(0, 24) + '...',
      nostrGroupId: nostrGroupIdHex.slice(0, 24) + '...',
      subscribeRelays,
    });

    const sub = network.subscribeNative(
      subscribeRelays,
      {
        kinds: [GROUP_EVENT_KIND],
        '#h': [nostrGroupIdHex],  // MUST use nostrGroupId, NOT MLS group ID!
        since: Math.floor(Date.now() / 1000) - 300, // Look back 5 minutes
      },
      {
        onevent: async (event: any) => {
          log('DEBUG', `Received kind ${event.kind} event for group`, {
            eventId: event.id?.slice(0, 16),
            from: event.pubkey?.slice(0, 12),
            isOwnEvent: event.pubkey === pubkey,
          });

          // Skip our own events
          if (event.pubkey === pubkey) return;

          try {
            const group = await marmotClient.getGroup(mlsGroupIdHex);

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
              } else if (result.kind === 'processed') {
                log('DEBUG', `Processed MLS message type: ${result.result.kind}`, {
                  eventId: event.id?.slice(0, 16),
                });
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

    subscriptions.set(nostrGroupIdHex, sub);
    log('GROUP', `Subscribed to kind ${GROUP_EVENT_KIND} events for group`, {
      nostrGroupId: nostrGroupIdHex.slice(0, 24) + '...',
    });
  }

  // --- Listen for new groups joined via welcome ---
  marmotClient.on('groupJoined', (group) => {
    const mlsGroupIdHex = group.idStr;
    const groupName = group.groupData?.name || `marmot:${mlsGroupIdHex.slice(0, 12)}`;

    // Extract the nostrGroupId (used in #h tags on kind 445 events)
    // This is DIFFERENT from the MLS internal group ID (group.idStr).
    // We use the SAME function (getNostrGroupIdHex) that createGroupEvent uses
    // when building the #h tag, so the subscription filter is guaranteed to match.
    let nostrGroupIdHex: string;
    try {
      nostrGroupIdHex = getNostrGroupIdHex(group.state);
    } catch (err: any) {
      log('WARN', `Failed to extract nostrGroupId: ${err?.message}, falling back to MLS group ID`);
      nostrGroupIdHex = mlsGroupIdHex;
    }

    console.log('');
    log('JOIN', `🎉 Joined new Marmot group: ${groupName}`, {
      mlsGroupId: mlsGroupIdHex.slice(0, 24) + '...',
      nostrGroupId: nostrGroupIdHex.slice(0, 24) + '...',
    });
    console.log('');

    lastJoinedGroupId = mlsGroupIdHex;
    subscribeToGroup(mlsGroupIdHex, nostrGroupIdHex, groupName);

    // Perform self-update for forward secrecy (MIP-02)
    group.selfUpdate().catch((err: any) => {
      log('WARN', 'Failed self-update after join', { error: err?.message });
    });
  });

  // --- Process ALL historical gift wraps first (critical for ephemeral storage!) ---
  // Since we use in-memory storage, we lose group state on restart.
  // White Noise only sends the Welcome once — we must replay it from relays.
  const seenGiftWrapIds = new Set<string>();

  log('INIT', 'Fetching ALL historical gift wraps (no time filter)...');
  try {
    const historicalGiftWraps = await network.request(allRelays, {
      kinds: [1059],
      '#p': [pubkey],
      limit: 50,
    });
    log('INIT', `Found ${historicalGiftWraps.length} historical gift wrap(s)`);

    if (historicalGiftWraps.length > 0) {
      // Mark all as seen
      for (const gw of historicalGiftWraps) {
        seenGiftWrapIds.add(gw.id);
        log('INIT', `  Gift wrap: ${gw.id?.slice(0, 16)}`, {
          created_at: new Date((gw.created_at || 0) * 1000).toISOString(),
          contentLen: gw.content?.length,
        });
      }

      // Ingest and process
      const newCount = await inviteReader.ingestEvents(historicalGiftWraps);
      log('INIT', `Ingested ${newCount} gift wrap(s)`);

      if (newCount > 0) {
        const invites = await inviteReader.decryptGiftWraps();
        log('INIT', `Decrypted ${invites.length} invite(s) from historical gift wraps`);

        for (const invite of invites) {
          log('INIT', `Processing historical invite`, {
            inviteId: invite.id?.slice(0, 16),
            kind: (invite as any).kind,
          });

          try {
            const { group } = await marmotClient.joinGroupFromWelcome({
              welcomeRumor: invite,
            });

            log('INIT', `✅ Joined group from historical welcome!`, {
              groupId: group.idStr.slice(0, 24) + '...',
            });

            await inviteReader.markAsRead(invite.id);
          } catch (joinErr: any) {
            log('INIT', `Failed to join from historical welcome (may be stale)`, {
              error: joinErr?.message,
            });
          }
        }
      }
    }
  } catch (err: any) {
    log('ERROR', 'Failed to process historical gift wraps', { error: err?.message });
  }

  // --- Real-time subscription for gift wraps (kind 1059) ---
  // This catches events in real-time as they arrive, no polling delay.
  log('INIT', `Setting up real-time gift wrap subscription on ${allRelays.length} relays...`);

  const giftWrapSub = network.subscribeNative(
    allRelays,
    {
      kinds: [1059],
      '#p': [pubkey],
      since: Math.floor(Date.now() / 1000) - 300, // Look back 5 minutes
    },
    {
      onevent: async (event: any) => {
        if (seenGiftWrapIds.has(event.id)) return;
        seenGiftWrapIds.add(event.id);

        log('GIFTWRAP', `Received gift wrap event`, {
          eventId: event.id?.slice(0, 16),
          kind: event.kind,
          from: event.pubkey?.slice(0, 12),
          created_at: new Date((event.created_at || 0) * 1000).toISOString(),
          tagCount: event.tags?.length,
        });

        try {
          const newCount = await inviteReader.ingestEvents([event]);
          log('GIFTWRAP', `Ingested: ${newCount} new gift wrap(s)`);

          if (newCount > 0) {
            const invites = await inviteReader.decryptGiftWraps();
            log('GIFTWRAP', `Decrypted ${invites.length} invite(s)`);

            for (const invite of invites) {
              log('GIFTWRAP', `Processing invite`, {
                inviteId: invite.id?.slice(0, 16),
                kind: (invite as any).kind,
                tags: (invite as any).tags?.slice(0, 3),
              });

              try {
                const { group } = await marmotClient.joinGroupFromWelcome({
                  welcomeRumor: invite,
                });

                log('GIFTWRAP', `✅ Joined group from welcome!`, {
                  groupId: group.idStr.slice(0, 24) + '...',
                });

                await inviteReader.markAsRead(invite.id);
              } catch (joinErr: any) {
                log('ERROR', 'Failed to join from welcome', {
                  error: joinErr?.message,
                  stack: joinErr?.stack?.split('\n').slice(0, 3).join(' | '),
                });
              }
            }
          }
        } catch (err: any) {
          log('ERROR', 'Failed to process gift wrap', {
            error: err?.message,
          });
        }
      },
      oneose: () => {
        log('GIFTWRAP', 'End of stored gift wraps, now listening in real-time');
      },
    },
  );

  log('INIT', `Real-time gift wrap subscription active on ${allRelays.length} relays`);

  // --- Fallback polling for gift wraps (catches anything the subscription might miss) ---
  let lastCheck = Math.floor(Date.now() / 1000) - 300; // Start from 5 min ago
  let pollCount = 0;

  const pollTimer = setInterval(async () => {
    pollCount++;
    try {
      // Query ALL relays (transport + discovery)
      const events = await network.request(allRelays, {
        kinds: [1059],
        '#p': [pubkey],
        since: lastCheck,
      });

      // Log every 10th poll or when events found
      if (events.length > 0 || pollCount % 10 === 0) {
        log('POLL', `Poll #${pollCount}: ${events.length} gift wrap(s) found`, {
          since: new Date(lastCheck * 1000).toISOString(),
          relayCount: allRelays.length,
        });
      }

      if (events.length > 0) {
        // Filter out already-seen events
        const newEvents = events.filter((e: any) => {
          if (seenGiftWrapIds.has(e.id)) return false;
          seenGiftWrapIds.add(e.id);
          return true;
        });

        if (newEvents.length > 0) {
          log('POLL', `${newEvents.length} NEW gift wrap(s) to process`);

          const newCount = await inviteReader.ingestEvents(newEvents);

          if (newCount > 0) {
            log('POLL', `${newCount} new gift wrap(s) ingested, decrypting...`);

            const invites = await inviteReader.decryptGiftWraps();
            log('POLL', `Decrypted ${invites.length} invite(s)`);

            for (const invite of invites) {
              try {
                const { group } = await marmotClient.joinGroupFromWelcome({
                  welcomeRumor: invite,
                });

                log('POLL', `✅ Joined group from welcome`, {
                  groupId: group.idStr.slice(0, 24) + '...',
                });

                await inviteReader.markAsRead(invite.id);
              } catch (joinErr: any) {
                log('ERROR', 'Failed to join from welcome (poll)', {
                  error: joinErr?.message,
                });
              }
            }
          }
        }
      }

      lastCheck = Math.floor(Date.now() / 1000);
    } catch (err: any) {
      log('WARN', 'Welcome poll failed', { error: err?.message });
    }
  }, POLL_INTERVAL_MS);

  log('POLL', `Fallback poller started (every ${POLL_INTERVAL_MS}ms on ${allRelays.length} relays)`);

  // --- Periodic diagnostic: re-check for new gift wraps every 30 seconds ---
  setInterval(async () => {
    try {
      const allGiftWraps = await network.request(allRelays, {
        kinds: [1059],
        '#p': [pubkey],
        limit: 50,
      });
      const newOnes = allGiftWraps.filter((e: any) => !seenGiftWrapIds.has(e.id));
      if (newOnes.length > 0) {
        log('DIAG', `Found ${newOnes.length} NEW gift wrap(s) via periodic broad scan`);
        for (const gw of newOnes) {
          seenGiftWrapIds.add(gw.id);
        }
        const newCount = await inviteReader.ingestEvents(newOnes);
        if (newCount > 0) {
          const invites = await inviteReader.decryptGiftWraps();
          for (const invite of invites) {
            try {
              const { group } = await marmotClient.joinGroupFromWelcome({
                welcomeRumor: invite,
              });
              log('DIAG', `✅ Joined group from welcome (broad scan)`, {
                groupId: group.idStr.slice(0, 24) + '...',
              });
              await inviteReader.markAsRead(invite.id);
            } catch (joinErr: any) {
              log('ERROR', 'Failed to join from welcome (broad scan)', {
                error: joinErr?.message,
              });
            }
          }
        }
      }
    } catch {
      // Silent fail on periodic check
    }
  }, 30000); // Every 30 seconds

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

    giftWrapSub.close();

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
