/**
 * S3 storage backend. The AWS SDK is loaded via dynamic import so users
 * who don't enable the s3 backend never pay the dependency cost (and
 * pnpm install can resolve without it).
 *
 * Credentials: explicit `BACKUP_S3_ACCESS_KEY_ID` / `BACKUP_S3_SECRET_ACCESS_KEY`
 * (and optional `BACKUP_S3_SESSION_TOKEN`) take precedence. If unset, the
 * SDK's default credential chain (env vars, ~/.aws/credentials, SSO, IMDS)
 * is used. OneCLI is intentionally not consulted here — the host process,
 * not a container, is doing the upload.
 */
import fs from 'fs';
import path from 'path';

import {
  BACKUP_S3_ACCESS_KEY_ID,
  BACKUP_S3_BUCKET,
  BACKUP_S3_PREFIX,
  BACKUP_S3_REGION,
  BACKUP_S3_SECRET_ACCESS_KEY,
  BACKUP_S3_SESSION_TOKEN,
  BACKUP_S3_SSE,
} from '../../config.js';
import type { ArchiveListing, StorageBackend } from './index.js';

interface S3ClientLike {
  send: (cmd: unknown) => Promise<unknown>;
}

interface SDKBundle {
  S3Client: new (cfg: Record<string, unknown>) => S3ClientLike;
  ListObjectsV2Command: new (input: Record<string, unknown>) => unknown;
  GetObjectCommand: new (input: Record<string, unknown>) => unknown;
  Upload: new (cfg: Record<string, unknown>) => { done: () => Promise<unknown> };
}

let sdkPromise: Promise<SDKBundle> | null = null;
async function loadSdk(): Promise<SDKBundle> {
  if (!sdkPromise) {
    sdkPromise = (async () => {
      // String-variable indirection keeps tsc from trying to resolve these
      // optionalDependencies at typecheck time. They're only loaded when the
      // s3 backend actually runs.
      const s3ModName = '@aws-sdk/client-s3';
      const libStorageName = '@aws-sdk/lib-storage';
      const [s3mod, libStorage] = await Promise.all([
        import(s3ModName) as Promise<Record<string, unknown>>,
        import(libStorageName) as Promise<Record<string, unknown>>,
      ]);
      return {
        S3Client: s3mod.S3Client as SDKBundle['S3Client'],
        ListObjectsV2Command: s3mod.ListObjectsV2Command as SDKBundle['ListObjectsV2Command'],
        GetObjectCommand: s3mod.GetObjectCommand as SDKBundle['GetObjectCommand'],
        Upload: libStorage.Upload as SDKBundle['Upload'],
      };
    })();
  }
  return sdkPromise;
}

function buildClient(sdk: SDKBundle): S3ClientLike {
  const cfg: Record<string, unknown> = {};
  if (BACKUP_S3_REGION) cfg.region = BACKUP_S3_REGION;
  if (BACKUP_S3_ACCESS_KEY_ID && BACKUP_S3_SECRET_ACCESS_KEY) {
    cfg.credentials = {
      accessKeyId: BACKUP_S3_ACCESS_KEY_ID,
      secretAccessKey: BACKUP_S3_SECRET_ACCESS_KEY,
      ...(BACKUP_S3_SESSION_TOKEN ? { sessionToken: BACKUP_S3_SESSION_TOKEN } : {}),
    };
  }
  return new sdk.S3Client(cfg);
}

function objectKey(archiveName: string): string {
  return BACKUP_S3_PREFIX ? `${BACKUP_S3_PREFIX.replace(/\/+$/, '')}/${archiveName}` : archiveName;
}

export class S3StorageBackend implements StorageBackend {
  readonly name = 's3' as const;

  async writeArchive(archivePath: string, archiveName: string): Promise<{ url: string; bytes: number }> {
    if (!BACKUP_S3_BUCKET) throw new Error('BACKUP_S3_BUCKET is not configured');
    const sdk = await loadSdk();
    const client = buildClient(sdk);
    const key = objectKey(archiveName);

    const stream = fs.createReadStream(archivePath);
    const upload = new sdk.Upload({
      client,
      params: {
        Bucket: BACKUP_S3_BUCKET,
        Key: key,
        Body: stream,
        ...(BACKUP_S3_SSE ? { ServerSideEncryption: BACKUP_S3_SSE } : {}),
      },
    });
    await upload.done();

    const bytes = fs.statSync(archivePath).size;
    return { url: `s3://${BACKUP_S3_BUCKET}/${key}`, bytes };
  }

  async listArchives(): Promise<ArchiveListing[]> {
    if (!BACKUP_S3_BUCKET) throw new Error('BACKUP_S3_BUCKET is not configured');
    const sdk = await loadSdk();
    const client = buildClient(sdk);
    const prefix = BACKUP_S3_PREFIX ? `${BACKUP_S3_PREFIX.replace(/\/+$/, '')}/` : undefined;

    const out: ArchiveListing[] = [];
    let continuationToken: string | undefined;
    do {
      const cmd = new sdk.ListObjectsV2Command({
        Bucket: BACKUP_S3_BUCKET,
        Prefix: prefix,
        ContinuationToken: continuationToken,
      });
      const resp = (await client.send(cmd)) as {
        Contents?: Array<{ Key?: string; Size?: number; LastModified?: Date }>;
        NextContinuationToken?: string;
        IsTruncated?: boolean;
      };
      for (const obj of resp.Contents ?? []) {
        if (!obj.Key || !obj.Key.endsWith('.tar.gz')) continue;
        const name = prefix && obj.Key.startsWith(prefix) ? obj.Key.slice(prefix.length) : obj.Key;
        out.push({
          name,
          bytes: obj.Size ?? 0,
          created_at: obj.LastModified ? obj.LastModified.toISOString() : '',
        });
      }
      continuationToken = resp.IsTruncated ? resp.NextContinuationToken : undefined;
    } while (continuationToken);

    out.sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0));
    return out;
  }

  async fetchArchive(archiveName: string, destPath: string): Promise<void> {
    if (!BACKUP_S3_BUCKET) throw new Error('BACKUP_S3_BUCKET is not configured');
    const sdk = await loadSdk();
    const client = buildClient(sdk);
    const key = objectKey(archiveName);

    const cmd = new sdk.GetObjectCommand({ Bucket: BACKUP_S3_BUCKET, Key: key });
    const resp = (await client.send(cmd)) as { Body?: NodeJS.ReadableStream };
    if (!resp.Body) throw new Error(`S3 GetObject returned empty body for ${key}`);

    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    await new Promise<void>((resolve, reject) => {
      const writeStream = fs.createWriteStream(destPath);
      resp
        .Body!.pipe(writeStream)
        .on('finish', () => resolve())
        .on('error', reject);
    });
  }
}
