/**
 * Marmot / White Noise channel for NanoClaw.
 *
 * Enables decentralized, end-to-end encrypted group messaging using the
 * Marmot protocol (MLS + Nostr). Compatible with the White Noise app and
 * any other Marmot-protocol client.
 *
 * Key technical decisions:
 * - SQLite-backed storage for MLS group state and key packages (survives restarts)
 * - Welcome processing via NIP-59 gift wrap polling (auto-join groups)
 * - nostrGroupId (MarmotGroupData extension) used for #h tag subscriptions
 * - Serialized ingest queue prevents concurrent MLS state corruption
 * - Self-echo filtering via sent event ID tracking
 *
 * @see https://github.com/marmot-protocol/marmot-ts
 * @see https://marmot.build
 */

import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

import { generateSecretKey, getPublicKey, finalizeEvent, type UnsignedEvent } from 'nostr-tools';
import { SimplePool, type SubCloser } from 'nostr-tools/pool';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils';
import type { EventSigner } from 'applesauce-core';
import type { NostrEvent } from 'applesauce-core/helpers/event';
import type { Filter } from 'applesauce-core/helpers/filter';
import { MarmotClient, type MarmotClientOptions } from 'marmot-ts';
import type {
  NostrNetworkInterface,
  PublishResponse,
  Subscribable,
  Observer,
  Unsubscribable,
} from 'marmot-ts/client/nostr-interface';
import type {
  GroupStateStoreBackend,
  SerializedClientState,
} from 'marmot-ts/store/group-state-store';
import type { KeyPackageStore, StoredKeyPackage } from 'marmot-ts/store/key-package-store';

import { STORE_DIR } from '../config.js';
import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';
import {
  Channel,
  OnChatMetadata,
  OnInboundMessage,
  RegisteredGroup,
} from '../types.js';
import { registerChannel, type ChannelOpts } from './registry.js';

// ---------------------------------------------------------------------------
// Marmot-specific configuration (self-contained — not in global config.ts)
// ---------------------------------------------------------------------------

const marmotEnv = readEnvFile([
  'MARMOT_NOSTR_PRIVATE_KEY',
  'MARMOT_NOSTR_RELAYS',
  'MARMOT_POLL_INTERVAL_MS',
]);

const MARMOT_NOSTR_PRIVATE_KEY =
  process.env.MARMOT_NOSTR_PRIVATE_KEY || marmotEnv.MARMOT_NOSTR_PRIVATE_KEY || '';

const MARMOT_NOSTR_RELAYS: string[] = (
  process.env.MARMOT_NOSTR_RELAYS ||
  marmotEnv.MARMOT_NOSTR_RELAYS ||
  ''
)
  .split(',')
  .map((r: string) => r.trim())
  .filter((r: string) => r.length > 0);

const MARMOT_POLL_INTERVAL_MS = parseInt(
  process.env.MARMOT_POLL_INTERVAL_MS || marmotEnv.MARMOT_POLL_INTERVAL_MS || '5000',
  10,
);

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
// SQLite-backed GroupStateStore
// ---------------------------------------------------------------------------

/**
 * SQLite-backed MLS group state storage.
 *
 * Persists MLS group state across process restarts. This is critical because
 * White Noise only sends the Welcome message once per group — if state is lost,
 * the group is lost forever.
 *
 * Schema:
 *   marmot_groups(group_id BLOB PK, state BLOB, created_at INT, updated_at INT)
 */
export class SqliteGroupStateBackend implements GroupStateStoreBackend {
  private db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  async get(groupId: Uint8Array): Promise<SerializedClientState | null> {
    const row = this.db
      .prepare('SELECT state FROM marmot_groups WHERE group_id = ?')
      .get(Buffer.from(groupId)) as { state: Buffer } | undefined;

    if (!row) return null;

    // SerializedClientState is stored as a JSON blob
    try {
      return JSON.parse(row.state.toString('utf8'));
    } catch {
      // If stored as raw bytes, return as-is (for forward compat)
      return row.state as unknown as SerializedClientState;
    }
  }

  async set(groupId: Uint8Array, state: SerializedClientState): Promise<void> {
    const now = Math.floor(Date.now() / 1000);
    const stateBlob = Buffer.from(JSON.stringify(state), 'utf8');

    this.db
      .prepare(
        `INSERT INTO marmot_groups (group_id, state, created_at, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(group_id) DO UPDATE SET state = excluded.state, updated_at = excluded.updated_at`,
      )
      .run(Buffer.from(groupId), stateBlob, now, now);
  }

  async has(groupId: Uint8Array): Promise<boolean> {
    const row = this.db
      .prepare('SELECT 1 FROM marmot_groups WHERE group_id = ?')
      .get(Buffer.from(groupId));
    return !!row;
  }

  async delete(groupId: Uint8Array): Promise<void> {
    this.db
      .prepare('DELETE FROM marmot_groups WHERE group_id = ?')
      .run(Buffer.from(groupId));
  }

  async list(): Promise<Uint8Array[]> {
    const rows = this.db
      .prepare('SELECT group_id FROM marmot_groups')
      .all() as Array<{ group_id: Buffer }>;

    return rows.map((r) => new Uint8Array(r.group_id));
  }
}

// ---------------------------------------------------------------------------
// SQLite-backed KeyPackageStore
// ---------------------------------------------------------------------------

/**
 * SQLite-backed MLS key package storage.
 *
 * Key packages contain the private keys needed to process Welcome messages.
 * If these are lost, the agent cannot join groups it was invited to.
 *
 * Schema:
 *   marmot_key_packages(key_package_ref BLOB PK, public_package BLOB,
 *     private_package BLOB, published INT, used INT, created_at INT)
 */
export class SqliteKeyPackageStore implements KeyPackageStore {
  private db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  async get(ref: Uint8Array): Promise<StoredKeyPackage | null> {
    const row = this.db
      .prepare('SELECT * FROM marmot_key_packages WHERE key_package_ref = ?')
      .get(Buffer.from(ref)) as
      | {
          key_package_ref: Buffer;
          public_package: Buffer;
          private_package: Buffer | null;
          published: number;
          used: number;
          created_at: number;
        }
      | undefined;

    if (!row) return null;

    return {
      ref: new Uint8Array(row.key_package_ref),
      publicPackage: new Uint8Array(row.public_package),
      privatePackage: row.private_package
        ? JSON.parse(row.private_package.toString('utf8'))
        : null,
      published: !!row.published,
      used: !!row.used,
    } as StoredKeyPackage;
  }

  async set(ref: Uint8Array, pkg: StoredKeyPackage): Promise<void> {
    const now = Math.floor(Date.now() / 1000);
    const privateBlob = pkg.privatePackage
      ? Buffer.from(JSON.stringify(pkg.privatePackage), 'utf8')
      : null;

    this.db
      .prepare(
        `INSERT INTO marmot_key_packages (key_package_ref, public_package, private_package, published, used, created_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(key_package_ref) DO UPDATE SET
           public_package = excluded.public_package,
           private_package = excluded.private_package,
           published = excluded.published,
           used = excluded.used`,
      )
      .run(
        Buffer.from(ref),
        Buffer.from(pkg.publicPackage || new Uint8Array()),
        privateBlob,
        (pkg as any).published ? 1 : 0,
        (pkg as any).used ? 1 : 0,
        now,
      );
  }

  async list(): Promise<StoredKeyPackage[]> {
    const rows = this.db.prepare('SELECT * FROM marmot_key_packages').all() as Array<{
      key_package_ref: Buffer;
      public_package: Buffer;
      private_package: Buffer | null;
      published: number;
      used: number;
      created_at: number;
    }>;

    return rows.map((row) => ({
      ref: new Uint8Array(row.key_package_ref),
      publicPackage: new Uint8Array(row.public_package),
      privatePackage: row.private_package
        ? JSON.parse(row.private_package.toString('utf8'))
        : null,
      published: !!row.published,
      used: !!row.used,
    })) as StoredKeyPackage[];
  }

  async delete(ref: Uint8Array): Promise<void> {
    this.db
      .prepare('DELETE FROM marmot_key_packages WHERE key_package_ref = ?')
      .run(Buffer.from(ref));
  }

  async getPrivateKey(ref: Uint8Array): Promise<any | null> {
    const pkg = await this.get(ref);
    return pkg?.privatePackage ?? null;
  }

  async markUsed(ref: Uint8Array): Promise<void> {
    this.db
      .prepare('UPDATE marmot_key_packages SET used = 1 WHERE key_package_ref = ?')
      .run(Buffer.from(ref));
  }
}

// ---------------------------------------------------------------------------
// Database initialization
// ---------------------------------------------------------------------------

/**
 * Open (or create) the Marmot SQLite database and ensure tables exist.
 * Stored separately from the main NanoClaw DB to keep concerns isolated.
 */
export function initMarmotDatabase(storePath?: string): Database.Database {
  const dbPath = storePath || path.join(STORE_DIR, 'marmot.db');

  // Ensure the directory exists
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  const db = new Database(dbPath);

  // Enable WAL mode for better concurrent read performance
  db.pragma('journal_mode = WAL');

  db.exec(`
    CREATE TABLE IF NOT EXISTS marmot_groups (
      group_id BLOB PRIMARY KEY,
      state BLOB NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS marmot_key_packages (
      key_package_ref BLOB PRIMARY KEY,
      public_package BLOB NOT NULL,
      private_package BLOB,
      published INTEGER DEFAULT 0,
      used INTEGER DEFAULT 0,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS marmot_processed_events (
      event_id TEXT PRIMARY KEY,
      processed_at INTEGER NOT NULL
    );
  `);

  return db;
}

// ---------------------------------------------------------------------------
// Nostr Network Interface (wraps nostr-tools SimplePool)
// ---------------------------------------------------------------------------

class NostrPoolAdapter implements NostrNetworkInterface {
  private pool: SimplePool;
  private defaultRelays: string[];

  constructor(relays: string[]) {
    this.pool = new SimplePool();
    this.defaultRelays = relays;
  }

  async publish(
    relays: string[],
    event: NostrEvent,
  ): Promise<Record<string, PublishResponse>> {
    const targets = relays.length > 0 ? relays : this.defaultRelays;
    const results: Record<string, PublishResponse> = {};

    await Promise.allSettled(
      targets.map(async (relay) => {
        try {
          await this.pool.publish(targets, event as any);
          results[relay] = { from: relay, ok: true };
        } catch (err) {
          results[relay] = {
            from: relay,
            ok: false,
            message: err instanceof Error ? err.message : String(err),
          };
        }
      }),
    );

    return results;
  }

  async request(
    relays: string[],
    filters: Filter | Filter[],
  ): Promise<NostrEvent[]> {
    const targets = relays.length > 0 ? relays : this.defaultRelays;
    const filterArr = Array.isArray(filters) ? filters : [filters];
    const events = await this.pool.querySync(targets, ...filterArr);
    return events as NostrEvent[];
  }

  subscription(
    relays: string[],
    filters: Filter | Filter[],
  ): Subscribable<NostrEvent> {
    const targets = relays.length > 0 ? relays : this.defaultRelays;
    const filterArr = Array.isArray(filters) ? filters : [filters];

    return {
      subscribe: (observer: Partial<Observer<NostrEvent>>): Unsubscribable => {
        const sub = this.pool.subscribeMany(targets, filterArr, {
          onevent: (event: any) => {
            observer.next?.(event as NostrEvent);
          },
          oneose: () => {
            // End of stored events — subscription stays open for new events
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

  /**
   * Resolve inbox relays for a pubkey using 3-tier resolution:
   * 1. Kind 10051 (NIP-17 DM relay list) — preferred for gift wraps
   * 2. Kind 10002 (NIP-65 relay list) — general relay preferences
   * 3. Fall back to default relays
   *
   * This matches White Noise's relay resolution behavior.
   */
  async getUserInboxRelays(pubkey: string): Promise<string[]> {
    // Tier 1: Kind 10051 (DM relay list, used for gift wraps / key packages)
    const dmRelayEvents = await this.request(this.defaultRelays, [
      { kinds: [10051], authors: [pubkey], limit: 1 },
    ]);

    if (dmRelayEvents.length > 0) {
      const relayUrls = this.extractRelayUrls(dmRelayEvents[0]);
      if (relayUrls.length > 0) return relayUrls;
    }

    // Tier 2: Kind 10002 (NIP-65 general relay list)
    const relayListEvents = await this.request(this.defaultRelays, [
      { kinds: [10002], authors: [pubkey], limit: 1 },
    ]);

    if (relayListEvents.length > 0) {
      const relayUrls = this.extractRelayUrls(relayListEvents[0]);
      if (relayUrls.length > 0) return relayUrls;
    }

    // Tier 3: Fall back to default relays
    return this.defaultRelays;
  }

  private extractRelayUrls(event: NostrEvent): string[] {
    const relayTags = (event as any).tags.filter(
      (t: string[]) => t[0] === 'relay' || t[0] === 'r',
    );
    return relayTags
      .map((t: string[]) => t[1])
      .filter((url: string) => url?.startsWith('wss://'));
  }

  close(): void {
    this.pool.close(this.defaultRelays);
  }
}

// ---------------------------------------------------------------------------
// Nostr Event Signer (wraps a raw nsec hex key)
// ---------------------------------------------------------------------------

class NsecSigner implements EventSigner {
  private secretKey: Uint8Array;
  readonly pubkeyHex: string;

  constructor(nsecHex: string) {
    this.secretKey = hexToBytes(nsecHex);
    this.pubkeyHex = getPublicKey(this.secretKey);
  }

  async getPublicKey(): Promise<string> {
    return this.pubkeyHex;
  }

  async signEvent(event: UnsignedEvent): Promise<NostrEvent> {
    return finalizeEvent(event, this.secretKey) as unknown as NostrEvent;
  }
}

// ---------------------------------------------------------------------------
// MarmotChannel — NanoClaw Channel implementation
// ---------------------------------------------------------------------------

export interface MarmotChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

/**
 * Number of key packages to pre-publish so others can invite us.
 * White Noise consumes a key package when adding a member to a group.
 */
const KEY_PACKAGE_COUNT = 5;

/**
 * How often to check if key packages need replenishing (1 hour).
 */
const KEY_PACKAGE_CHECK_INTERVAL_MS = 3600000;

export class MarmotChannel implements Channel {
  name = 'marmot';

  private opts: MarmotChannelOpts;
  private client: MarmotClient | null = null;
  private network: NostrPoolAdapter | null = null;
  private signer: NsecSigner | null = null;
  private marmotDb: Database.Database | null = null;
  private connected = false;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private keyPackageTimer: ReturnType<typeof setInterval> | null = null;
  private subscriptions = new Map<string, Unsubscribable>();

  // Track sent event IDs to filter self-echoes.
  // Kind 445 events are signed with EPHEMERAL keypairs, so we can't
  // filter by pubkey — we track the event IDs we published instead.
  private sentEventIds = new Set<string>();

  // Serialized ingest queue to prevent concurrent MLS state mutations.
  // MLS is stateful — processing two messages concurrently corrupts the
  // ratchet state. We queue incoming events and process them serially.
  private ingestQueue: Array<() => Promise<void>> = [];
  private ingestRunning = false;

  constructor(opts: MarmotChannelOpts) {
    this.opts = opts;
  }

  async connect(): Promise<void> {
    // Validate configuration
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

    // Initialize SQLite database for persistent MLS state
    this.marmotDb = initMarmotDatabase();

    // Initialize signer with Nostr private key
    this.signer = new NsecSigner(MARMOT_NOSTR_PRIVATE_KEY);
    const pubkey = this.signer.pubkeyHex;

    // Initialize Nostr relay pool
    this.network = new NostrPoolAdapter(MARMOT_NOSTR_RELAYS);

    // Initialize Marmot client with SQLite-backed stores
    this.client = new MarmotClient({
      signer: this.signer,
      groupStateBackend: new SqliteGroupStateBackend(this.marmotDb),
      keyPackageStore: new SqliteKeyPackageStore(this.marmotDb),
      network: this.network,
    });

    // Load existing groups from persistent storage
    let groups: any[] = [];
    try {
      groups = await this.client.loadAllGroups();
      logger.info(
        { groupCount: groups.length, pubkey: pubkey.slice(0, 16) },
        'Marmot client initialized',
      );
    } catch (err) {
      logger.warn({ err }, 'Failed to load existing Marmot groups');
    }

    // Set up event listener for newly joined groups
    this.client.on('groupJoined', (group) => {
      const jid = jidFromGroupId(group.idStr);
      const metadata = group.getMetadata?.() ?? {};
      logger.info(
        { jid, name: (metadata as any).name },
        'Joined Marmot group',
      );
      this.opts.onChatMetadata(
        jid,
        new Date().toISOString(),
        (metadata as any).name || group.idStr.slice(0, 16),
        'marmot',
        true,
      );
      this.subscribeToGroup(group);
    });

    // Subscribe to existing registered groups
    const registeredGroups = this.opts.registeredGroups();
    for (const [jid, _group] of Object.entries(registeredGroups)) {
      const groupId = groupIdFromJid(jid);
      if (!groupId) continue;

      try {
        const marmotGroup = await this.client.getGroup(groupId);
        this.subscribeToGroup(marmotGroup);
      } catch (err) {
        logger.warn({ jid, err }, 'Failed to load registered Marmot group');
      }
    }

    // Also subscribe to any groups loaded from persistent storage
    // that might not be in registeredGroups yet
    for (const group of groups) {
      const jid = jidFromGroupId(group.idStr);
      if (!this.subscriptions.has(group.idStr)) {
        this.subscribeToGroup(group);
      }
    }

    // Publish initial key packages so others can invite us
    await this.ensureKeyPackages();

    // Start polling for welcome messages (invitations to new groups)
    this.startWelcomePoller(pubkey);

    // Start periodic key package replenishment
    this.keyPackageTimer = setInterval(async () => {
      await this.ensureKeyPackages();
    }, KEY_PACKAGE_CHECK_INTERVAL_MS);

    this.connected = true;

    console.log(`\n  Marmot channel: npub ${pubkey.slice(0, 16)}...`);
    console.log(`  Relays: ${MARMOT_NOSTR_RELAYS.join(', ')}`);
    console.log(
      `  Send a White Noise invite to this npub to start messaging\n`,
    );

    logger.info(
      {
        pubkey,
        relays: MARMOT_NOSTR_RELAYS,
        groupCount: groups.length,
      },
      'Marmot channel connected',
    );
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    if (!this.client) {
      logger.warn('Marmot client not initialized');
      return;
    }

    const groupId = groupIdFromJid(jid);
    if (!groupId) {
      logger.warn({ jid }, 'Invalid Marmot JID');
      return;
    }

    try {
      const group = await this.client.getGroup(groupId);
      await group.sendMessage(text);
      logger.info({ jid, length: text.length }, 'Marmot message sent');
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

    if (this.keyPackageTimer) {
      clearInterval(this.keyPackageTimer);
      this.keyPackageTimer = null;
    }

    for (const [_id, sub] of this.subscriptions) {
      sub.unsubscribe();
    }
    this.subscriptions.clear();

    if (this.network) {
      this.network.close();
      this.network = null;
    }

    if (this.marmotDb) {
      this.marmotDb.close();
      this.marmotDb = null;
    }

    this.client = null;
    this.signer = null;
    this.connected = false;
    this.sentEventIds.clear();

    logger.info('Marmot channel disconnected');
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /**
   * Ensure we have enough published key packages for others to invite us.
   * White Noise consumes one key package per group invitation.
   */
  private async ensureKeyPackages(): Promise<void> {
    if (!this.client) return;

    try {
      const existing = await this.client.keyPackages.list();
      const unused = existing.filter((kp: any) => !kp.used);

      if (unused.length < KEY_PACKAGE_COUNT) {
        const needed = KEY_PACKAGE_COUNT - unused.length;
        logger.info(
          { existing: unused.length, publishing: needed },
          'Publishing key packages',
        );
        await this.client.keyPackages.publish(needed);
      }
    } catch (err) {
      logger.warn({ err }, 'Failed to publish key packages');
    }
  }

  /**
   * Subscribe to messages from a Marmot group.
   * Listens for decrypted messages from the MarmotClient.
   */
  private subscribeToGroup(group: any): void {
    const jid = jidFromGroupId(group.idStr);

    // Avoid duplicate subscriptions
    if (this.subscriptions.has(group.idStr)) return;

    // Listen for message events on the group
    group.on?.('message', (message: any) => {
      // Queue for serialized processing to prevent concurrent MLS state mutations
      this.enqueueIngest(() => this.handleGroupMessage(group, message));
    });

    // Mark as subscribed (we use a placeholder unsubscribable since
    // marmot-ts event listeners don't return unsubscribable handles)
    this.subscriptions.set(group.idStr, {
      unsubscribe: () => {
        group.removeAllListeners?.('message');
      },
    });

    logger.info({ jid, groupId: group.idStr }, 'Subscribed to Marmot group');
  }

  /**
   * Enqueue a function for serialized processing.
   * Prevents concurrent MLS state mutations which corrupt the ratchet.
   */
  private enqueueIngest(fn: () => Promise<void>): void {
    this.ingestQueue.push(fn);
    if (!this.ingestRunning) {
      this.drainIngestQueue();
    }
  }

  private async drainIngestQueue(): Promise<void> {
    this.ingestRunning = true;
    while (this.ingestQueue.length > 0) {
      const fn = this.ingestQueue.shift()!;
      try {
        await fn();
      } catch (err) {
        logger.error({ err }, 'Error in Marmot ingest queue');
      }
    }
    this.ingestRunning = false;
  }

  /**
   * Handle an incoming decrypted message from a Marmot group.
   */
  private async handleGroupMessage(group: any, message: any): Promise<void> {
    const jid = jidFromGroupId(group.idStr);

    // Self-echo filtering: check if this event was one we sent.
    // Kind 445 events are signed with ephemeral keypairs, so we can't
    // filter by pubkey — we check our sent event ID set instead.
    const eventId = message.eventId || message.id;
    if (eventId && this.sentEventIds.has(eventId)) {
      this.sentEventIds.delete(eventId); // Clean up
      return;
    }

    // Determine sender identity
    const senderPubkey = message.senderPubkey || message.sender || 'unknown';
    const senderName =
      message.senderName || senderPubkey.slice(0, 12) + '...';
    const isFromMe =
      this.signer && senderPubkey === this.signer.pubkeyHex;

    // Store chat metadata
    const metadata = group.getMetadata?.() ?? {};
    this.opts.onChatMetadata(
      jid,
      new Date().toISOString(),
      (metadata as any).name || group.idStr.slice(0, 16),
      'marmot',
      true,
    );

    // Don't process our own messages
    if (isFromMe) return;

    // Build message content — handle text and potential media attachments
    let content = message.content || message.text || '';

    // MIP-04 v2 media attachments (images sent via White Noise)
    if (message.attachments && Array.isArray(message.attachments)) {
      for (const attachment of message.attachments) {
        if (attachment.url && attachment.mimeType?.startsWith('image/')) {
          content += `\n[Marmot Image: ${attachment.url}]`;
        }
      }
    }

    // Deliver to NanoClaw
    this.opts.onMessage(jid, {
      id:
        eventId ||
        `marmot-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      chat_jid: jid,
      sender: senderPubkey,
      sender_name: senderName,
      content,
      timestamp: message.timestamp
        ? new Date(message.timestamp).toISOString()
        : new Date().toISOString(),
      is_from_me: false,
    });

    logger.info(
      { jid, sender: senderName },
      'Marmot message received',
    );
  }

  /**
   * Poll for Welcome messages (group invitations) via NIP-59 gift wrap.
   *
   * When someone adds NanoClaw to a Marmot group via White Noise,
   * a Welcome event is sent as a NIP-59 gift-wrapped DM (kind 1059).
   *
   * This poller:
   * 1. Queries relays for gift-wrapped events addressed to us
   * 2. Deduplicates against already-processed events (SQLite)
   * 3. Passes new events to MarmotClient.joinGroupFromWelcome()
   * 4. On success, subscribes to the new group and notifies NanoClaw
   *
   * Uses 3-tier relay resolution matching White Noise behavior:
   * kind 10051 (DM relays) → kind 10002 (general relays) → default relays
   */
  private startWelcomePoller(pubkey: string): void {
    if (!this.network || !this.client) return;

    const pollInterval = MARMOT_POLL_INTERVAL_MS;
    let lastCheck = Math.floor(Date.now() / 1000) - 60; // Look back 60s on first poll

    this.pollTimer = setInterval(async () => {
      if (!this.client || !this.network || !this.marmotDb) return;

      try {
        // Query for gift-wrapped events addressed to us (NIP-59)
        // Kind 1059 = gift wrap containing a kind 444 MLS welcome/message
        const events = await this.network.request(MARMOT_NOSTR_RELAYS, [
          {
            kinds: [1059],
            '#p': [pubkey],
            since: lastCheck,
          },
        ]);

        for (const event of events) {
          const eventId = (event as any).id;
          if (!eventId) continue;

          // Dedup: skip events we've already processed
          const alreadyProcessed = this.marmotDb
            .prepare('SELECT 1 FROM marmot_processed_events WHERE event_id = ?')
            .get(eventId);
          if (alreadyProcessed) continue;

          try {
            // Attempt to process as a Welcome message via MarmotClient.
            // The client handles:
            //   1. NIP-59 gift wrap decryption (our signer decrypts the outer layer)
            //   2. Inner rumor extraction
            //   3. MLS Welcome message processing
            //   4. Group state initialization
            //   5. Emitting 'groupJoined' event (which triggers subscribeToGroup)
            logger.info(
              { eventId: eventId.slice(0, 16) },
              'Processing potential Marmot welcome event',
            );

            // joinGroupFromWelcome expects the unwrapped rumor.
            // The MarmotClient's ingest or processWelcome method handles
            // the full gift-wrap decryption internally.
            await this.client.joinGroupFromWelcome({ welcomeRumor: event as any });

            // Mark as processed so we don't re-process on next poll
            this.marmotDb
              .prepare(
                'INSERT OR IGNORE INTO marmot_processed_events (event_id, processed_at) VALUES (?, ?)',
              )
              .run(eventId, Math.floor(Date.now() / 1000));

            logger.info(
              { eventId: eventId.slice(0, 16) },
              'Successfully processed Marmot welcome',
            );
          } catch (err) {
            // Not all gift wraps are Marmot welcomes — this is expected
            // for non-Marmot NIP-59 events. Only warn on unexpected errors.
            const errMsg = err instanceof Error ? err.message : String(err);
            if (
              errMsg.includes('not a valid welcome') ||
              errMsg.includes('decrypt') ||
              errMsg.includes('unsupported')
            ) {
              logger.debug(
                { eventId: eventId?.slice(0, 16), err: errMsg },
                'Event was not a Marmot welcome (expected for non-Marmot events)',
              );
            } else {
              logger.warn(
                { eventId: eventId?.slice(0, 16), err },
                'Failed to process potential welcome event',
              );
            }

            // Mark as processed even on failure to avoid retry loops
            this.marmotDb
              .prepare(
                'INSERT OR IGNORE INTO marmot_processed_events (event_id, processed_at) VALUES (?, ?)',
              )
              .run(eventId, Math.floor(Date.now() / 1000));
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
// Self-registration — NanoClaw discovers this channel via the barrel import
// in src/channels/index.ts. The factory returns null when credentials are
// missing, which the startup loop interprets as "skip this channel".
// ---------------------------------------------------------------------------

registerChannel('marmot', (opts: ChannelOpts) => {
  if (!MARMOT_NOSTR_PRIVATE_KEY || MARMOT_NOSTR_RELAYS.length === 0) {
    return null;
  }
  return new MarmotChannel(opts);
});
