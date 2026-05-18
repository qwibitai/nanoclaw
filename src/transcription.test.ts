import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

vi.mock('./log.js', () => ({
  log: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// child_process.execFile is wrapped via util.promisify. Mock the callback-style
// function so the promisified version resolves with whatever we queue.
const execFileMock = vi.hoisted(() =>
  vi.fn(
    (
      _bin: string,
      _args: string[],
      _opts: unknown,
      cb: (err: Error | null, result: { stdout: string; stderr: string }) => void,
    ) => {
      cb(null, { stdout: '', stderr: '' });
    },
  ),
);

vi.mock('child_process', () => ({
  execFile: execFileMock,
}));

vi.mock('fs', () => ({
  default: {
    writeFileSync: vi.fn(),
    unlinkSync: vi.fn(),
  },
}));

import { isAudioAttachment, transcribeAudioBuffer } from './transcription.js';

describe('isAudioAttachment', () => {
  it('returns true for audio/* mimeTypes', () => {
    expect(isAudioAttachment({ mimeType: 'audio/ogg' })).toBe(true);
    expect(isAudioAttachment({ mimeType: 'audio/mpeg' })).toBe(true);
    expect(isAudioAttachment({ mimeType: 'audio/mp4' })).toBe(true);
  });

  it('returns true for type "audio" or "voice" when mimeType is missing', () => {
    expect(isAudioAttachment({ type: 'audio' })).toBe(true);
    expect(isAudioAttachment({ type: 'voice' })).toBe(true);
  });

  it('returns false for non-audio attachments', () => {
    expect(isAudioAttachment({ mimeType: 'image/jpeg' })).toBe(false);
    expect(isAudioAttachment({ mimeType: 'application/pdf' })).toBe(false);
    expect(isAudioAttachment({ type: 'document' })).toBe(false);
  });

  it('returns false for null/undefined', () => {
    expect(isAudioAttachment(null)).toBe(false);
    expect(isAudioAttachment(undefined)).toBe(false);
    expect(isAudioAttachment({})).toBe(false);
  });
});

describe('transcribeAudioBuffer', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    execFileMock.mockReset();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('returns null when WHISPER_BIN is unset', async () => {
    delete process.env.WHISPER_BIN;
    const result = await transcribeAudioBuffer(Buffer.from('fake audio'));
    expect(result).toBeNull();
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it('returns trimmed transcript on success', async () => {
    process.env.WHISPER_BIN = 'whisper-cli';
    execFileMock
      .mockImplementationOnce((_bin, _args, _opts, cb) => {
        // ffmpeg call — stdout empty is fine
        cb(null, { stdout: '', stderr: '' });
      })
      .mockImplementationOnce((_bin, _args, _opts, cb) => {
        // whisper-cli call — transcript with trailing whitespace
        cb(null, { stdout: '  hello there  \n', stderr: '' });
      });

    const result = await transcribeAudioBuffer(Buffer.from('fake audio'));
    expect(result).toBe('hello there');
    expect(execFileMock).toHaveBeenCalledTimes(2);
  });

  it('returns null when whisper produces empty output', async () => {
    process.env.WHISPER_BIN = 'whisper-cli';
    execFileMock.mockImplementation((_bin, _args, _opts, cb) => {
      cb(null, { stdout: '   \n', stderr: '' });
    });

    const result = await transcribeAudioBuffer(Buffer.from('fake audio'));
    expect(result).toBeNull();
  });

  it('returns null when ffmpeg or whisper throws', async () => {
    process.env.WHISPER_BIN = 'whisper-cli';
    execFileMock.mockImplementation((_bin, _args, _opts, cb) => {
      cb(new Error('command failed'), { stdout: '', stderr: 'boom' });
    });

    const result = await transcribeAudioBuffer(Buffer.from('fake audio'));
    expect(result).toBeNull();
  });
});
