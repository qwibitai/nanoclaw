/**
 * Marmot / White Noise channel for NanoClaw.
 *
 * Enables decentralized, end-to-end encrypted group messaging using the
 * Marmot protocol (MLS + Nostr). Compatible with the White Noise app and
 * any other Marmot-protocol client.
 *
 * Uses @internet-privacy/marmot-ts for full MLS encryption:
 * - Kind 443: KeyPackage events (advertise our identity for group invites)
 * - Kind 444: Welcome events (encrypted group invitations via NIP-59 gift wrap)
 * - Kind 445: Group events (MLS-encrypted application messages)
 *
 * @see https://github.com/marmot-protocol/marmot-ts
 * @see https://marmot.build
 */

import { getPublicKey, finalizeEvent, type UnsignedEvent } from 'nostr-tools';
import { SimplePool, type SubCloser } from 'nostr-tools/pool';
import { hexToBytes } from 'nostr-tools/utils';
import * as nip44 from 'nostr-tools/nip44';

import {
  MarmotClient,
  KeyValueGroupStateBackend,
  KeyPackageStore,
  InviteReader,
  deserializeApplicationRumor,
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
import {
  MARMOT_NOSTR_PRIVATE_KEY,
  MARMOT_NOSTR_RELAYS,
  MARMOT_POLL_INTERVAL_MS,
} from '../config.js';
import { logger } from '../logger.js';
import { Channel } from '../types.js';
import { registerChannel, type ChannelOpts } from './registry.js';

// ---------------------------------------------------------------------------
// Simple in-memory KeyValueStoreBackend (marmot-ts has one in /extra
// but doesn't export it via the package.json "exports" map)
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
// JID helpers
// ---------------------------------------------------------------------------

const MARMOT_PREFIX = 'marmot:';

function jidFromGroupId(groupIdHex: string): string {
  return `${MARMOT_PREFIX}${groupIdHex}`;
}

function groupIdFromJid(jid: string): string | null {
  if (!jid.startsWith(MARMOT_PREFIX)) return null;
  return jid.slice(MARMOT_PREFIX.length);
}

// ---------------------------------------------------------------------------
// Applesauce EventSigner adapter (wraps a raw nsec hex key)
// ---------------------------------------------------------------------------

class MarmotEventSigner {
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

  /** NIP-44 encryption/decryption — required for gift-wrap welcome messages */
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
// NostrNetworkInterface adapter (wraps SimplePool for marmot-ts)
// ---------------------------------------------------------------------------

class MarmotNetworkAdapter implements NostrNetworkInterface {
  private pool: SimplePool;
  private defaultRelays: string[];

  constructor(relays: string[]) {
    this.pool = new SimplePool();
    this.defaultRelays = relays;
  }

  async publish(
    relays: string[],
    event: any,
  ): Promise<Record<string, PublishResponse>> {
    const targets = relays.length > 0 ? relays : this.defaultRelays;
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
          logger.debug(
            { relay: targets[i], err: err?.message },
            'Relay publish failed',
          );
        }
      }),
    );

    return results;
  }

  async request(
    relays: string[],
    filters: any | any[],
  ): Promise<any[]> {
    const targets = relays.length > 0 ? relays : this.defaultRelays;
    // querySync takes a single filter, not an array
    const filter = Array.isArray(filters) ? filters[0] : filters;
    return await this.pool.querySync(targets, filter);
  }

  subscription(
    relays: string[],
    filters: any | any[],
  ): Subscribable<any> {
    const targets = relays.length > 0 ? relays : this.defaultRelays;
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
            // End of stored events — keep subscription open for real-time
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
    // For now, return default relays. Full implementation would fetch
    // kind 10051 key package relay list events for the given pubkey.
    return this.defaultRelays;
  }

  /** Subscribe using SimplePool's native API (for NanoClaw polling) */
  subscribeNative(
    relays: string[],
    filter: Record<string, any>,
    handlers: { onevent: (event: any) => void; oneose?: () => void },
  ): SubCloser {
    const targets = relays.length > 0 ? relays : this.defaultRelays;
    return this.pool.subscribeMany(targets, filter as any, handlers);
  }

  close(): void {
    this.pool.close(this.defaultRelays);
  }
}

// ---------------------------------------------------------------------------
// MarmotChannel — NanoClaw Channel implementation with full MLS encryption
// ---------------------------------------------------------------------------

export class MarmotChannel implements Channel {
  name = 'marmot';

  private opts: ChannelOpts;
  private network: MarmotNetworkAdapter | null = null;
  private signer: MarmotEventSigner | null = null;
  private marmotClient: MarmotClient | null = null;
  private inviteReader: InviteReader | null = null;
  private connected = false;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private subscriptions = new Map<string, { close: () => void }>();

  constructor(opts: ChannelOpts) {
    this.opts = opts;
  }

  async connect(): Promise<void> {
    if (!MARMOT_NOSTR_PRIVATE_KEY) {
      throw new Error(
        'MARMOT_NOSTR_PRIVATE_KEY is required. Generate with: ' +
          'node -e "import(\'nostr-tools\').then(n => console.log(Buffer.from(n.generateSecretKey()).toString(\'hex\')))"',
      );
    }

    if (MARMOT_NOSTR_RELAYS.length === 0) {
      throw new Error(
        'MARMOT_NOSTR_RELAYS is required. Example: wss://relay.damus.io,wss://nos.lol',
      );
    }

    // Initialize signer with Nostr private key
    this.signer = new MarmotEventSigner(MARMOT_NOSTR_PRIVATE_KEY);
    const pubkey = this.signer.getPublicKey();

    // Initialize Nostr relay pool (implements NostrNetworkInterface)
    this.network = new MarmotNetworkAdapter(MARMOT_NOSTR_RELAYS);

    // Initialize storage backends (in-memory, ephemeral per session)
    const groupStateBackend = new KeyValueGroupStateBackend(
      new InMemoryKVStore(),
    );
    const keyPackageStore = new KeyPackageStore(new InMemoryKVStore());

    // Initialize MarmotClient for full MLS encryption
    this.marmotClient = new MarmotClient({
      signer: this.signer as any,
      groupStateBackend,
      keyPackageStore,
      network: this.network,
    });

    // Initialize InviteReader for processing welcome messages
    this.inviteReader = new InviteReader({
      signer: this.signer as any,
      store: {
        received: new InMemoryKVStore(),
        unread: new InMemoryKVStore(),
        seen: new InMemoryKVStore(),
      },
    });

    // Publish kind 0 profile metadata so White Noise can discover us
    try {
      const profileEvent = this.signer.signEvent({
        kind: 0,
        pubkey,
        created_at: Math.floor(Date.now() / 1000),
        tags: [],
        content: JSON.stringify({
          name: 'NanoClaw Bot',
          about: 'NanoClaw assistant via Marmot/White Noise',
        }),
      } as UnsignedEvent);
      await this.network.publish(MARMOT_NOSTR_RELAYS, profileEvent);
      logger.info('Profile metadata published (kind 0)');
    } catch (err) {
      logger.error({ err }, 'Failed to publish profile metadata');
    }

    // Publish kind 10051 KeyPackage Relay List (tells White Noise WHERE our KeyPackages are)
    try {
      const relayListUnsigned = createKeyPackageRelayListEvent({
        pubkey,
        relays: MARMOT_NOSTR_RELAYS,
        client: 'NanoClaw/marmot',
      });
      const relayListEvent = this.signer.signEvent(relayListUnsigned);
      await this.network.publish(MARMOT_NOSTR_RELAYS, relayListEvent);
      logger.info(
        { kind: KEY_PACKAGE_RELAY_LIST_KIND, relayCount: MARMOT_NOSTR_RELAYS.length },
        'KeyPackage relay list published (kind 10051)',
      );
    } catch (err) {
      logger.error({ err }, 'Failed to publish KeyPackage relay list');
    }

    // Publish a KeyPackage so White Noise users can invite us
    try {
      await this.marmotClient.keyPackages.create({
        relays: MARMOT_NOSTR_RELAYS,
        client: 'NanoClaw/marmot',
        isLastResort: true,
      });
      logger.info({ pubkey: pubkey.slice(0, 16) }, 'KeyPackage published');
    } catch (err) {
      logger.error({ err }, 'Failed to publish KeyPackage');
    }

    // Load any existing groups from store
    try {
      await this.marmotClient.loadAllGroups();
    } catch (err) {
      logger.debug({ err }, 'No existing groups to load');
    }

    // Subscribe to registered Marmot groups
    const registeredGroups = this.opts.registeredGroups();
    for (const [jid, group] of Object.entries(registeredGroups)) {
      const groupId = groupIdFromJid(jid);
      if (!groupId) continue;
      this.subscribeToGroup(groupId, group.name);
    }

    // Start polling for welcome messages (group invitations)
    this.startWelcomePoller(pubkey);

    // Listen for new groups joined via welcome
    this.marmotClient.on('groupJoined', (group) => {
      const groupIdHex = group.idStr;
      const jid = jidFromGroupId(groupIdHex);
      logger.info({ jid, groupIdHex }, 'Joined new Marmot group via welcome');

      // Subscribe to group messages
      this.subscribeToGroup(groupIdHex, `marmot:${groupIdHex.slice(0, 12)}`);

      // Notify NanoClaw of the new group
      this.opts.onChatMetadata(
        jid,
        new Date().toISOString(),
        `Marmot Group ${groupIdHex.slice(0, 8)}`,
        'marmot',
        true,
      );

      // Perform self-update for forward secrecy (MIP-02)
      group.selfUpdate().catch((err: any) => {
        logger.warn({ err }, 'Failed self-update after join');
      });
    });

    this.connected = true;

    console.log(`\n  Marmot channel (MLS encrypted): npub ${pubkey.slice(0, 16)}...`);
    console.log(`  Relays: ${MARMOT_NOSTR_RELAYS.join(', ')}`);
    console.log(`  KeyPackage published (kind ${KEY_PACKAGE_KIND})`);
    console.log(
      `  Send a White Noise invite to this npub to start messaging\n`,
    );

    logger.info(
      { pubkey, relays: MARMOT_NOSTR_RELAYS },
      'Marmot channel connected (MLS encryption active)',
    );
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    if (!this.marmotClient || !this.signer) {
      logger.warn('Marmot client not initialized');
      return;
    }

    const groupId = groupIdFromJid(jid);
    if (!groupId) {
      logger.warn({ jid }, 'Invalid Marmot JID');
      return;
    }

    try {
      // Get the MarmotGroup instance
      const group = await this.marmotClient.getGroup(groupId);

      // Send encrypted chat message (kind 9 rumor → MLS encrypted → kind 445)
      await group.sendChatMessage(text);

      logger.info({ jid, length: text.length }, 'Marmot message sent (MLS encrypted)');
    } catch (err) {
      logger.error({ jid, err }, 'Failed to send Marmot message');
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith(MARMOT_PREFIX);
  }

  async disconnect(): Promise<void> {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }

    for (const [, sub] of this.subscriptions) {
      sub.close();
    }
    this.subscriptions.clear();

    if (this.network) {
      this.network.close();
      this.network = null;
    }

    this.marmotClient = null;
    this.inviteReader = null;
    this.signer = null;
    this.connected = false;

    logger.info('Marmot channel disconnected');
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /**
   * Subscribe to messages for a Marmot group.
   * Listens for kind 445 (MLS-encrypted group events) tagged with the group ID.
   */
  private subscribeToGroup(groupIdHex: string, groupName: string): void {
    if (!this.network) return;
    if (this.subscriptions.has(groupIdHex)) return;

    const jid = jidFromGroupId(groupIdHex);

    // Subscribe to kind 445 group events using the `h` tag (group ID hash)
    const sub = this.network.subscribeNative(
      MARMOT_NOSTR_RELAYS,
      {
        kinds: [GROUP_EVENT_KIND],
        '#h': [groupIdHex],
        since: Math.floor(Date.now() / 1000),
      },
      {
        onevent: (event: any) => {
          this.handleGroupEvent(jid, groupIdHex, groupName, event);
        },
      },
    );

    this.subscriptions.set(groupIdHex, sub);
    logger.info({ jid, groupIdHex }, 'Subscribed to Marmot group (kind 445)');
  }

  /**
   * Handle an incoming kind 445 group event.
   * Uses MarmotGroup.ingest() to decrypt MLS messages.
   */
  private async handleGroupEvent(
    jid: string,
    groupIdHex: string,
    groupName: string,
    event: any,
  ): Promise<void> {
    if (!this.marmotClient || !this.signer) return;

    // Skip our own messages
    if (event.pubkey === this.signer.pubkeyHex) return;

    try {
      const group = await this.marmotClient.getGroup(groupIdHex);

      // Ingest the encrypted event through MLS
      for await (const result of group.ingest([event])) {
        if (
          result.kind === 'processed' &&
          result.result.kind === 'applicationMessage'
        ) {
          // Decrypt success — deserialize the application rumor
          try {
            const rumor = deserializeApplicationRumor(
              result.result.message,
            );

            const senderPubkey = rumor.pubkey || event.pubkey || 'unknown';
            const senderName = senderPubkey.slice(0, 12) + '...';

            this.opts.onChatMetadata(
              jid,
              new Date().toISOString(),
              groupName,
              'marmot',
              true,
            );

            this.opts.onMessage(jid, {
              id:
                rumor.id ||
                event.id ||
                `marmot-${Date.now()}-${Math.random().toString(36).slice(2)}`,
              chat_jid: jid,
              sender: senderPubkey,
              sender_name: senderName,
              content: rumor.content || '',
              timestamp: rumor.created_at
                ? new Date(rumor.created_at * 1000).toISOString()
                : new Date().toISOString(),
              is_from_me: false,
            });

            logger.info(
              { jid, sender: senderName },
              'Marmot message received (MLS decrypted)',
            );
          } catch (deserializeErr) {
            logger.warn(
              { err: deserializeErr },
              'Failed to deserialize application rumor',
            );
          }
        } else if (result.kind === 'unreadable') {
          logger.debug(
            { eventId: event.id?.slice(0, 16), errors: result.errors },
            'Unreadable Marmot event (may be commit/proposal)',
          );
        } else if (result.kind === 'skipped') {
          logger.debug(
            { eventId: event.id?.slice(0, 16), reason: result.reason },
            'Skipped Marmot event',
          );
        }
      }

      // Save group state after processing
      await group.save();
    } catch (err) {
      logger.error(
        { jid, eventId: event.id?.slice(0, 16), err },
        'Failed to process Marmot group event',
      );
    }
  }

  /**
   * Poll for Welcome messages (group invitations) via NIP-59 gift wrap.
   * Uses InviteReader to decrypt and process incoming invitations.
   */
  private startWelcomePoller(pubkey: string): void {
    if (!this.network) return;

    const pollInterval = MARMOT_POLL_INTERVAL_MS;
    let lastCheck = Math.floor(Date.now() / 1000);

    this.pollTimer = setInterval(async () => {
      if (!this.network || !this.marmotClient || !this.inviteReader) return;

      try {
        // Fetch gift-wrapped welcome events
        const events = await this.network.request(MARMOT_NOSTR_RELAYS, {
          kinds: [1059],
          '#p': [pubkey],
          since: lastCheck,
        });

        if (events.length > 0) {
          logger.info(
            { count: events.length },
            'Received potential welcome events',
          );

          // Ingest gift wraps into the invite reader
          const newCount = await this.inviteReader.ingestEvents(events);

          if (newCount > 0) {
            // Decrypt the gift wraps
            const invites = await this.inviteReader.decryptGiftWraps();

            // Join groups from welcome messages
            for (const invite of invites) {
              try {
                const { group } =
                  await this.marmotClient!.joinGroupFromWelcome({
                    welcomeRumor: invite,
                  });

                logger.info(
                  { groupId: group.idStr.slice(0, 16) },
                  'Joined Marmot group from welcome',
                );

                // Mark invite as read
                await this.inviteReader!.markAsRead(invite.id);
              } catch (joinErr) {
                logger.warn({ err: joinErr }, 'Failed to join from welcome');
              }
            }
          }
        }

        lastCheck = Math.floor(Date.now() / 1000);
      } catch (err) {
        logger.warn({ err }, 'Marmot welcome poll failed');
      }
    }, pollInterval);

    logger.info(
      { pollInterval, pubkey: pubkey.slice(0, 16) },
      'Marmot welcome poller started',
    );
  }
}

// ---------------------------------------------------------------------------
// Self-registration — called when this module is imported via the barrel file
// ---------------------------------------------------------------------------

registerChannel('marmot', (opts: ChannelOpts) => {
  if (!MARMOT_NOSTR_PRIVATE_KEY || MARMOT_NOSTR_RELAYS.length === 0) {
    return null; // Credentials not configured — skip
  }
  return new MarmotChannel(opts);
});
