import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import https from 'https';
import { EventEmitter, Readable, Writable } from 'stream';
import { downloadFile } from './download.js';

describe('downloadFile', () => {
  let mockWriteStream: Writable & { close: ReturnType<typeof vi.fn> };
  let mockResponse: Readable & { statusCode?: number };
  let mockRequest: EventEmitter;
  let unlinkSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // Create mock write stream
    mockWriteStream = new Writable({
      write(_chunk, _encoding, callback) {
        callback();
      },
    }) as any;
    mockWriteStream.close = vi.fn((cb?: () => void) => {
      if (cb) cb();
    });

    // Create mock response
    mockResponse = new Readable({ read() {} });
    mockResponse.statusCode = 200;

    // Create mock request
    mockRequest = new EventEmitter();

    vi.spyOn(fs, 'createWriteStream').mockReturnValue(mockWriteStream as any);
    vi.spyOn(https, 'get').mockImplementation((_url: any, cb: any) => {
      cb(mockResponse);
      return mockRequest as any;
    });
    unlinkSpy = vi
      .spyOn(fs, 'unlink')
      .mockImplementation((_path: any, cb: any) => {
        if (cb) cb(null);
      });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('downloads file successfully and writes to dest path', async () => {
    const promise = downloadFile(
      'https://example.com/photo.jpg',
      '/tmp/photo.jpg',
    );

    // Simulate data and end
    mockResponse.push(Buffer.from('image-data'));
    mockResponse.push(null);

    // Trigger finish on write stream
    mockWriteStream.emit('finish');

    await promise;

    expect(fs.createWriteStream).toHaveBeenCalledWith('/tmp/photo.jpg');
    expect(https.get).toHaveBeenCalledWith(
      'https://example.com/photo.jpg',
      expect.any(Function),
    );
  });

  it('rejects when HTTP status is not 200', async () => {
    mockResponse.statusCode = 404;

    const promise = downloadFile(
      'https://example.com/missing.jpg',
      '/tmp/missing.jpg',
    );

    await expect(promise).rejects.toThrow('Download failed with status 404');
    expect(unlinkSpy).toHaveBeenCalledWith(
      '/tmp/missing.jpg',
      expect.any(Function),
    );
  });

  it('rejects on network error', async () => {
    vi.spyOn(https, 'get').mockImplementation((_url: any, _cb: any) => {
      const req = new EventEmitter();
      setTimeout(() => req.emit('error', new Error('ECONNRESET')), 0);
      return req as any;
    });

    await expect(
      downloadFile('https://example.com/photo.jpg', '/tmp/photo.jpg'),
    ).rejects.toThrow('ECONNRESET');
    expect(unlinkSpy).toHaveBeenCalledWith(
      '/tmp/photo.jpg',
      expect.any(Function),
    );
  });
});
