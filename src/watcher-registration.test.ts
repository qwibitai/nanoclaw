import { describe, it, expect, beforeEach } from 'vitest';

import { _initTestDatabase, getTaskById } from './db.js';
import { ensureWatcherTasks } from './watcher-registration.js';

describe('ensureWatcherTasks', () => {
  beforeEach(() => {
    _initTestDatabase();
  });

  it('registers the cross-channel-digest task', () => {
    ensureWatcherTasks();
    const task = getTaskById('cross-channel-digest');
    expect(task).toBeDefined();
    expect(task!.group_folder).toBe('main');
    expect(task!.chat_jid).toBe('slack:D0AM0RZ7HB2');
    expect(task!.schedule_type).toBe('interval');
    expect(task!.schedule_value).toBe('600000');
    expect(task!.context_mode).toBe('isolated');
    expect(task!.status).toBe('active');
  });

  it('cross-channel-digest prompt calls read_own_conversations', () => {
    ensureWatcherTasks();
    const task = getTaskById('cross-channel-digest');
    expect(task).toBeDefined();
    expect(task!.prompt).toContain('read_own_conversations');
    expect(task!.prompt).toContain('lines');
  });

  it('cross-channel-digest prompt includes channel mapping', () => {
    ensureWatcherTasks();
    const task = getTaskById('cross-channel-digest');
    expect(task).toBeDefined();
    expect(task!.prompt).toContain('main');
    expect(task!.prompt).toContain('Slack');
    expect(task!.prompt).toContain('telegram_tomer-dm');
    expect(task!.prompt).toContain('Telegram');
    expect(task!.prompt).toContain('slack_group');
    expect(task!.prompt).toContain('#the-bots-place');
  });

  it('cross-channel-digest prompt includes <internal> suppression', () => {
    ensureWatcherTasks();
    const task = getTaskById('cross-channel-digest');
    expect(task).toBeDefined();
    expect(task!.prompt).toContain('<internal>');
  });

  it('cross-channel-digest prompt instructs writing to CLAUDE.md', () => {
    ensureWatcherTasks();
    const task = getTaskById('cross-channel-digest');
    expect(task).toBeDefined();
    expect(task!.prompt).toContain('/workspace/extra/cross-channel/CLAUDE.md');
  });

  it('is idempotent — does not create duplicate tasks', () => {
    ensureWatcherTasks();
    ensureWatcherTasks(); // second call
    const task = getTaskById('cross-channel-digest');
    expect(task).toBeDefined(); // still exists, no error thrown
  });
});
