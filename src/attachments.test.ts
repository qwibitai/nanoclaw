import { describe, it, expect } from 'vitest';

import { classifyMode, detectMimeType } from './attachments.js';

describe('detectMimeType', () => {
  it('detects JPEG from magic bytes', () => {
    const buf = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
    expect(detectMimeType(buf)).toBe('image/jpeg');
  });

  it('detects PNG from magic bytes', () => {
    const buf = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]);
    expect(detectMimeType(buf)).toBe('image/png');
  });

  it('detects GIF from magic bytes', () => {
    const buf = Buffer.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]);
    expect(detectMimeType(buf)).toBe('image/gif');
  });

  it('detects PDF from magic bytes', () => {
    const buf = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31]);
    expect(detectMimeType(buf)).toBe('application/pdf');
  });

  it('detects WebP from magic bytes at offset 8', () => {
    // RIFF....WEBP
    const buf = Buffer.alloc(16);
    buf.write('RIFF', 0);
    buf.write('WEBP', 8);
    expect(detectMimeType(buf)).toBe('image/webp');
  });

  it('detects ZIP from magic bytes', () => {
    const buf = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
    expect(detectMimeType(buf)).toBe('application/zip');
  });

  it('falls back to extension mapping for unknown magic bytes', () => {
    const buf = Buffer.from([0x00, 0x01, 0x02, 0x03]);
    expect(detectMimeType(buf, 'report.xlsx')).toBe(
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
  });

  it('detects text files by content + extension', () => {
    const buf = Buffer.from('Hello, world! This is plain text.');
    expect(detectMimeType(buf, 'notes.txt')).toBe('text/plain');
  });

  it('detects CSV text files', () => {
    const buf = Buffer.from('name,age\nAlice,30\nBob,25');
    expect(detectMimeType(buf, 'data.csv')).toBe('text/csv');
  });

  it('returns octet-stream for unknown content and no extension', () => {
    const buf = Buffer.from([0x00, 0x01, 0x02, 0x03]);
    expect(detectMimeType(buf)).toBe('application/octet-stream');
  });

  it('returns octet-stream for unknown extension with binary content', () => {
    const buf = Buffer.from([0x00, 0x01, 0x02, 0x03]);
    expect(detectMimeType(buf, 'data.xyz')).toBe('application/octet-stream');
  });

  it('prioritizes magic bytes over extension', () => {
    // PNG magic bytes but .jpg extension — magic bytes win
    const buf = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]);
    expect(detectMimeType(buf, 'photo.jpg')).toBe('image/png');
  });
});

describe('classifyMode', () => {
  it('classifies images as inline', () => {
    expect(classifyMode('image/jpeg')).toBe('inline');
    expect(classifyMode('image/png')).toBe('inline');
    expect(classifyMode('image/gif')).toBe('inline');
    expect(classifyMode('image/webp')).toBe('inline');
  });

  it('classifies PDF as inline', () => {
    expect(classifyMode('application/pdf')).toBe('inline');
  });

  it('classifies plain text as inline', () => {
    expect(classifyMode('text/plain')).toBe('inline');
  });

  it('classifies office docs as file', () => {
    expect(classifyMode('application/zip')).toBe('file');
    expect(
      classifyMode(
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      ),
    ).toBe('file');
  });

  it('classifies unknown types as file', () => {
    expect(classifyMode('application/octet-stream')).toBe('file');
  });
});
