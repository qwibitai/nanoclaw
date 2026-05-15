// Re-upload a podcast feed RSS file to R2 (no episode publish, just feed sync).
// Useful for fixing feed drift, removing duplicates, or pushing skeleton feeds live.
//
// Usage:
//   node --experimental-strip-types scripts/podcast/sync-podcast-feed.ts --feed tech
//   node --experimental-strip-types scripts/podcast/sync-podcast-feed.ts --feed iran

import fs from 'fs';
import path from 'path';

import { uploadToR2 } from './lib/r2-upload.ts';

type Env = Record<string, string>;

interface FeedConfig {
  rssFilename: string;
}

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

function loadFeedConfig(feedKey: string): FeedConfig {
  const root = path.join(process.cwd(), 'groups', 'thedius_pod');
  const configPath = path.join(root, 'podcast', 'feeds', `${feedKey}.config.json`);
  if (!fs.existsSync(configPath)) throw new Error(`No feed config at ${configPath}`);
  const raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  return { rssFilename: raw.rssFilename ?? `${feedKey}-feed.rss` };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const idx = argv.indexOf('--feed');
  if (idx === -1 || !argv[idx + 1]) {
    console.error('Usage: scripts/podcast/sync-podcast-feed.ts --feed <key>');
    process.exit(2);
  }
  const feedKey = argv[idx + 1];
  const cfg = loadFeedConfig(feedKey);

  const env = readEnv([
    'CLOUDFLARE_ACCOUNT_ID',
    'CLOUDFLARE_R2_ACCESS_KEY_ID',
    'CLOUDFLARE_R2_SECRET_ACCESS_KEY',
    'CLOUDFLARE_R2_BUCKET',
    'CLOUDFLARE_R2_PUBLIC_BASE_URL',
  ]);

  const feedPath = path.join(process.cwd(), 'groups', 'thedius_pod', 'podcast', 'feeds', cfg.rssFilename);
  if (!fs.existsSync(feedPath)) {
    throw new Error(`Feed file not found: ${feedPath}`);
  }
  const body = fs.readFileSync(feedPath);

  await uploadToR2({
    accountId: env.CLOUDFLARE_ACCOUNT_ID!,
    accessKeyId: env.CLOUDFLARE_R2_ACCESS_KEY_ID!,
    secretAccessKey: env.CLOUDFLARE_R2_SECRET_ACCESS_KEY!,
    bucket: env.CLOUDFLARE_R2_BUCKET!,
    objectKey: cfg.rssFilename,
    body,
    contentType: 'application/rss+xml; charset=utf-8',
  });

  const publicBase = env.CLOUDFLARE_R2_PUBLIC_BASE_URL!.replace(/\/+$/, '');
  const publicUrl = `${publicBase}/${cfg.rssFilename}`;
  const check = await fetch(publicUrl, { method: 'HEAD' });
  console.log(`Synced ${feedKey} feed → ${publicUrl}`);
  console.log(`Public URL check: HTTP ${check.status}`);
  if (!check.ok) throw new Error(`Public URL did not return OK: HTTP ${check.status}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
