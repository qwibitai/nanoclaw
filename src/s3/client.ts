/**
 * NanoClaw S3 Client
 * Wraps Bun.S3Client for B2-compatible storage operations.
 * Provides typed operations for inbox/outbox/context/sync/files.
 *
 * Bucket structure:
 *   agents/{agentId}/inbox/{timestamp}-{id}.json
 *   agents/{agentId}/outbox/{timestamp}-{id}.json
 *   agents/{agentId}/context/{topic}.md
 *   agents/{agentId}/sync/{file}
 *   shared/global-context.md
 *   files/{transferId}/manifest.json
 *   files/{transferId}/{filename}
 */

import crypto from 'crypto';

import { logger } from '../logger.js';
import type { S3Message, S3Output, FileTransferManifest } from './types.js';

// Bun.S3 / Bun.S3Client are available globally in Bun >= 1.2
declare const Bun: {
  S3Client: new (opts: {
    endpoint: string;
    accessKeyId: string;
    secretAccessKey: string;
    bucket: string;
    region?: string;
  }) => S3ClientInstance;
};

interface S3File {
  exists(): Promise<boolean>;
  text(): Promise<string>;
  arrayBuffer(): Promise<ArrayBuffer>;
  write(data: string | Buffer | ArrayBuffer): Promise<number>;
  delete(): Promise<void>;
  size: number;
  presign(opts?: { expiresIn?: number }): string;
}

interface S3ClientInstance {
  file(key: string): S3File;
  write(key: string, data: string | Buffer | ArrayBuffer): Promise<number>;
  delete(key: string): Promise<void>;
  // Bun.S3Client doesn't have a list operation — we use the S3 ListObjectsV2 API directly
}

export interface NanoClawS3Config {
  endpoint: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  region?: string;
}

/**
 * List objects under a prefix using the S3 ListObjectsV2 REST API.
 * Bun.S3Client doesn't expose list, so we call the API directly.
 */
async function listObjects(
  config: NanoClawS3Config,
  prefix: string,
  maxKeys = 100,
): Promise<string[]> {
  const region = config.region || 'us-west-004';
  const bucket = config.bucket;

  // Build the URL
  const params = new URLSearchParams({
    'list-type': '2',
    prefix,
    'max-keys': String(maxKeys),
  });
  const url = `${config.endpoint}/${bucket}?${params}`;

  // AWS Signature V4 signing
  const now = new Date();
  const dateStamp = now.toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
  const shortDate = dateStamp.slice(0, 8);
  const host = new URL(config.endpoint).host;

  const canonicalHeaders = `host:${host}\nx-amz-content-sha256:UNSIGNED-PAYLOAD\nx-amz-date:${dateStamp}\n`;
  const signedHeaders = 'host;x-amz-content-sha256;x-amz-date';
  const canonicalRequest = `GET\n/${bucket}\n${params.toString()}\n${canonicalHeaders}\n${signedHeaders}\nUNSIGNED-PAYLOAD`;

  const scope = `${shortDate}/${region}/s3/aws4_request`;
  const stringToSign = `AWS4-HMAC-SHA256\n${dateStamp}\n${scope}\n${crypto.createHash('sha256').update(canonicalRequest).digest('hex')}`;

  const kDate = crypto.createHmac('sha256', `AWS4${config.secretAccessKey}`).update(shortDate).digest();
  const kRegion = crypto.createHmac('sha256', kDate).update(region).digest();
  const kService = crypto.createHmac('sha256', kRegion).update('s3').digest();
  const kSigning = crypto.createHmac('sha256', kService).update('aws4_request').digest();
  const signature = crypto.createHmac('sha256', kSigning).update(stringToSign).digest('hex');

  const authorization = `AWS4-HMAC-SHA256 Credential=${config.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  const resp = await fetch(url, {
    headers: {
      'Authorization': authorization,
      'x-amz-content-sha256': 'UNSIGNED-PAYLOAD',
      'x-amz-date': dateStamp,
    },
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`S3 ListObjectsV2 failed: ${resp.status} ${body}`);
  }

  const xml = await resp.text();
  // Parse <Key>...</Key> from XML response
  const keys: string[] = [];
  const keyRegex = /<Key>([^<]+)<\/Key>/g;
  let match;
  while ((match = keyRegex.exec(xml)) !== null) {
    keys.push(match[1]);
  }
  return keys;
}

export class NanoClawS3 {
  private client: S3ClientInstance;
  private config: NanoClawS3Config;

  constructor(config: NanoClawS3Config) {
    this.config = config;
    this.client = new Bun.S3Client({
      endpoint: config.endpoint,
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
      bucket: config.bucket,
      region: config.region,
    });
  }

  // --- Inbox Operations ---

  /** Write a message to an agent's inbox. */
  async writeInbox(agentId: string, message: S3Message): Promise<string> {
    const key = `agents/${agentId}/inbox/${message.timestamp}-${message.id}.json`;
    await this.client.write(key, JSON.stringify(message));
    return key;
  }

  /** Read and delete all messages from an agent's inbox (list→read→delete). */
  async drainInbox(agentId: string): Promise<S3Message[]> {
    const prefix = `agents/${agentId}/inbox/`;
    const keys = await listObjects(this.config, prefix);
    if (keys.length === 0) return [];

    const messages: S3Message[] = [];
    for (const key of keys) {
      try {
        const text = await this.client.file(key).text();
        messages.push(JSON.parse(text) as S3Message);
        await this.client.delete(key);
      } catch (err) {
        logger.warn({ key, error: err }, 'Failed to read/delete S3 inbox message');
      }
    }

    // Sort by timestamp
    messages.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    return messages;
  }

  // --- Outbox Operations ---

  /** Write a result to an agent's outbox. */
  async writeOutbox(agentId: string, output: S3Output): Promise<string> {
    const key = `agents/${agentId}/outbox/${output.timestamp}-${output.id}.json`;
    await this.client.write(key, JSON.stringify(output));
    return key;
  }

  /** Read and delete all results from an agent's outbox. */
  async drainOutbox(agentId: string): Promise<S3Output[]> {
    const prefix = `agents/${agentId}/outbox/`;
    const keys = await listObjects(this.config, prefix);
    if (keys.length === 0) return [];

    const outputs: S3Output[] = [];
    for (const key of keys) {
      try {
        const text = await this.client.file(key).text();
        outputs.push(JSON.parse(text) as S3Output);
        await this.client.delete(key);
      } catch (err) {
        logger.warn({ key, error: err }, 'Failed to read/delete S3 outbox message');
      }
    }

    outputs.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    return outputs;
  }

  // --- Context Operations ---

  /** Write a context file for an agent. */
  async writeContext(agentId: string, topic: string, content: string): Promise<void> {
    const key = `agents/${agentId}/context/${topic}.md`;
    await this.client.write(key, content);
  }

  /** Read a context file for an agent. */
  async readContext(agentId: string, topic: string): Promise<string | null> {
    const key = `agents/${agentId}/context/${topic}.md`;
    try {
      const exists = await this.client.file(key).exists();
      if (!exists) return null;
      return await this.client.file(key).text();
    } catch {
      return null;
    }
  }

  /** List all context topics for an agent. */
  async listContextTopics(agentId: string): Promise<string[]> {
    const prefix = `agents/${agentId}/context/`;
    const keys = await listObjects(this.config, prefix);
    return keys.map((k) => {
      const filename = k.slice(prefix.length);
      return filename.replace(/\.md$/, '');
    });
  }

  // --- Sync Operations (host writes, agent reads on startup) ---

  /** Upload a sync file for an agent. */
  async writeSync(agentId: string, relativePath: string, content: string | Buffer): Promise<void> {
    const key = `agents/${agentId}/sync/${relativePath}`;
    await this.client.write(key, content);
  }

  /** Read a sync file for an agent. */
  async readSync(agentId: string, relativePath: string): Promise<Buffer | null> {
    const key = `agents/${agentId}/sync/${relativePath}`;
    try {
      const exists = await this.client.file(key).exists();
      if (!exists) return null;
      const ab = await this.client.file(key).arrayBuffer();
      return Buffer.from(ab);
    } catch {
      return null;
    }
  }

  /** List all sync files for an agent. */
  async listSyncFiles(agentId: string): Promise<string[]> {
    const prefix = `agents/${agentId}/sync/`;
    const keys = await listObjects(this.config, prefix);
    return keys.map((k) => k.slice(prefix.length));
  }

  // --- File Transfer Operations ---

  /** Upload a file to a transfer. */
  async uploadTransferFile(transferId: string, filename: string, content: Buffer | string): Promise<void> {
    const key = `files/${transferId}/${filename}`;
    await this.client.write(key, content);
  }

  /** Write a transfer manifest. */
  async writeTransferManifest(transferId: string, manifest: FileTransferManifest): Promise<void> {
    const key = `files/${transferId}/manifest.json`;
    await this.client.write(key, JSON.stringify(manifest));
  }

  /** Read a transfer manifest. */
  async readTransferManifest(transferId: string): Promise<FileTransferManifest | null> {
    const key = `files/${transferId}/manifest.json`;
    try {
      const exists = await this.client.file(key).exists();
      if (!exists) return null;
      const text = await this.client.file(key).text();
      return JSON.parse(text) as FileTransferManifest;
    } catch {
      return null;
    }
  }

  /** Download a file from a transfer. */
  async downloadTransferFile(transferId: string, filename: string): Promise<Buffer | null> {
    const key = `files/${transferId}/${filename}`;
    try {
      const exists = await this.client.file(key).exists();
      if (!exists) return null;
      const ab = await this.client.file(key).arrayBuffer();
      return Buffer.from(ab);
    } catch {
      return null;
    }
  }

  /** List files in a transfer. */
  async listTransferFiles(transferId: string): Promise<string[]> {
    const prefix = `files/${transferId}/`;
    const keys = await listObjects(this.config, prefix);
    return keys
      .map((k) => k.slice(prefix.length))
      .filter((f) => f !== 'manifest.json');
  }

  // --- Shared Context ---

  /** Write shared global context. */
  async writeSharedContext(filename: string, content: string): Promise<void> {
    const key = `shared/${filename}`;
    await this.client.write(key, content);
  }

  /** Read shared global context. */
  async readSharedContext(filename: string): Promise<string | null> {
    const key = `shared/${filename}`;
    try {
      const exists = await this.client.file(key).exists();
      if (!exists) return null;
      return await this.client.file(key).text();
    } catch {
      return null;
    }
  }

  // --- Raw Operations ---

  /** Write raw data to any key. */
  async write(key: string, data: string | Buffer): Promise<void> {
    await this.client.write(key, data);
  }

  /** Read raw data from any key. */
  async read(key: string): Promise<string | null> {
    try {
      const exists = await this.client.file(key).exists();
      if (!exists) return null;
      return await this.client.file(key).text();
    } catch {
      return null;
    }
  }

  /** Delete a key. */
  async delete(key: string): Promise<void> {
    await this.client.delete(key);
  }

  /** Check if a key exists. */
  async exists(key: string): Promise<boolean> {
    try {
      return await this.client.file(key).exists();
    } catch {
      return false;
    }
  }

  /** List keys under a prefix. */
  async list(prefix: string, maxKeys = 100): Promise<string[]> {
    return listObjects(this.config, prefix, maxKeys);
  }
}
