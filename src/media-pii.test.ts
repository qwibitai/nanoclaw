import fs from 'fs';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AnonymizeConfig } from './anonymize.js';

// Mock PDFParse class before importing media-pii
const mockGetText = vi.fn();
const mockDestroy = vi.fn();
vi.mock('pdf-parse', () => {
  class MockPDFParse {
    getText = mockGetText;
    destroy = mockDestroy;
  }
  return { PDFParse: MockPDFParse };
});

import {
  checkImagePii,
  checkMediaPii,
  checkPdfPii,
  extractPdfText,
  substitutePdfContent,
  warmupVisionModel,
} from './media-pii.js';

const mockFetch = vi.fn();

const baseCfg: AnonymizeConfig = {
  enabled: true,
  piiCheck: true,
  piiModel: 'qwen2.5:7b',
  mediaPiiCheck: true,
  piiVisionModel: 'llava:7b',
  mappings: { Olivia: 'Luna', Simon: 'Alex' },
};

const groupDir = '/tmp/test-group';

beforeEach(() => {
  vi.stubGlobal('fetch', mockFetch);
  vi.spyOn(fs, 'statSync').mockReturnValue({ size: 1024 } as fs.Stats);
  vi.spyOn(fs, 'readFileSync').mockReturnValue(Buffer.from('fake content'));
  mockDestroy.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  mockFetch.mockReset();
  mockGetText.mockReset();
  mockDestroy.mockReset();
});

describe('extractPdfText', () => {
  it('returns extracted text from a PDF', async () => {
    mockGetText.mockResolvedValue({ text: 'Hello World' });

    const result = await extractPdfText('/tmp/test.pdf');
    expect(result).toBe('Hello World');
  });

  it('returns null for PDFs larger than 10MB', async () => {
    vi.spyOn(fs, 'statSync').mockReturnValue({
      size: 11 * 1024 * 1024,
    } as fs.Stats);

    const result = await extractPdfText('/tmp/large.pdf');
    expect(result).toBeNull();
    expect(mockGetText).not.toHaveBeenCalled();
  });

  it('returns null when pdf-parse throws', async () => {
    mockGetText.mockRejectedValue(new Error('encrypted'));

    const result = await extractPdfText('/tmp/encrypted.pdf');
    expect(result).toBeNull();
  });

  it('returns null when pdf has no text', async () => {
    mockGetText.mockResolvedValue({ text: '' });

    const result = await extractPdfText('/tmp/empty.pdf');
    expect(result).toBeNull();
  });
});

describe('checkPdfPii', () => {
  it('detects PII in PDF text and tags with source', async () => {
    mockGetText.mockResolvedValue({
      text: 'Report by Claire Smith about the case',
    });

    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        response: JSON.stringify({
          found: [{ text: 'Claire Smith', type: 'name' }],
        }),
      }),
    });

    const items = await checkPdfPii('/tmp/report.pdf', 'report.pdf', baseCfg);
    expect(items).toHaveLength(1);
    expect(items[0].text).toBe('Claire Smith');
    expect(items[0].source).toBe('report.pdf');
    expect(items[0].suggestion).toBe('Ember');
  });

  it('returns empty array when PDF extraction fails', async () => {
    mockGetText.mockRejectedValue(new Error('corrupt'));

    const items = await checkPdfPii('/tmp/bad.pdf', 'bad.pdf', baseCfg);
    expect(items).toHaveLength(0);
  });

  it('returns empty array when no PII found in PDF', async () => {
    mockGetText.mockResolvedValue({ text: 'Luna and Alex went shopping' });

    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        response: JSON.stringify({ found: [] }),
      }),
    });

    const items = await checkPdfPii('/tmp/clean.pdf', 'clean.pdf', baseCfg);
    expect(items).toHaveLength(0);
  });
});

describe('checkImagePii', () => {
  it('detects PII via two-stage pipeline (vision extract → text PII check)', async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ response: 'Letter to Dr Patel, 15 Oak Road' }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          response: JSON.stringify({
            found: [{ text: 'Dr Patel', type: 'name' }],
          }),
        }),
      });

    const result = await checkImagePii('/tmp/doc.jpg', 'img-1234.jpg', baseCfg);
    expect(result.items).toHaveLength(1);
    expect(result.items[0].text).toBe('Dr Patel');
    expect(result.items[0].source).toBe('img-1234.jpg');
    expect(result.failure).toBeUndefined();
  });

  it('returns failure when vision model is unreachable (fail-closed)', async () => {
    mockFetch.mockRejectedValue(new Error('Connection refused'));

    const result = await checkImagePii('/tmp/doc.jpg', 'img-1234.jpg', baseCfg);
    expect(result.items).toHaveLength(0);
    expect(result.failure).toBeDefined();
    expect(result.failure!.filename).toBe('img-1234.jpg');
  });

  it('returns clean (no failure) when vision model extracts no text', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ response: '' }),
    });

    const result = await checkImagePii(
      '/tmp/clean.jpg',
      'img-5678.jpg',
      baseCfg,
    );
    expect(result.items).toHaveLength(0);
    expect(result.failure).toBeUndefined();
  });

  it('returns clean when text PII check finds nothing', async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ response: 'A picture of a sunset' }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          response: JSON.stringify({ found: [] }),
        }),
      });

    const result = await checkImagePii(
      '/tmp/sunset.jpg',
      'img-5678.jpg',
      baseCfg,
    );
    expect(result.items).toHaveLength(0);
    expect(result.failure).toBeUndefined();
  });

  it('returns failure on vision timeout (fail-closed)', async () => {
    mockFetch.mockImplementation(
      () =>
        new Promise((_, reject) => {
          const err = new Error('aborted');
          err.name = 'AbortError';
          reject(err);
        }),
    );

    const result = await checkImagePii('/tmp/doc.jpg', 'img-1234.jpg', baseCfg);
    expect(result.items).toHaveLength(0);
    expect(result.failure).toBeDefined();
  });

  it('returns clean when image file cannot be read (not an Ollama failure)', async () => {
    vi.spyOn(fs, 'readFileSync').mockImplementation(() => {
      throw new Error('ENOENT');
    });

    const result = await checkImagePii(
      '/tmp/missing.jpg',
      'missing.jpg',
      baseCfg,
    );
    expect(result.items).toHaveLength(0);
    // File not found is not a check failure — the image simply doesn't exist
    expect(result.failure).toBeUndefined();
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

describe('substitutePdfContent', () => {
  it('replaces PDF reference with anonymized extracted text', async () => {
    mockGetText.mockResolvedValue({ text: 'Report about Olivia by Simon' });

    const prompt =
      'User sent:\n[PDF: attachments/report.pdf (50KB)]\nUse: pdf-reader extract attachments/report.pdf';
    const { prompt: result, failures } = await substitutePdfContent(
      prompt,
      groupDir,
      baseCfg,
    );

    expect(result).toContain('[PDF content from report.pdf]');
    expect(result).toContain('Report about Luna by Alex');
    expect(result).toContain('[End PDF content]');
    expect(result).not.toContain('pdf-reader');
    expect(failures).toHaveLength(0);
  });

  it('leaves prompt unchanged when no PDF references exist', async () => {
    const prompt = 'Hello Luna, how are you?';
    const { prompt: result, failures } = await substitutePdfContent(
      prompt,
      groupDir,
      baseCfg,
    );
    expect(result).toBe(prompt);
    expect(failures).toHaveLength(0);
    expect(mockGetText).not.toHaveBeenCalled();
  });

  it('strips PDF reference and reports failure when extraction fails', async () => {
    mockGetText.mockRejectedValue(new Error('corrupt'));

    const prompt =
      '[PDF: attachments/bad.pdf (10KB)]\nUse: pdf-reader extract attachments/bad.pdf';
    const { prompt: result, failures } = await substitutePdfContent(
      prompt,
      groupDir,
      baseCfg,
    );
    // Reference should be replaced with a withheld notice, not left as-is
    expect(result).toContain('content withheld');
    expect(result).not.toContain('pdf-reader');
    expect(failures).toHaveLength(1);
    expect(failures[0].filename).toBe('bad.pdf');
  });

  it('handles multiple PDF references', async () => {
    let callCount = 0;
    mockGetText.mockImplementation(async () => {
      callCount++;
      return {
        text: callCount === 1 ? 'First doc by Olivia' : 'Second doc by Simon',
      };
    });

    const prompt = [
      '[PDF: attachments/first.pdf (10KB)]',
      'Use: pdf-reader extract attachments/first.pdf',
      'Some text in between',
      '[PDF: attachments/second.pdf (20KB)]',
      'Use: pdf-reader extract attachments/second.pdf',
    ].join('\n');

    const { prompt: result } = await substitutePdfContent(
      prompt,
      groupDir,
      baseCfg,
    );
    expect(result).toContain('First doc by Luna');
    expect(result).toContain('Second doc by Alex');
    expect(result).toContain('Some text in between');
  });
});

describe('checkMediaPii', () => {
  it('checks both PDFs and images in messages', async () => {
    mockGetText.mockResolvedValue({ text: 'Report by Claire' });

    // Fetch calls: 1st PDF text PII, 2nd image vision extract, 3rd image text PII
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          response: JSON.stringify({
            found: [{ text: 'Claire', type: 'name' }],
          }),
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ response: 'Letter to Dr Patel' }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          response: JSON.stringify({
            found: [{ text: 'Dr Patel', type: 'name' }],
          }),
        }),
      });

    const messages = [
      {
        content:
          '[PDF: attachments/report.pdf (50KB)]\nUse: pdf-reader extract attachments/report.pdf',
      },
      { content: '[Image: attachments/img-1234.jpg] Photo of document' },
    ];

    const items = await checkMediaPii(messages, groupDir, baseCfg);
    expect(items).toHaveLength(2);
    expect(items[0].source).toBe('report.pdf');
    expect(items[1].source).toBe('img-1234.jpg');
  });

  it('returns empty when no media references in messages', async () => {
    const messages = [{ content: 'Just a text message' }];
    const items = await checkMediaPii(messages, groupDir, baseCfg);
    expect(items).toHaveLength(0);
  });
});

describe('warmupVisionModel', () => {
  it('sends warmup request to Ollama', () => {
    mockFetch.mockResolvedValue({ ok: true });

    warmupVisionModel(baseCfg);

    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('/api/generate'),
      expect.objectContaining({
        method: 'POST',
        body: expect.stringContaining('llava:7b'),
      }),
    );
  });

  it('does not warm up when mediaPiiCheck is false', () => {
    warmupVisionModel({ ...baseCfg, mediaPiiCheck: false, piiCheck: false });
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
