/**
 * Diagnostic script: verify which Nostr events exist for a given pubkey on relays.
 *
 * Usage:
 *   npx tsx scripts/verify-relay-events.ts <pubkey-hex>
 *
 * Checks for:
 *   - Kind 0   (profile metadata)
 *   - Kind 443 (KeyPackage)
 *   - Kind 10051 (KeyPackage relay list)
 */

import { SimplePool } from 'nostr-tools/pool';

const pubkey = process.argv[2];
if (!pubkey || pubkey.length !== 64) {
  console.error('Usage: npx tsx scripts/verify-relay-events.ts <64-char-hex-pubkey>');
  process.exit(1);
}

const relays = [
  'wss://relay.damus.io',
  'wss://nos.lol',
  'wss://relay.nostr.band',
  'wss://purplepag.es',
];

const pool = new SimplePool();

async function queryKind(kind: number, label: string) {
  console.log(`\n--- Kind ${kind}: ${label} ---`);
  try {
    const events = await pool.querySync(relays, {
      kinds: [kind],
      authors: [pubkey],
      limit: 5,
    });
    if (events.length === 0) {
      console.log(`  ❌ NOT FOUND on any relay`);
    } else {
      for (const ev of events) {
        console.log(`  ✅ Found event ${ev.id.slice(0, 16)}...`);
        console.log(`     created_at: ${new Date(ev.created_at * 1000).toISOString()}`);
        console.log(`     tags: ${JSON.stringify(ev.tags.slice(0, 5))}`);
        if (kind === 0) {
          try {
            const profile = JSON.parse(ev.content);
            console.log(`     profile: ${JSON.stringify(profile)}`);
          } catch { /* */ }
        }
        if (kind === 443) {
          console.log(`     content length: ${ev.content?.length || 0} bytes`);
          const mlsVersion = ev.tags.find((t: string[]) => t[0] === 'mls_protocol_version');
          const cipherSuite = ev.tags.find((t: string[]) => t[0] === 'mls_ciphersuite');
          const client = ev.tags.find((t: string[]) => t[0] === 'client');
          const relayTag = ev.tags.find((t: string[]) => t[0] === 'relays');
          console.log(`     mls_version: ${mlsVersion?.[1] || 'missing'}`);
          console.log(`     ciphersuite: ${cipherSuite?.[1] || 'missing'}`);
          console.log(`     client: ${client?.[1] || 'missing'}`);
          console.log(`     relays tag: ${relayTag ? JSON.stringify(relayTag) : 'missing'}`);
        }
        if (kind === 10051) {
          const relayTags = ev.tags.filter((t: string[]) => t[0] === 'relay');
          console.log(`     relay entries: ${relayTags.map((t: string[]) => t[1]).join(', ') || 'none'}`);
        }
      }
    }
  } catch (err: any) {
    console.log(`  ⚠️  Query failed: ${err?.message}`);
  }
}

async function main() {
  console.log(`Checking events for pubkey: ${pubkey}`);
  console.log(`Querying relays: ${relays.join(', ')}`);

  await queryKind(0, 'Profile Metadata');
  await queryKind(10051, 'KeyPackage Relay List');
  await queryKind(443, 'KeyPackage (MLS)');

  console.log('\n--- Done ---');
  pool.close(relays);
  process.exit(0);
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
