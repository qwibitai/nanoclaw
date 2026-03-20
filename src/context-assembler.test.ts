import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'fs';
import { assembleContextPacket } from './context-assembler.js';
import { getRecentMessages, getAllTasks } from './db.js';

vi.mock('fs', () => ({
  default: {
    existsSync: vi.fn(() => false),
    readFileSync: vi.fn(() => ''),
    mkdirSync: vi.fn(),
    writeFileSync: vi.fn(),
  },
}));

vi.mock('./db.js', () => ({
  getRecentMessages: vi.fn(() => []),
  getAllTasks: vi.fn(() => []),
}));

describe('assembleContextPacket', () => {
  beforeEach(() => vi.clearAllMocks());

  it('includes current date and timezone', () => {
    const packet = assembleContextPacket('main', true);
    expect(packet).toContain('Current date:');
    expect(packet).toContain('Timezone:');
  });

  it('includes recent messages when available', () => {
    vi.mocked(getRecentMessages).mockReturnValue([
      { sender: 'user1', content: 'hello world', timestamp: '2026-03-20T10:00:00Z' },
    ]);
    const packet = assembleContextPacket('main', true);
    expect(packet).toContain('Recent messages');
    expect(packet).toContain('hello world');
  });

  it('includes active scheduled tasks', () => {
    vi.mocked(getAllTasks).mockReturnValue([
      {
        id: 'task-1', prompt: 'Morning briefing', schedule_type: 'cron',
        schedule_value: '0 7 * * 1-5', status: 'active', group_folder: 'main',
        chat_jid: 'tg:123', context_mode: 'group', next_run: null,
        last_run: null, last_result: null, created_at: '2026-03-20',
      },
    ]);
    const packet = assembleContextPacket('main', true);
    expect(packet).toContain('Scheduled tasks');
    expect(packet).toContain('Morning briefing');
  });

  it('reads group memory.md if it exists', () => {
    vi.mocked(fs.existsSync).mockImplementation(
      (p) => typeof p === 'string' && p.includes('memory.md'),
    );
    vi.mocked(fs.readFileSync).mockReturnValue('# Team Memory\n- Einstein: researcher');
    const packet = assembleContextPacket('telegram_science-claw', false);
    expect(packet).toContain('Einstein');
  });

  it('reads current.md for priorities', () => {
    vi.mocked(fs.existsSync).mockImplementation(
      (p) => typeof p === 'string' && p.includes('current.md'),
    );
    vi.mocked(fs.readFileSync).mockReturnValue('## Top 3\n1) Grant deadline Friday');
    const packet = assembleContextPacket('main', true);
    expect(packet).toContain('Grant deadline');
  });

  it('truncates to max size', () => {
    vi.mocked(getRecentMessages).mockReturnValue(
      Array.from({ length: 200 }, (_, i) => ({
        sender: 'user', content: 'x'.repeat(100), timestamp: '2026-03-20T10:00:00Z',
      })),
    );
    const packet = assembleContextPacket('main', true);
    expect(packet.length).toBeLessThanOrEqual(8200);
  });
});
