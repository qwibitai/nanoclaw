import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockGenerateContent = vi.fn();

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

// Mock @google/generative-ai — use the hoisted mockGenerateContent
vi.mock('@google/generative-ai', () => ({
  GoogleGenerativeAI: class {
    getGenerativeModel() {
      return { generateContent: mockGenerateContent };
    }
  },
}));

import { readEnvFile } from './env.js';
import { logger } from './logger.js';

describe('gemini', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  describe('isGeminiEnabled', () => {
    it('returns false when no API key is set', async () => {
      vi.mocked(readEnvFile).mockReturnValue({});
      const { isGeminiEnabled } = await import('./gemini.js');
      expect(isGeminiEnabled()).toBe(false);
    });

    it('returns true when API key is in env file', async () => {
      vi.mocked(readEnvFile).mockReturnValue({ GEMINI_API_KEY: 'test-key' });
      const { isGeminiEnabled } = await import('./gemini.js');
      expect(isGeminiEnabled()).toBe(true);
    });

    it('returns true when API key is in process.env', async () => {
      process.env.GEMINI_API_KEY = 'test-key';
      vi.mocked(readEnvFile).mockReturnValue({});
      const { isGeminiEnabled } = await import('./gemini.js');
      expect(isGeminiEnabled()).toBe(true);
      delete process.env.GEMINI_API_KEY;
    });
  });

  describe('analyzeImage', () => {
    it('returns description on success', async () => {
      vi.mocked(readEnvFile).mockReturnValue({ GEMINI_API_KEY: 'test-key' });
      mockGenerateContent.mockResolvedValue({
        response: { text: () => 'A cat sitting on a table' },
      });

      const { analyzeImage } = await import('./gemini.js');
      const result = await analyzeImage(Buffer.from('fake-image'), 'image/jpeg');

      expect(result).toBe('A cat sitting on a table');
      expect(mockGenerateContent).toHaveBeenCalledWith([
        'Describe this image in detail.',
        {
          inlineData: {
            data: Buffer.from('fake-image').toString('base64'),
            mimeType: 'image/jpeg',
          },
        },
      ]);
    });

    it('includes caption in prompt when provided', async () => {
      vi.mocked(readEnvFile).mockReturnValue({ GEMINI_API_KEY: 'test-key' });
      mockGenerateContent.mockResolvedValue({
        response: { text: () => 'Description' },
      });

      const { analyzeImage } = await import('./gemini.js');
      await analyzeImage(Buffer.from('fake'), 'image/png', 'my cat');

      expect(mockGenerateContent).toHaveBeenCalledWith([
        expect.stringContaining('my cat'),
        expect.any(Object),
      ]);
    });

    it('defaults mimeType to image/jpeg', async () => {
      vi.mocked(readEnvFile).mockReturnValue({ GEMINI_API_KEY: 'test-key' });
      mockGenerateContent.mockResolvedValue({
        response: { text: () => 'Description' },
      });

      const { analyzeImage } = await import('./gemini.js');
      await analyzeImage(Buffer.from('fake'));

      expect(mockGenerateContent).toHaveBeenCalledWith([
        expect.any(String),
        {
          inlineData: {
            data: expect.any(String),
            mimeType: 'image/jpeg',
          },
        },
      ]);
    });

    it('returns null and logs error on failure', async () => {
      vi.mocked(readEnvFile).mockReturnValue({ GEMINI_API_KEY: 'test-key' });
      mockGenerateContent.mockRejectedValue(new Error('API error'));

      const { analyzeImage } = await import('./gemini.js');
      const result = await analyzeImage(Buffer.from('fake'));

      expect(result).toBeNull();
      expect(logger.error).toHaveBeenCalled();
    });

    it('returns null when response text is empty', async () => {
      vi.mocked(readEnvFile).mockReturnValue({ GEMINI_API_KEY: 'test-key' });
      mockGenerateContent.mockResolvedValue({
        response: { text: () => '' },
      });

      const { analyzeImage } = await import('./gemini.js');
      const result = await analyzeImage(Buffer.from('fake'));

      expect(result).toBeNull();
    });
  });

  describe('analyzeVideo', () => {
    it('returns description on success', async () => {
      vi.mocked(readEnvFile).mockReturnValue({ GEMINI_API_KEY: 'test-key' });
      mockGenerateContent.mockResolvedValue({
        response: { text: () => 'A person walking in a park' },
      });

      const { analyzeVideo } = await import('./gemini.js');
      const result = await analyzeVideo(Buffer.from('fake-video'), 'video/mp4');

      expect(result).toBe('A person walking in a park');
    });

    it('returns size limit message for large videos', async () => {
      vi.mocked(readEnvFile).mockReturnValue({ GEMINI_API_KEY: 'test-key' });

      const { analyzeVideo } = await import('./gemini.js');
      const largeBuffer = Buffer.alloc(21 * 1024 * 1024);
      const result = await analyzeVideo(largeBuffer, 'video/mp4');

      expect(result).toContain('too large');
      expect(mockGenerateContent).not.toHaveBeenCalled();
    });

    it('returns null and logs error on failure', async () => {
      vi.mocked(readEnvFile).mockReturnValue({ GEMINI_API_KEY: 'test-key' });
      mockGenerateContent.mockRejectedValue(new Error('timeout'));

      const { analyzeVideo } = await import('./gemini.js');
      const result = await analyzeVideo(Buffer.from('fake'), 'video/mp4');

      expect(result).toBeNull();
      expect(logger.error).toHaveBeenCalled();
    });

    it('includes caption in prompt when provided', async () => {
      vi.mocked(readEnvFile).mockReturnValue({ GEMINI_API_KEY: 'test-key' });
      mockGenerateContent.mockResolvedValue({
        response: { text: () => 'Description' },
      });

      const { analyzeVideo } = await import('./gemini.js');
      await analyzeVideo(Buffer.from('fake'), 'video/mp4', 'beach trip');

      expect(mockGenerateContent).toHaveBeenCalledWith([
        expect.stringContaining('beach trip'),
        expect.any(Object),
      ]);
    });
  });
});
