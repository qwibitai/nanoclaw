import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';

// Mock child_process before importing the module
vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
  execFileSync: vi.fn(),
}));

// Mock logger
vi.mock('./logger.js', () => ({
  logger: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  },
}));

import { transcribeAudio, downloadToTemp } from './transcription.js';

const mockExecFile = vi.mocked(execFile);

describe('transcribeAudio', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('converts audio to WAV and runs whisper-cli', async () => {
    // Mock ffmpeg (first call) and whisper-cli (second call)
    let callCount = 0;
    mockExecFile.mockImplementation(
      (cmd: any, args: any, opts: any, cb?: any) => {
        const callback = cb || opts;
        callCount++;
        if (callCount === 1) {
          // ffmpeg call
          expect(cmd).toBe('ffmpeg');
          expect(args).toContain('-ar');
          expect(args).toContain('16000');
          callback(null, { stdout: '', stderr: '' });
        } else {
          // whisper-cli call
          expect(cmd).toBe('whisper-cli');
          expect(args).toContain('-m');
          expect(args).toContain('--no-timestamps');
          callback(null, { stdout: 'Hello, this is a test message', stderr: '' });
        }
        return {} as any;
      },
    );

    // Create a temp file to transcribe
    const tmpFile = path.join('/tmp', `test-audio-${Date.now()}.oga`);
    fs.writeFileSync(tmpFile, 'fake audio data');

    const result = await transcribeAudio(tmpFile);
    expect(result).toBe('Hello, this is a test message');
    expect(callCount).toBe(2);

    // Clean up
    try {
      fs.unlinkSync(tmpFile);
    } catch {
      /* already cleaned */
    }
  });

  it('returns null when ffmpeg fails', async () => {
    mockExecFile.mockImplementation(
      (cmd: any, args: any, opts: any, cb?: any) => {
        const callback = cb || opts;
        callback(new Error('ffmpeg not found'), { stdout: '', stderr: '' });
        return {} as any;
      },
    );

    const tmpFile = path.join('/tmp', `test-audio-${Date.now()}.oga`);
    fs.writeFileSync(tmpFile, 'fake audio data');

    const result = await transcribeAudio(tmpFile);
    expect(result).toBeNull();

    try {
      fs.unlinkSync(tmpFile);
    } catch {
      /* already cleaned */
    }
  });

  it('returns null when whisper returns empty output', async () => {
    let callCount = 0;
    mockExecFile.mockImplementation(
      (cmd: any, args: any, opts: any, cb?: any) => {
        const callback = cb || opts;
        callCount++;
        if (callCount === 1) {
          callback(null, { stdout: '', stderr: '' });
        } else {
          callback(null, { stdout: '   \n  ', stderr: '' });
        }
        return {} as any;
      },
    );

    const tmpFile = path.join('/tmp', `test-audio-${Date.now()}.oga`);
    fs.writeFileSync(tmpFile, 'fake audio data');

    const result = await transcribeAudio(tmpFile);
    expect(result).toBeNull();

    try {
      fs.unlinkSync(tmpFile);
    } catch {
      /* already cleaned */
    }
  });
});

describe('downloadToTemp', () => {
  it('downloads a URL to a temp file', async () => {
    const mockResponse = {
      ok: true,
      arrayBuffer: () => Promise.resolve(new Uint8Array([1, 2, 3]).buffer),
    };
    global.fetch = vi.fn().mockResolvedValue(mockResponse);

    const result = await downloadToTemp('https://example.com/audio.oga', '.oga');
    expect(result).not.toBeNull();
    expect(result).toContain('audio.oga');
    expect(fs.existsSync(result!)).toBe(true);

    // Clean up
    fs.unlinkSync(result!);
    fs.rmdirSync(path.dirname(result!));
  });

  it('returns null on fetch failure', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 404 });

    const result = await downloadToTemp('https://example.com/missing.oga', '.oga');
    expect(result).toBeNull();
  });
});
