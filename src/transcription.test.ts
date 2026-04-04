import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the openai module
vi.mock('openai', () => {
  const mockCreate = vi.fn();
  return {
    default: class MockOpenAI {
      audio = { transcriptions: { create: mockCreate } };
    },
    __mockCreate: mockCreate,
  };
});

// Mock env
vi.mock('./env.js', () => ({
  readEnvFile: vi.fn().mockReturnValue({
    OPENAI_API_KEY: 'sk-test-key',
  }),
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

import { transcribeAudio } from './transcription.js';

// Access the mock for assertions
const { __mockCreate: mockCreate } = await import('openai') as any;

describe('transcribeAudio', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns transcript text on success', async () => {
    mockCreate.mockResolvedValueOnce({ text: 'Hello world' });

    const result = await transcribeAudio(
      Buffer.from('fake-audio'),
      'clip.m4a',
    );

    expect(result).toBe('Hello world');
    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'gpt-4o-mini-transcribe',
        file: expect.any(Object),
      }),
    );
  });

  it('returns null when transcript is empty', async () => {
    mockCreate.mockResolvedValueOnce({ text: '' });

    const result = await transcribeAudio(
      Buffer.from('silence'),
      'silence.m4a',
    );

    expect(result).toBeNull();
  });

  it('returns null when API call fails', async () => {
    mockCreate.mockRejectedValueOnce(new Error('API error'));

    const result = await transcribeAudio(
      Buffer.from('bad-audio'),
      'bad.m4a',
    );

    expect(result).toBeNull();
  });
});
