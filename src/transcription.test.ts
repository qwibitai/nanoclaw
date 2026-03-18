import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock env
vi.mock('./env.js', () => ({
  readEnvFile: vi.fn(() => ({})),
}));

// Mock logger
vi.mock('./logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Mock openai
const mockCreate = vi.fn();

class MockOpenAI {
  audio = {
    transcriptions: {
      create: mockCreate,
    },
  };
}

vi.mock('openai', () => ({
  default: MockOpenAI,
  toFile: vi.fn(async (buffer: Buffer, name: string) => ({ name, buffer })),
}));

import { readEnvFile } from './env.js';

// Each test re-imports the module to get a fresh cached client
describe('transcription', () => {
  beforeEach(() => {
    vi.resetModules();
    mockCreate.mockReset();
  });

  describe('isTranscriptionAvailable', () => {
    it('returns false when OPENAI_API_KEY is not set', async () => {
      vi.mocked(readEnvFile).mockReturnValue({});
      const { isTranscriptionAvailable } = await import('./transcription.js');
      expect(isTranscriptionAvailable()).toBe(false);
    });

    it('returns true when OPENAI_API_KEY is set', async () => {
      vi.mocked(readEnvFile).mockReturnValue({
        OPENAI_API_KEY: 'sk-test-key',
      });
      const { isTranscriptionAvailable } = await import('./transcription.js');
      expect(isTranscriptionAvailable()).toBe(true);
    });
  });

  describe('transcribeAudio', () => {
    it('returns null when no API key configured', async () => {
      vi.mocked(readEnvFile).mockReturnValue({});
      const { transcribeAudio } = await import('./transcription.js');

      const result = await transcribeAudio(
        Buffer.from('audio-data'),
        'voice.ogg',
      );
      expect(result).toBeNull();
    });

    it('returns transcribed text on success', async () => {
      vi.mocked(readEnvFile).mockReturnValue({
        OPENAI_API_KEY: 'sk-test-key',
      });
      mockCreate.mockResolvedValue({ text: 'Hello world' });

      const { transcribeAudio } = await import('./transcription.js');

      const result = await transcribeAudio(
        Buffer.from('audio-data'),
        'voice.ogg',
      );
      expect(result).toBe('Hello world');
    });

    it('returns null on API error (graceful fallback)', async () => {
      vi.mocked(readEnvFile).mockReturnValue({
        OPENAI_API_KEY: 'sk-test-key',
      });
      mockCreate.mockRejectedValue(new Error('API error'));

      const { transcribeAudio } = await import('./transcription.js');

      const result = await transcribeAudio(
        Buffer.from('audio-data'),
        'voice.ogg',
      );
      expect(result).toBeNull();
    });

    it('returns null when response has empty text', async () => {
      vi.mocked(readEnvFile).mockReturnValue({
        OPENAI_API_KEY: 'sk-test-key',
      });
      mockCreate.mockResolvedValue({ text: '' });

      const { transcribeAudio } = await import('./transcription.js');

      const result = await transcribeAudio(
        Buffer.from('audio-data'),
        'voice.ogg',
      );
      expect(result).toBeNull();
    });
  });
});
