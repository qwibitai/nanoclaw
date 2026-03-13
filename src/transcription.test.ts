import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock @whiskeysockets/baileys to avoid import errors
vi.mock('@whiskeysockets/baileys', () => ({
  downloadMediaMessage: vi.fn(),
  WAMessage: {},
  WASocket: {},
}));

// Mock child_process.execFile — set up custom promisify symbol so
// util.promisify(execFile) returns { stdout, stderr } like the real one
vi.mock('child_process', async () => {
  const actual =
    await vi.importActual<typeof import('child_process')>('child_process');
  const mockExecFile: any = vi.fn();
  // When util.promisify is called on this mock during module init,
  // it will use this custom implementation that returns { stdout, stderr }
  mockExecFile[Symbol.for('nodejs.util.promisify.custom')] = (
    ...args: any[]
  ) => {
    return new Promise((resolve, reject) => {
      // Call the mock with a callback appended
      const cb = (err: Error | null, stdout: string, stderr: string) => {
        if (err) reject(err);
        else resolve({ stdout, stderr });
      };
      mockExecFile(...args, cb);
    });
  };
  return {
    ...actual,
    execFile: mockExecFile,
  };
});

// Mock fs to avoid real filesystem operations
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    default: {
      ...actual,
      writeFileSync: vi.fn(),
      unlinkSync: vi.fn(),
      existsSync: vi.fn(() => true),
    },
  };
});

import { execFile } from 'child_process';
import { transcribeAudioFile } from './transcription.js';

// Helper: configure the mocked execFile to handle sequential calls
function mockExecFileSequence(
  calls: Array<{ stdout?: string; stderr?: string; error?: Error }>,
) {
  const mock = vi.mocked(execFile);
  let callIndex = 0;
  mock.mockImplementation(
    (_cmd: any, _args: any, _opts: any, callback?: any) => {
      const cb = typeof _opts === 'function' ? _opts : callback;
      const spec = calls[callIndex++] || { stdout: '', stderr: '' };
      if (spec.error) {
        cb(spec.error, '', '');
      } else {
        cb(null, spec.stdout ?? '', spec.stderr ?? '');
      }
      return {} as any;
    },
  );
}

describe('transcribeAudioFile', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('converts audio to WAV and runs whisper-cli, returning transcript', async () => {
    mockExecFileSequence([
      { stdout: '' }, // ffmpeg conversion succeeds
      { stdout: '  Hello world  ' }, // whisper-cli returns transcript
    ]);

    const result = await transcribeAudioFile('/tmp/test-audio.ogg');

    expect(result).toBe('Hello world');

    // Verify ffmpeg was called with correct args
    const mock = vi.mocked(execFile);
    const ffmpegCall = mock.mock.calls[0];
    expect(ffmpegCall[0]).toBe('ffmpeg');
    expect(ffmpegCall[1]).toEqual(
      expect.arrayContaining(['-i', '/tmp/test-audio.ogg', '-ar', '16000']),
    );

    // Verify whisper-cli was called
    const whisperCall = mock.mock.calls[1];
    expect(whisperCall[0]).toMatch(/whisper/);
  });

  it('returns null when whisper-cli produces empty output', async () => {
    mockExecFileSequence([
      { stdout: '' }, // ffmpeg succeeds
      { stdout: '   ' }, // whisper-cli returns whitespace only
    ]);

    const result = await transcribeAudioFile('/tmp/test-audio.ogg');

    expect(result).toBeNull();
  });

  it('returns null when ffmpeg fails', async () => {
    mockExecFileSequence([
      { error: new Error('ffmpeg: No such file or directory') },
    ]);

    const result = await transcribeAudioFile('/tmp/test-audio.ogg');

    expect(result).toBeNull();
  });
});
