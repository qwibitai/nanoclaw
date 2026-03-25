import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

import { readEnvFile } from './env.js';
import { logger } from './logger.js';

export interface R2Config {
  accountId: string;
  privateBucket: string;
  privateAccessKey: string;
  privateSecretKey: string;
  sharedBucket: string;
  sharedReadAccessKey: string;
  sharedReadSecretKey: string;
  sharedWriteAccessKey: string;
  sharedWriteSecretKey: string;
  nanoclawId: string;
}

function makeClient(
  accessKey: string,
  secretKey: string,
  accountId: string,
): S3Client {
  return new S3Client({
    region: 'auto',
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: accessKey,
      secretAccessKey: secretKey,
    },
  });
}

export class R2Client {
  private privateClient: S3Client;
  private sharedReadClient: S3Client;
  private sharedWriteClient: S3Client;
  private config: R2Config;

  constructor(config: R2Config) {
    this.config = config;
    this.privateClient = makeClient(
      config.privateAccessKey,
      config.privateSecretKey,
      config.accountId,
    );
    this.sharedReadClient = makeClient(
      config.sharedReadAccessKey,
      config.sharedReadSecretKey,
      config.accountId,
    );
    this.sharedWriteClient = makeClient(
      config.sharedWriteAccessKey,
      config.sharedWriteSecretKey,
      config.accountId,
    );
  }

  async upload(
    key: string,
    body: Buffer,
    contentType?: string,
  ): Promise<string> {
    await this.privateClient.send(
      new PutObjectCommand({
        Bucket: this.config.privateBucket,
        Key: key,
        Body: body,
        ContentType: contentType,
      }),
    );
    return key;
  }

  async read(key: string): Promise<string> {
    const buf = await this.download(key);
    return buf.toString('utf-8');
  }

  async download(key: string): Promise<Buffer> {
    const response = await this.privateClient.send(
      new GetObjectCommand({ Bucket: this.config.privateBucket, Key: key }),
    );
    const chunks: Uint8Array[] = [];
    for await (const chunk of response.Body as AsyncIterable<Uint8Array>) {
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  }

  async list(
    prefix?: string,
  ): Promise<Array<{ key: string; size: number; lastModified: Date }>> {
    const response = await this.privateClient.send(
      new ListObjectsV2Command({
        Bucket: this.config.privateBucket,
        Prefix: prefix,
      }),
    );
    return (response.Contents ?? []).map((obj) => ({
      key: obj.Key!,
      size: obj.Size ?? 0,
      lastModified: obj.LastModified ?? new Date(),
    }));
  }

  async presign(key: string, ttlSeconds = 86400): Promise<string> {
    return getSignedUrl(
      this.privateClient,
      new GetObjectCommand({ Bucket: this.config.privateBucket, Key: key }),
      { expiresIn: ttlSeconds },
    );
  }

  async sharedPublish(
    filename: string,
    body: Buffer,
    contentType?: string,
  ): Promise<string> {
    const key = `${this.config.nanoclawId}/outbox/${filename}`;
    await this.sharedWriteClient.send(
      new PutObjectCommand({
        Bucket: this.config.sharedBucket,
        Key: key,
        Body: body,
        ContentType: contentType,
      }),
    );
    return key;
  }

  async sharedRead(key: string): Promise<Buffer> {
    const response = await this.sharedReadClient.send(
      new GetObjectCommand({ Bucket: this.config.sharedBucket, Key: key }),
    );
    const chunks: Uint8Array[] = [];
    for await (const chunk of response.Body as AsyncIterable<Uint8Array>) {
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  }
}

let _r2Client: R2Client | null = null;

export function getR2Client(): R2Client | null {
  if (_r2Client) return _r2Client;

  const env = readEnvFile([
    'R2_ACCOUNT_ID',
    'R2_PRIVATE_BUCKET',
    'R2_PRIVATE_ACCESS_KEY',
    'R2_PRIVATE_SECRET_KEY',
    'R2_SHARED_BUCKET',
    'R2_SHARED_READ_ACCESS_KEY',
    'R2_SHARED_READ_SECRET_KEY',
    'R2_SHARED_WRITE_ACCESS_KEY',
    'R2_SHARED_WRITE_SECRET_KEY',
    'NANOCLAW_ID',
  ]);

  const accountId = process.env.R2_ACCOUNT_ID ?? env.R2_ACCOUNT_ID ?? '';
  if (!accountId) {
    logger.debug('R2 not configured (R2_ACCOUNT_ID missing)');
    return null;
  }

  _r2Client = new R2Client({
    accountId,
    privateBucket: process.env.R2_PRIVATE_BUCKET ?? env.R2_PRIVATE_BUCKET ?? '',
    privateAccessKey:
      process.env.R2_PRIVATE_ACCESS_KEY ?? env.R2_PRIVATE_ACCESS_KEY ?? '',
    privateSecretKey:
      process.env.R2_PRIVATE_SECRET_KEY ?? env.R2_PRIVATE_SECRET_KEY ?? '',
    sharedBucket: process.env.R2_SHARED_BUCKET ?? env.R2_SHARED_BUCKET ?? '',
    sharedReadAccessKey:
      process.env.R2_SHARED_READ_ACCESS_KEY ??
      env.R2_SHARED_READ_ACCESS_KEY ??
      '',
    sharedReadSecretKey:
      process.env.R2_SHARED_READ_SECRET_KEY ??
      env.R2_SHARED_READ_SECRET_KEY ??
      '',
    sharedWriteAccessKey:
      process.env.R2_SHARED_WRITE_ACCESS_KEY ??
      env.R2_SHARED_WRITE_ACCESS_KEY ??
      '',
    sharedWriteSecretKey:
      process.env.R2_SHARED_WRITE_SECRET_KEY ??
      env.R2_SHARED_WRITE_SECRET_KEY ??
      '',
    nanoclawId: process.env.NANOCLAW_ID ?? env.NANOCLAW_ID ?? 'default',
  });

  return _r2Client;
}
