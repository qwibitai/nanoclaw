/**
 * @fileoverview Tests for channel-agnostic attachment manager
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { Readable } from 'stream';
import {
  AttachmentManager,
  AttachmentType,
  type ChannelDownloader,
  type AttachmentMeta,
} from '../attachments/manager.js';

describe('AttachmentManager', () => {
  let manager: AttachmentManager;
  const testStoragePath = './test-attachments';

  beforeEach(() => {
    manager = new AttachmentManager({
      basePath: testStoragePath,
      maxFileSize: 1024 * 1024, // 1MB for tests
    });
  });

  afterEach(() => {
    // Cleanup test directory
    if (fs.existsSync(testStoragePath)) {
      fs.rmSync(testStoragePath, { recursive: true });
    }
    manager.removeAllListeners();
  });

  describe('registerDownloader', () => {
    it('should register channel downloader', () => {
      const downloader: ChannelDownloader = {
        channelType: 'test-channel',
        download: async () => Readable.from([]),
        getMeta: async () => ({}) as any,
        exists: async () => true,
      };

      const eventPromise = new Promise<string>(resolve => {
        manager.on('downloader_registered', resolve);
      });

      manager.registerDownloader(downloader);

      return expect(eventPromise).resolves.toBe('test-channel');
    });
  });

  describe('registerProcessor', () => {
    it('should register attachment processor', () => {
      const processor = async (stream: Readable) => stream;

      const eventPromise = new Promise<AttachmentType>(resolve => {
        manager.on('processor_registered', resolve);
      });

      manager.registerProcessor(AttachmentType.IMAGE, processor);

      return expect(eventPromise).resolves.toBe(AttachmentType.IMAGE);
    });
  });

  describe('detectType', () => {
    it('should detect image types', () => {
      expect(manager.detectType('image/jpeg')).toBe(AttachmentType.IMAGE);
      expect(manager.detectType('image/png')).toBe(AttachmentType.IMAGE);
      expect(manager.detectType('image/gif')).toBe(AttachmentType.IMAGE);
    });

    it('should detect video types', () => {
      expect(manager.detectType('video/mp4')).toBe(AttachmentType.VIDEO);
      expect(manager.detectType('video/webm')).toBe(AttachmentType.VIDEO);
    });

    it('should detect audio types', () => {
      expect(manager.detectType('audio/mpeg')).toBe(AttachmentType.AUDIO);
      expect(manager.detectType('audio/wav')).toBe(AttachmentType.AUDIO);
    });

    it('should detect voice messages', () => {
      expect(manager.detectType('audio/ogg')).toBe(AttachmentType.VOICE);
      expect(manager.detectType('audio/opus')).toBe(AttachmentType.VOICE);
    });

    it('should detect documents', () => {
      expect(manager.detectType('application/pdf')).toBe(AttachmentType.DOCUMENT);
      expect(manager.detectType('text/plain')).toBe(AttachmentType.DOCUMENT);
    });
  });

  describe('download', () => {
    it('should throw if no downloader registered', async () => {
      const meta: AttachmentMeta = {
        id: 'test-id',
        filename: 'test.jpg',
        mimeType: 'image/jpeg',
        size: 1000,
        type: AttachmentType.IMAGE,
        channelId: 'test',
        senderId: 'user',
        timestamp: new Date(),
      };

      await expect(manager.download('telegram', 'test-id', meta))
        .rejects.toThrow('No downloader registered');
    });

    it('should validate file size', async () => {
      const downloader: ChannelDownloader = {
        channelType: 'test',
        download: async () => Readable.from([]),
        getMeta: async () => ({}) as any,
        exists: async () => true,
      };
      manager.registerDownloader(downloader);

      const meta: AttachmentMeta = {
        id: 'test-id',
        filename: 'huge.jpg',
        mimeType: 'image/jpeg',
        size: 10 * 1024 * 1024, // 10MB - exceeds 1MB limit
        type: AttachmentType.IMAGE,
        channelId: 'test',
        senderId: 'user',
        timestamp: new Date(),
      };

      await expect(manager.download('test', 'test-id', meta))
        .rejects.toThrow('too large');
    });
  });

  describe('hasCredential', () => {
    it('should return false for non-existent credential', () => {
      expect(manager.hasCredential('group-1', 'anthropic')).toBe(false);
    });
  });

  describe('listProviders', () => {
    it('should return empty array for unknown group', () => {
      expect(manager.listProviders('unknown-group')).toEqual([]);
    });
  });
});

describe('ChannelDownloader interface', () => {
  it('should define required methods', () => {
    const downloader: ChannelDownloader = {
      channelType: 'test',
      download: async () => Readable.from([]),
      getMeta: async () => ({
        id: 'test',
        filename: 'test.jpg',
        mimeType: 'image/jpeg',
        size: 1000,
        type: AttachmentType.IMAGE,
        channelId: 'test',
        senderId: 'user',
        timestamp: new Date(),
      }),
      exists: async () => true,
    };

    expect(downloader.channelType).toBe('test');
    expect(downloader.download).toBeDefined();
    expect(downloader.getMeta).toBeDefined();
    expect(downloader.exists).toBeDefined();
  });
});

describe('AttachmentMeta interface', () => {
  it('should include all required fields', () => {
    const meta: AttachmentMeta = {
      id: 'test-id',
      filename: 'image.jpg',
      mimeType: 'image/jpeg',
      size: 12345,
      type: AttachmentType.IMAGE,
      width: 800,
      height: 600,
      channelId: 'telegram',
      senderId: 'user-123',
      timestamp: new Date(),
    };

    expect(meta.id).toBe('test-id');
    expect(meta.width).toBe(800);
    expect(meta.height).toBe(600);
  });
});
