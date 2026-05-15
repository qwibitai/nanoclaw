// Delete a single object from R2. Used to clean up retired feeds/episodes.
//
// Usage: node --experimental-strip-types scripts/podcast/delete-r2-object.ts <objectKey> [<objectKey>...]
// Example: node --experimental-strip-types scripts/podcast/delete-r2-object.ts tube-feed.rss tube/tube-2026-05-03.mp3

import fs from 'fs';
import path from 'path';

import { deleteFromR2 } from './lib/r2-upload.ts';

type Env = Record<string, string>;

function readEnv(keys: string[]): Env {
  const content = fs.readFileSync(path.join(process.cwd(), '.env'), 'utf8');
  const wanted = new Set(keys);
  const out: Env = {};
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    if (!wanted.has(key)) continue;
    let value = trimmed.slice(eq + 1).trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  const missing = keys.filter((k) => !out[k]);
  if (missing.length) throw new Error(`Missing required env keys: ${missing.join(', ')}`);
  return out;
}

async function main(): Promise<void> {
  const keys = process.argv.slice(2);
  if (keys.length === 0) {
    console.error('Usage: delete-r2-object.ts <objectKey> [<objectKey>...]');
    process.exit(2);
  }

  const env = readEnv([
    'CLOUDFLARE_ACCOUNT_ID',
    'CLOUDFLARE_R2_ACCESS_KEY_ID',
    'CLOUDFLARE_R2_SECRET_ACCESS_KEY',
    'CLOUDFLARE_R2_BUCKET',
    'CLOUDFLARE_R2_PUBLIC_BASE_URL',
  ]);

  for (const objectKey of keys) {
    await deleteFromR2({
      accountId: env.CLOUDFLARE_ACCOUNT_ID!,
      accessKeyId: env.CLOUDFLARE_R2_ACCESS_KEY_ID!,
      secretAccessKey: env.CLOUDFLARE_R2_SECRET_ACCESS_KEY!,
      bucket: env.CLOUDFLARE_R2_BUCKET!,
      objectKey,
    });
    console.log(`Deleted ${objectKey}`);
  }

  // Verify each is now 404
  const publicBase = env.CLOUDFLARE_R2_PUBLIC_BASE_URL!.replace(/\/+$/, '');
  for (const objectKey of keys) {
    const res = await fetch(`${publicBase}/${objectKey}`, { method: 'HEAD' });
    console.log(`HEAD ${objectKey}: HTTP ${res.status}`);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
