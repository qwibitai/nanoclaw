/**
 * voice.test.ts — Tests for voice note preprocessing and validation.
 *
 * Tests processVoiceNote() (size/duration guards, Sarvam AI integration),
 * parseOggDuration() (OGG header parsing), and multilingual messages.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import {
  processVoiceNote,
  parseOggDuration,
  getDefaultVoiceConfig,
  type VoiceConfig,
  type VoiceResult,
} from './voice.js';

const TEST_CONFIG: VoiceConfig = {
  sarvamApiKey: 'test-sarvam-key',
  sarvamUrl: 'https://api.sarvam.ai/speech-to-text',
  maxSizeBytes: 1_048_576,
  maxDurationSeconds: 120,
};

/** Build a minimal valid OGG page with a specific duration in seconds. */
function buildOggBuffer(seconds: number): Buffer {
  const sampleRate = 48000;
  const granule = BigInt(seconds * sampleRate);

  // OGG page header: 'OggS'(4) + version(1) + flags(1) + granule(8) +
  // serial(4) + seq(4) + crc(4) + num_segments(1) + segment_table(1)
  const header = Buffer.alloc(28);
  header.write('OggS', 0);
  header[4] = 0; // version
  header[5] = 0x04; // flags: last page
  header.writeBigInt64LE(granule, 6);
  header.writeUInt32LE(1, 14); // serial number
  header.writeUInt32LE(0, 18); // page sequence
  header.writeUInt32LE(0, 22); // CRC (skip for test)
  header[26] = 1; // 1 segment
  header[27] = 0; // segment size: 0 bytes

  return header;
}

/** Build an OGG buffer with a specific byte size (pads after valid header). */
function buildOggBufferWithSize(bytes: number, durationSeconds: number): Buffer {
  const header = buildOggBuffer(durationSeconds);
  if (bytes <= header.length) return header.subarray(0, bytes);
  const padding = Buffer.alloc(bytes - header.length);
  return Buffer.concat([header, padding]);
}

describe('parseOggDuration', () => {
  it('returns null for empty buffer', () => {
    expect(parseOggDuration(Buffer.alloc(0))).toBeNull();
  });

  it('returns null for non-OGG buffer', () => {
    expect(parseOggDuration(Buffer.from('not an ogg file'))).toBeNull();
  });

  it('returns null for buffer too short to contain OGG header', () => {
    expect(parseOggDuration(Buffer.from('OggS'))).toBeNull();
  });

  it('parses duration from valid OGG buffer (60 seconds)', () => {
    const buffer = buildOggBuffer(60);
    const duration = parseOggDuration(buffer);
    expect(duration).toBeCloseTo(60, 0);
  });

  it('parses duration from valid OGG buffer (10 seconds)', () => {
    const buffer = buildOggBuffer(10);
    const duration = parseOggDuration(buffer);
    expect(duration).toBeCloseTo(10, 0);
  });

  it('parses duration from valid OGG buffer (120 seconds)', () => {
    const buffer = buildOggBuffer(120);
    const duration = parseOggDuration(buffer);
    expect(duration).toBeCloseTo(120, 0);
  });
});

describe('processVoiceNote', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // ============================================================
  // Size guard
  // ============================================================

  describe('size guard', () => {
    it('rejects audio > 1MB with Marathi message', async () => {
      const bigBuffer = Buffer.alloc(TEST_CONFIG.maxSizeBytes + 1);
      const result = await processVoiceNote(bigBuffer, 'mr', 'msg-1', TEST_CONFIG);
      expect(result.status).toBe('rejected');
      expect(result.message).toBeDefined();
      expect(result.message).toContain('तक्रार');
    });

    it('rejects audio > 1MB with Hindi message', async () => {
      const bigBuffer = Buffer.alloc(TEST_CONFIG.maxSizeBytes + 1);
      const result = await processVoiceNote(bigBuffer, 'hi', 'msg-1', TEST_CONFIG);
      expect(result.status).toBe('rejected');
      expect(result.message).toContain('शिकायत');
    });

    it('rejects audio > 1MB with English message', async () => {
      const bigBuffer = Buffer.alloc(TEST_CONFIG.maxSizeBytes + 1);
      const result = await processVoiceNote(bigBuffer, 'en', 'msg-1', TEST_CONFIG);
      expect(result.status).toBe('rejected');
      expect(result.message).toContain('voice message');
    });

    it('accepts audio exactly at 1MB limit', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          json: async () => ({ transcript: 'transcribed text' }),
        }),
      );
      const buffer = buildOggBufferWithSize(TEST_CONFIG.maxSizeBytes, 30);
      const result = await processVoiceNote(buffer, 'mr', 'msg-1', TEST_CONFIG);
      expect(result.status).toBe('transcript');
    });
  });

  // ============================================================
  // Duration guard
  // ============================================================

  describe('duration guard', () => {
    it('rejects audio > 120s with appropriate message', async () => {
      const buffer = buildOggBuffer(130);
      const result = await processVoiceNote(buffer, 'mr', 'msg-1', TEST_CONFIG);
      expect(result.status).toBe('rejected');
      expect(result.message).toBeDefined();
    });

    it('accepts audio exactly at 120s', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          json: async () => ({ transcript: 'test' }),
        }),
      );
      const buffer = buildOggBuffer(120);
      const result = await processVoiceNote(buffer, 'mr', 'msg-1', TEST_CONFIG);
      expect(result.status).toBe('transcript');
    });

    it('proceeds when OGG duration cannot be parsed (non-OGG file)', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          json: async () => ({ transcript: 'transcribed anyway' }),
        }),
      );
      // Small non-OGG buffer (passes size guard, fails OGG parse)
      const buffer = Buffer.from('not-ogg-but-small-enough');
      const result = await processVoiceNote(buffer, 'mr', 'msg-1', TEST_CONFIG);
      // Should still attempt transcription since size is OK and duration is unknown
      expect(result.status).toBe('transcript');
      expect(result.text).toBe('transcribed anyway');
    });
  });

  // ============================================================
  // Sarvam AI transcription
  // ============================================================

  describe('Sarvam AI transcription', () => {
    it('returns transcript for valid audio', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          json: async () => ({ transcript: 'मला पाणी नाही मिळत' }),
        }),
      );
      const buffer = buildOggBuffer(30);
      const result = await processVoiceNote(buffer, 'mr', 'msg-1', TEST_CONFIG);
      expect(result.status).toBe('transcript');
      expect(result.text).toBe('मला पाणी नाही मिळत');
    });

    it('passes language code and model to Sarvam API', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ transcript: 'test' }),
      });
      vi.stubGlobal('fetch', mockFetch);

      const buffer = buildOggBuffer(10);
      await processVoiceNote(buffer, 'hi', 'msg-1', TEST_CONFIG);

      expect(mockFetch).toHaveBeenCalledOnce();
      const [url, opts] = mockFetch.mock.calls[0];
      expect(url).toBe('https://api.sarvam.ai/speech-to-text');
      expect(opts.headers['api-subscription-key']).toBe('test-sarvam-key');
      const body = opts.body as FormData;
      expect(body.get('language_code')).toBe('hi-IN');
      expect(body.get('model')).toBe('saaras:v3');
    });

    it('maps Marathi language code to mr-IN', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ transcript: 'test' }),
      });
      vi.stubGlobal('fetch', mockFetch);

      const buffer = buildOggBuffer(10);
      await processVoiceNote(buffer, 'mr', 'msg-1', TEST_CONFIG);

      const body = mockFetch.mock.calls[0][1].body as FormData;
      expect(body.get('language_code')).toBe('mr-IN');
    });

    it('maps English language code to en-IN', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ transcript: 'test' }),
      });
      vi.stubGlobal('fetch', mockFetch);

      const buffer = buildOggBuffer(10);
      await processVoiceNote(buffer, 'en', 'msg-1', TEST_CONFIG);

      const body = mockFetch.mock.calls[0][1].body as FormData;
      expect(body.get('language_code')).toBe('en-IN');
    });

    it('omits language_code for unknown languages', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ transcript: 'test' }),
      });
      vi.stubGlobal('fetch', mockFetch);

      const buffer = buildOggBuffer(10);
      await processVoiceNote(buffer, 'te', 'msg-1', TEST_CONFIG);

      const body = mockFetch.mock.calls[0][1].body as FormData;
      expect(body.get('language_code')).toBeNull();
    });

    it('sends audio file as form data', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ transcript: 'test' }),
      });
      vi.stubGlobal('fetch', mockFetch);

      const buffer = buildOggBuffer(10);
      await processVoiceNote(buffer, 'en', 'msg-1', TEST_CONFIG);

      const [, opts] = mockFetch.mock.calls[0];
      const body = opts.body as FormData;
      expect(body.get('file')).toBeTruthy();
    });
  });

  // ============================================================
  // API key validation
  // ============================================================

  describe('API key validation', () => {
    it('returns error when sarvamApiKey is empty', async () => {
      const configNoKey: VoiceConfig = {
        ...TEST_CONFIG,
        sarvamApiKey: '',
      };
      const buffer = buildOggBuffer(10);
      const result = await processVoiceNote(buffer, 'mr', 'msg-1', configNoKey);
      expect(result.status).toBe('error');
      expect(result.message).toBeDefined();
    });
  });

  // ============================================================
  // Edge cases: empty transcript
  // ============================================================

  describe('empty transcript', () => {
    it('returns error when Sarvam returns empty transcript', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          json: async () => ({ transcript: '' }),
        }),
      );
      const buffer = buildOggBuffer(10);
      const result = await processVoiceNote(buffer, 'en', 'msg-1', TEST_CONFIG);
      expect(result.status).toBe('error');
      expect(result.message).toContain('type');
    });

    it('returns error with Marathi message for empty transcript', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          json: async () => ({ transcript: '   ' }),
        }),
      );
      const buffer = buildOggBuffer(10);
      const result = await processVoiceNote(buffer, 'mr', 'msg-1', TEST_CONFIG);
      expect(result.status).toBe('error');
      expect(result.message).toContain('लिहून');
    });
  });

  // ============================================================
  // Edge cases: Sarvam errors
  // ============================================================

  describe('Sarvam errors', () => {
    it('returns error when Sarvam is unreachable (network error)', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockRejectedValue(new Error('ECONNREFUSED')),
      );
      const buffer = buildOggBuffer(10);
      const result = await processVoiceNote(buffer, 'mr', 'msg-1', TEST_CONFIG);
      expect(result.status).toBe('error');
      expect(result.message).toBeDefined();
    });

    it('returns error when Sarvam returns HTTP 500', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: false,
          status: 500,
          statusText: 'Internal Server Error',
          text: async () => 'server error',
        }),
      );
      const buffer = buildOggBuffer(10);
      const result = await processVoiceNote(buffer, 'mr', 'msg-1', TEST_CONFIG);
      expect(result.status).toBe('error');
      expect(result.message).toBeDefined();
    });

    it('returns Hindi error message when Sarvam fails for Hindi user', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockRejectedValue(new Error('ETIMEDOUT')),
      );
      const buffer = buildOggBuffer(10);
      const result = await processVoiceNote(buffer, 'hi', 'msg-1', TEST_CONFIG);
      expect(result.status).toBe('error');
      expect(result.message).toContain('लिखकर');
    });

    it('returns English error message when Sarvam fails for English user', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockRejectedValue(new Error('ECONNREFUSED')),
      );
      const buffer = buildOggBuffer(10);
      const result = await processVoiceNote(buffer, 'en', 'msg-1', TEST_CONFIG);
      expect(result.status).toBe('error');
      expect(result.message).toContain('type');
    });
  });
});

describe('getDefaultVoiceConfig', () => {
  it('returns config with Sarvam API URL', () => {
    const config = getDefaultVoiceConfig();
    expect(config.sarvamUrl).toBeTruthy();
    expect(config.sarvamUrl).toContain('sarvam.ai');
  });

  it('returns config with size limit of 1MB', () => {
    const config = getDefaultVoiceConfig();
    expect(config.maxSizeBytes).toBe(1_048_576);
  });

  it('returns config with duration limit of 120s', () => {
    const config = getDefaultVoiceConfig();
    expect(config.maxDurationSeconds).toBe(120);
  });
});
