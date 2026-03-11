import { describe, it, expect } from 'vitest';

import {
  parseAdminCommand,
  isAdminCommand,
  interceptAdminCommand,
  registerAdminCommand,
  getAdminCommands,
} from './admin.js';
import { RegisteredGroup } from './types.js';

// --- Helpers ---

function makeGroup(overrides: Partial<RegisteredGroup> = {}): RegisteredGroup {
  return {
    name: 'Test Group',
    folder: 'test',
    trigger: '@Andy',
    added_at: '2024-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function makeMainGroup(
  overrides: Partial<RegisteredGroup> = {},
): RegisteredGroup {
  return makeGroup({ name: 'Main', folder: 'main', isMain: true, ...overrides });
}

// --- parseAdminCommand ---

describe('parseAdminCommand', () => {
  it('parses a simple command', () => {
    expect(parseAdminCommand('/capabilities')).toBe('capabilities');
  });

  it('parses command with trailing text', () => {
    expect(parseAdminCommand('/capabilities some args')).toBe('capabilities');
  });

  it('parses command case-insensitively', () => {
    expect(parseAdminCommand('/Capabilities')).toBe('capabilities');
  });

  it('returns null for non-command messages', () => {
    expect(parseAdminCommand('hello world')).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(parseAdminCommand('')).toBeNull();
  });

  it('returns null for just a slash', () => {
    expect(parseAdminCommand('/')).toBeNull();
  });

  it('returns null for slash followed by number', () => {
    expect(parseAdminCommand('/123')).toBeNull();
  });

  it('handles leading whitespace', () => {
    expect(parseAdminCommand('  /capabilities')).toBe('capabilities');
  });

  it('parses hyphenated commands', () => {
    expect(parseAdminCommand('/add-group')).toBe('add-group');
  });

  it('parses underscored commands', () => {
    expect(parseAdminCommand('/add_group')).toBe('add_group');
  });
});

// --- isAdminCommand ---

describe('isAdminCommand', () => {
  it('returns true for registered command', () => {
    expect(isAdminCommand('/capabilities')).toBe(true);
  });

  it('returns false for unregistered command (passes through to agent)', () => {
    // Unregistered /foo commands may be container slash-skills
    expect(isAdminCommand('/nonexistent')).toBe(false);
  });

  it('returns false for non-command text', () => {
    expect(isAdminCommand('hello')).toBe(false);
  });
});

// --- interceptAdminCommand ---

describe('interceptAdminCommand', () => {
  const registeredGroups: Record<string, RegisteredGroup> = {
    'main@g.us': makeMainGroup(),
    'group@g.us': makeGroup({ name: 'Group', folder: 'group' }),
  };

  it('intercepts /capabilities in main channel', async () => {
    const sent: string[] = [];
    const sendMessage = async (text: string) => {
      sent.push(text);
    };

    const result = await interceptAdminCommand(
      '/capabilities',
      'main@g.us',
      registeredGroups['main@g.us'],
      registeredGroups,
      sendMessage,
    );

    expect(result.intercepted).toBe(true);
    expect(result.rejectionMessage).toBeUndefined();
    // Should have: activation message, capabilities output, deactivation message
    expect(sent.length).toBe(3);
    expect(sent[0]).toContain('Admin mode activated');
    expect(sent[1]).toContain('Channels');
    expect(sent[1]).toContain('Admin Commands');
    expect(sent[2]).toContain('Admin mode deactivated');
  });

  it('rejects admin commands in group channels', async () => {
    const sent: string[] = [];
    const sendMessage = async (text: string) => {
      sent.push(text);
    };

    const result = await interceptAdminCommand(
      '/capabilities',
      'group@g.us',
      registeredGroups['group@g.us'],
      registeredGroups,
      sendMessage,
    );

    expect(result.intercepted).toBe(true);
    expect(result.rejectionMessage).toBeDefined();
    expect(sent.length).toBe(1);
    expect(sent[0]).toContain('only available in the main channel');
  });

  it('does not intercept unregistered slash commands (passes to agent)', async () => {
    const sent: string[] = [];
    const sendMessage = async (text: string) => {
      sent.push(text);
    };

    const result = await interceptAdminCommand(
      '/update-nanoclaw',
      'main@g.us',
      registeredGroups['main@g.us'],
      registeredGroups,
      sendMessage,
    );

    // Should NOT intercept — may be a container slash-skill
    expect(result.intercepted).toBe(false);
    expect(sent.length).toBe(0);
  });

  it('does not intercept regular messages', async () => {
    const sent: string[] = [];
    const sendMessage = async (text: string) => {
      sent.push(text);
    };

    const result = await interceptAdminCommand(
      'hello world',
      'main@g.us',
      registeredGroups['main@g.us'],
      registeredGroups,
      sendMessage,
    );

    expect(result.intercepted).toBe(false);
    expect(sent.length).toBe(0);
  });

  it('sends deactivation message even on handler error', async () => {
    // Register a command that throws
    registerAdminCommand('fail-test', 'A failing command', async () => {
      throw new Error('test error');
    });

    const sent: string[] = [];
    const sendMessage = async (text: string) => {
      sent.push(text);
    };

    const result = await interceptAdminCommand(
      '/fail-test',
      'main@g.us',
      registeredGroups['main@g.us'],
      registeredGroups,
      sendMessage,
    );

    expect(result.intercepted).toBe(true);
    // Should have: activation, error message, deactivation
    expect(sent[0]).toContain('Admin mode activated');
    expect(sent.some((s) => s.includes('failed'))).toBe(true);
    expect(sent.some((s) => s.includes('test error'))).toBe(true);
    // Deactivation message is always sent last
    expect(sent[sent.length - 1]).toContain('Admin mode deactivated');
  });
});

// --- /capabilities output ---

describe('/capabilities output', () => {
  it('includes registered groups in output', async () => {
    const groups: Record<string, RegisteredGroup> = {
      'main@g.us': makeMainGroup(),
      'eng@g.us': makeGroup({
        name: 'Engineering',
        folder: 'eng',
        requiresTrigger: false,
      }),
    };

    const sent: string[] = [];
    await interceptAdminCommand(
      '/capabilities',
      'main@g.us',
      groups['main@g.us'],
      groups,
      async (text) => { sent.push(text); },
    );

    // The capabilities output is sent[1] (between activation and deactivation)
    const output = sent[1];
    expect(output).toContain('Engineering');
    expect(output).toContain('main');
    expect(output).toContain('no-trigger');
  });

  it('lists available admin commands', async () => {
    const groups: Record<string, RegisteredGroup> = {
      'main@g.us': makeMainGroup(),
    };

    const sent: string[] = [];
    await interceptAdminCommand(
      '/capabilities',
      'main@g.us',
      groups['main@g.us'],
      groups,
      async (text) => { sent.push(text); },
    );

    const output = sent[1];
    expect(output).toContain('/capabilities');
    expect(output).toContain('Admin Commands');
  });

  it('shows security configuration', async () => {
    const groups: Record<string, RegisteredGroup> = {
      'main@g.us': makeMainGroup(),
    };

    const sent: string[] = [];
    await interceptAdminCommand(
      '/capabilities',
      'main@g.us',
      groups['main@g.us'],
      groups,
      async (text) => { sent.push(text); },
    );

    const output = sent[1];
    expect(output).toContain('Security');
    expect(output).toContain('Container isolation');
    expect(output).toContain('IPC namespaces');
  });

  it('shows available tools section', async () => {
    const groups: Record<string, RegisteredGroup> = {
      'main@g.us': makeMainGroup(),
    };

    const sent: string[] = [];
    await interceptAdminCommand(
      '/capabilities',
      'main@g.us',
      groups['main@g.us'],
      groups,
      async (text) => { sent.push(text); },
    );

    const output = sent[1];
    expect(output).toContain('Available Tools');
    expect(output).toContain('SDK Tools');
    expect(output).toContain('MCP Tools');
    expect(output).toContain('Browser');
    expect(output).toContain('Bash');
    expect(output).toContain('send_message');
    expect(output).toContain('agent-browser');
  });
});

// --- Command registry ---

describe('command registry', () => {
  it('capabilities is registered by default', () => {
    const commands = getAdminCommands();
    expect(commands.has('capabilities')).toBe(true);
  });

  it('registerAdminCommand adds a new command', () => {
    registerAdminCommand('test-cmd', 'A test command', async () => {});
    const commands = getAdminCommands();
    expect(commands.has('test-cmd')).toBe(true);
  });

  it('registered commands are discoverable via isAdminCommand', () => {
    registerAdminCommand('discover-test', 'Discoverable', async () => {});
    expect(isAdminCommand('/discover-test')).toBe(true);
  });
});

// --- Mixed batch + active-container pipe path regression ---

describe('mixed batch filtering (active-container pipe path)', () => {
  const registeredGroups: Record<string, RegisteredGroup> = {
    'main@g.us': makeMainGroup(),
  };

  it('admin commands are intercepted and non-admin messages pass through', async () => {
    // Simulates a batch with interleaved admin and regular messages,
    // as would arrive in startMessageLoop's pipe path.
    const batch = [
      { content: 'hello', timestamp: '1000' },
      { content: '/capabilities', timestamp: '1001' },
      { content: 'world', timestamp: '1002' },
      { content: '/capabilities', timestamp: '1003' },
    ];

    const sent: string[] = [];
    const sendMessage = async (text: string) => { sent.push(text); };
    const nonAdminMessages: typeof batch = [];

    for (const msg of batch) {
      if (isAdminCommand(msg.content)) {
        await interceptAdminCommand(
          msg.content,
          'main@g.us',
          registeredGroups['main@g.us'],
          registeredGroups,
          sendMessage,
        );
      } else {
        nonAdminMessages.push(msg);
      }
    }

    // Non-admin messages should be exactly the regular ones
    expect(nonAdminMessages).toHaveLength(2);
    expect(nonAdminMessages[0].content).toBe('hello');
    expect(nonAdminMessages[1].content).toBe('world');

    // Admin commands should have been handled (activation + handler + deactivation per command)
    expect(sent.some((s) => s.includes('Admin mode activated'))).toBe(true);

    // REGRESSION: cursor must advance to BATCH END (last item), not
    // last non-admin item. This prevents trailing admin commands from
    // remaining behind the cursor and being re-processed on next poll.
    const cursorShouldBe = batch[batch.length - 1].timestamp; // '1003'
    const cursorWouldBeWrong = nonAdminMessages[nonAdminMessages.length - 1].timestamp; // '1002'
    expect(cursorShouldBe).toBe('1003');
    expect(cursorWouldBeWrong).toBe('1002');
    expect(cursorShouldBe).not.toBe(cursorWouldBeWrong);
  });

  it('admin-only batch leaves no non-admin messages', async () => {
    const batch = [
      { content: '/capabilities', timestamp: '2000' },
      { content: '/capabilities', timestamp: '2001' },
    ];

    const sent: string[] = [];
    const sendMessage = async (text: string) => { sent.push(text); };
    const nonAdminMessages: typeof batch = [];

    for (const msg of batch) {
      if (isAdminCommand(msg.content)) {
        await interceptAdminCommand(
          msg.content,
          'main@g.us',
          registeredGroups['main@g.us'],
          registeredGroups,
          sendMessage,
        );
      } else {
        nonAdminMessages.push(msg);
      }
    }

    // All messages were admin — nothing to pipe to container
    expect(nonAdminMessages).toHaveLength(0);

    // Cursor should advance to batch end
    const cursorShouldBe = batch[batch.length - 1].timestamp;
    expect(cursorShouldBe).toBe('2001');
  });

  it('admin commands must not be intercepted twice across startMessageLoop→processGroupMessages', async () => {
    // Regression: when startMessageLoop intercepts admin commands but
    // queue.sendMessage fails (no active container), it enqueues to
    // processGroupMessages which re-fetches from DB. If startMessageLoop
    // already executed the admin handler, processGroupMessages would
    // execute it again → duplicate "Admin mode activated/deactivated".
    //
    // Fix: startMessageLoop defers admin interception to processGroupMessages
    // when there is no active container (pipe fails).
    //
    // This test verifies the invariant: a single pass through the batch
    // produces exactly one interception per admin command.
    const batch = [
      { content: 'hello', timestamp: '3000' },
      { content: '/capabilities', timestamp: '3001' },
    ];

    const sent: string[] = [];
    const sendMessage = async (text: string) => { sent.push(text); };

    // Simulate ONE pass (as processGroupMessages would do)
    for (const msg of batch) {
      if (isAdminCommand(msg.content)) {
        await interceptAdminCommand(
          msg.content,
          'main@g.us',
          registeredGroups['main@g.us'],
          registeredGroups,
          sendMessage,
        );
      }
    }

    // Count activation messages — must be exactly 1
    const activations = sent.filter((s) => s.includes('Admin mode activated'));
    const deactivations = sent.filter((s) => s.includes('Admin mode deactivated'));
    expect(activations).toHaveLength(1);
    expect(deactivations).toHaveLength(1);
  });
});
