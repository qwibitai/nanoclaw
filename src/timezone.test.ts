import { describe, it, expect } from 'vitest';

import { formatLocalTime } from './timezone.js';

// --- formatLocalTime のテスト ---

describe('formatLocalTime', () => {
  it('UTC をローカル時刻表示に変換する', () => {
    // 2026-02-04T18:30:00Z は America/New_York (EST, UTC-5) で午後 1:30
    const result = formatLocalTime(
      '2026-02-04T18:30:00.000Z',
      'America/New_York',
    );
    expect(result).toContain('1:30');
    expect(result).toContain('PM');
    expect(result).toContain('Feb');
    expect(result).toContain('2026');
  });

  it('異なるタイムゾーンを処理する', () => {
    // 同じ UTC 時刻でも異なるローカル時刻を生成するべき
    const utc = '2026-06-15T12:00:00.000Z';
    const ny = formatLocalTime(utc, 'America/New_York');
    const tokyo = formatLocalTime(utc, 'Asia/Tokyo');
    // 夏の NY は UTC-4 (EDT)、Tokyo は UTC+9
    expect(ny).toContain('8:00');
    expect(tokyo).toContain('9:00');
  });
});
