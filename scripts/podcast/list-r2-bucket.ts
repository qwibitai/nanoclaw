// List every object in the R2 bucket. Read-only.
//
// Usage: node --experimental-strip-types scripts/podcast/list-r2-bucket.ts [--full]

import { createHash, createHmac } from 'crypto';
import fs from 'fs';
import path from 'path';

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

function sha256Hex(input: string | Buffer): string { return createHash('sha256').update(input).digest('hex'); }
function hmac(key: Buffer | string, value: string): Buffer { return createHmac('sha256', key).update(value).digest(); }
function isoBasic(date: Date): { amzDate: string; dateStamp: string } {
  const iso = date.toISOString().replace(/[:-]|\.\d{3}/g, '');
  return { amzDate: iso, dateStamp: iso.slice(0, 8) };
}

async function listBucket(env: Env): Promise<Array<{ key: string; size: number }>> {
  const accountId = env.CLOUDFLARE_ACCOUNT_ID!;
  const accessKeyId = env.CLOUDFLARE_R2_ACCESS_KEY_ID!;
  const secretAccessKey = env.CLOUDFLARE_R2_SECRET_ACCESS_KEY!;
  const bucket = env.CLOUDFLARE_R2_BUCKET!;
  const host = `${accountId}.r2.cloudflarestorage.com`;
  const region = 'auto';
  const service = 's3';

  const all: Array<{ key: string; size: number }> = [];
  let continuationToken: string | null = null;

  do {
    const queryParts = ['list-type=2', 'max-keys=1000'];
    if (continuationToken) queryParts.push(`continuation-token=${encodeURIComponent(continuationToken)}`);
    const queryString = queryParts.join('&');

    const now = new Date();
    const { amzDate, dateStamp } = isoBasic(now);
    const canonicalUri = `/${bucket}`;
    const payloadHash = sha256Hex('');
    const canonicalHeaders = `host:${host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${amzDate}\n`;
    const signedHeaders = 'host;x-amz-content-sha256;x-amz-date';
    const canonicalRequest = ['GET', canonicalUri, queryString, canonicalHeaders, signedHeaders, payloadHash].join('\n');
    const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
    const stringToSign = ['AWS4-HMAC-SHA256', amzDate, credentialScope, sha256Hex(canonicalRequest)].join('\n');
    const signingKey = hmac(hmac(hmac(hmac(`AWS4${secretAccessKey}`, dateStamp), region), service), 'aws4_request');
    const signature = createHmac('sha256', signingKey).update(stringToSign).digest('hex');

    const url = `https://${host}${canonicalUri}?${queryString}`;
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        authorization: `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
        'x-amz-content-sha256': payloadHash,
        'x-amz-date': amzDate,
      },
    });
    if (!res.ok) throw new Error(`R2 list failed: ${res.status} ${(await res.text()).slice(0, 300)}`);
    const xml = await res.text();

    for (const m of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
      const block = m[1]!;
      const key = block.match(/<Key>([^<]+)<\/Key>/)?.[1] ?? '';
      const size = parseInt(block.match(/<Size>([^<]+)<\/Size>/)?.[1] ?? '0', 10);
      all.push({ key, size });
    }
    const truncated = /<IsTruncated>true<\/IsTruncated>/.test(xml);
    continuationToken = truncated ? (xml.match(/<NextContinuationToken>([^<]+)<\/NextContinuationToken>/)?.[1] ?? null) : null;
  } while (continuationToken);

  return all;
}

async function main(): Promise<void> {
  const full = process.argv.includes('--full');
  const env = readEnv(['CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_R2_ACCESS_KEY_ID', 'CLOUDFLARE_R2_SECRET_ACCESS_KEY', 'CLOUDFLARE_R2_BUCKET']);
  const objs = await listBucket(env);

  console.log(`Total: ${objs.length} objects, ${(objs.reduce((s, o) => s + o.size, 0) / (1024 * 1024)).toFixed(1)} MB\n`);

  if (full) {
    for (const o of objs.sort((a, b) => a.key.localeCompare(b.key))) {
      console.log(`${(o.size / (1024 * 1024)).toFixed(2).padStart(8)} MB  ${o.key}`);
    }
  } else {
    const groups = new Map<string, { count: number; totalSize: number; samples: string[] }>();
    for (const o of objs) {
      const slash = o.key.indexOf('/');
      const prefix = slash === -1 ? '<root>' : o.key.slice(0, slash);
      if (!groups.has(prefix)) groups.set(prefix, { count: 0, totalSize: 0, samples: [] });
      const g = groups.get(prefix)!;
      g.count++;
      g.totalSize += o.size;
      if (g.samples.length < 3) g.samples.push(o.key);
    }
    for (const [prefix, g] of [...groups.entries()].sort()) {
      console.log(`  ${prefix}: ${g.count}, ${(g.totalSize / (1024 * 1024)).toFixed(1)} MB`);
    }
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
