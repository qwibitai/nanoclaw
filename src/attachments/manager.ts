/**
 * Channel-Agnostic Attachment Interface
 *
 * Unified attachment handling across all channels (Telegram, Discord, WhatsApp, etc.)
 * Provides a common interface for downloading, processing, and storing attachments
 * regardless of the underlying channel implementation.
 */

import { EventEmitter } from 'events';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { Readable } from 'stream';

/**
 * Supported attachment types
 */
export enum AttachmentType {
  IMAGE = 'image',
  VIDEO = 'video',
  AUDIO = 'audio',
  DOCUMENT = 'document',
  STICKER = 'sticker',
  VOICE = 'voice',
}

/**
 * Attachment metadata
 */
export interface AttachmentMeta {
  id: string;
  filename: string;
  mimeType: string;
  size: number;
  type: AttachmentType;
  width?: number;
  height?: number;
  duration?: number;
  thumbnail?: Buffer;
  caption?: string;
  channelId: string;
  senderId: string;
  timestamp: Date;
}

/**
 * Download result
 */
export interface DownloadResult {
  path: string;
  meta: AttachmentMeta;
  hash: string;
}

/**
 * Channel-specific downloader interface
 */
export interface ChannelDownloader {
  channelType: string;
  
  /**
   * Download attachment from channel
   */
  download(attachmentId: string, meta: AttachmentMeta): Promise<Readable>;
  
  /**
   * Get attachment metadata from channel
   */
  getMeta(attachmentId: string): Promise<AttachmentMeta>;
  
  /**
   * Check if attachment exists
   */
  exists(attachmentId: string): Promise<boolean>;
}

/**
 * Attachment processor function
 */
export type AttachmentProcessor = (
  stream: Readable,
  meta: AttachmentMeta,
) => Promise<Readable | Buffer>;

/**
 * Attachment storage configuration
 */
export interface AttachmentStorageConfig {
  basePath: string;
  maxFileSize: number;
  allowedMimeTypes: string[];
  preserveOriginal: boolean;
}

/**
 * Channel-Agnostic Attachment Manager
 */
export class AttachmentManager extends EventEmitter {
  private downloaders: Map<string, ChannelDownloader> = new Map();
  private processors: Map<AttachmentType, AttachmentProcessor[]> = new Map();
  private config: AttachmentStorageConfig;

  constructor(config: Partial<AttachmentStorageConfig> = {}) {
    super();
    this.config = {
      basePath: config.basePath || './data/attachments',
      maxFileSize: config.maxFileSize || 100 * 1024 * 1024, // 100MB
      allowedMimeTypes: config.allowedMimeTypes || ['*'],
      preserveOriginal: config.preserveOriginal ?? true,
    };

    // Ensure storage directory exists
    fs.mkdirSync(this.config.basePath, { recursive: true });
  }

  /**
   * Register a channel-specific downloader
   */
  registerDownloader(downloader: ChannelDownloader): void {
    this.downloaders.set(downloader.channelType, downloader);
    this.emit('downloader_registered', downloader.channelType);
  }

  /**
   * Register an attachment processor
   */
  registerProcessor(type: AttachmentType, processor: AttachmentProcessor): void {
    if (!this.processors.has(type)) {
      this.processors.set(type, []);
    }
    this.processors.get(type)!.push(processor);
    this.emit('processor_registered', type);
  }

  /**
   * Download and process attachment from any channel
   */
  async download(
    channelType: string,
    attachmentId: string,
    meta?: AttachmentMeta,
  ): Promise<DownloadResult> {
    const downloader = this.downloaders.get(channelType);
    if (!downloader) {
      throw new Error(`No downloader registered for channel: ${channelType}`);
    }

    // Get metadata if not provided
    const finalMeta = meta || await downloader.getMeta(attachmentId);

    // Validate
    this.validateAttachment(finalMeta);

    // Download stream
    const stream = await downloader.download(attachmentId, finalMeta);

    // Process through pipeline
    let processed = await this.processPipeline(stream, finalMeta);

    // Calculate hash for deduplication
    const hash = await this.calculateHash(processed);

    // Store to disk
    const storagePath = this.getStoragePath(finalMeta, hash);
    await this.store(processed, storagePath);

    this.emit('downloaded', { meta: finalMeta, path: storagePath, hash });

    return {
      path: storagePath,
      meta: finalMeta,
      hash,
    };
  }

  /**
   * Detect attachment type from MIME type
   */
  detectType(mimeType: string): AttachmentType {
    if (mimeType.startsWith('image/')) return AttachmentType.IMAGE;
    if (mimeType.startsWith('video/')) return AttachmentType.VIDEO;
    if (mimeType.startsWith('audio/')) {
      if (mimeType.includes('ogg') || mimeType.includes('opus')) {
        return AttachmentType.VOICE;
      }
      return AttachmentType.AUDIO;
    }
    if (mimeType === 'image/webp' && mimeType.includes('sticker')) {
      return AttachmentType.STICKER;
    }
    return AttachmentType.DOCUMENT;
  }

  /**
   * Process stream through registered processors
   */
  private async processPipeline(
    stream: Readable,
    meta: AttachmentMeta,
  ): Promise<Readable | Buffer> {
    const processors = this.processors.get(meta.type) || [];
    
    let current: Readable | Buffer = stream;
    
    for (const processor of processors) {
      if (current instanceof Readable) {
        current = await processor(current, meta);
      } else {
        // Convert Buffer back to Readable for next processor
        const readable = new Readable();
        readable.push(current);
        readable.push(null);
        current = await processor(readable, meta);
      }
    }

    return current;
  }

  /**
   * Calculate SHA-256 hash of content
   */
  private async calculateHash(content: Readable | Buffer): Promise<string> {
    const hasher = crypto.createHash('sha256');
    
    if (Buffer.isBuffer(content)) {
      hasher.update(content);
    } else {
      for await (const chunk of content) {
        hasher.update(chunk);
      }
      // Reset stream if it's a Readable
      if (content instanceof Readable) {
        content.destroy();
      }
    }

    return hasher.digest('hex');
  }

  /**
   * Get storage path for attachment
   */
  private getStoragePath(meta: AttachmentMeta, hash: string): string {
    const dateDir = meta.timestamp.toISOString().split('T')[0];
    const ext = path.extname(meta.filename) || this.mimeToExt(meta.mimeType);
    const filename = `${meta.id}_${hash.substring(0, 8)}${ext}`;
    
    return path.join(
      this.config.basePath,
      meta.channelId,
      meta.type,
      dateDir,
      filename,
    );
  }

  /**
   * Store attachment to disk
   */
  private async store(content: Readable | Buffer, storagePath: string): Promise<void> {
    const dir = path.dirname(storagePath);
    fs.mkdirSync(dir, { recursive: true });

    if (Buffer.isBuffer(content)) {
      fs.writeFileSync(storagePath, content);
    } else {
      const writeStream = fs.createWriteStream(storagePath);
      await new Promise((resolve, reject) => {
        content.pipe(writeStream);
        writeStream.on('finish', resolve);
        writeStream.on('error', reject);
      });
    }
  }

  /**
   * Validate attachment against config
   */
  private validateAttachment(meta: AttachmentMeta): void {
    // Check size
    if (meta.size > this.config.maxFileSize) {
      throw new Error(`Attachment too large: ${meta.size} > ${this.config.maxFileSize}`);
    }

    // Check MIME type
    if (!this.config.allowedMimeTypes.includes('*')) {
      if (!this.config.allowedMimeTypes.includes(meta.mimeType)) {
        throw new Error(`MIME type not allowed: ${meta.mimeType}`);
      }
    }
  }

  /**
   * Convert MIME type to file extension
   */
  private mimeToExt(mimeType: string): string {
    const map: Record<string, string> = {
      'image/jpeg': '.jpg',
      'image/png': '.png',
      'image/gif': '.gif',
      'image/webp': '.webp',
      'video/mp4': '.mp4',
      'video/webm': '.webm',
      'audio/mp3': '.mp3',
      'audio/ogg': '.ogg',
      'application/pdf': '.pdf',
    };
    return map[mimeType] || '.bin';
  }
}

export {
  AttachmentType as AttachmentType,
  type AttachmentMeta,
  type DownloadResult,
  type ChannelDownloader,
  type AttachmentProcessor,
  type AttachmentStorageConfig,
};
