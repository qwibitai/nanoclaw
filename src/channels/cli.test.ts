import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getChannelFactory, getRegisteredChannelNames } from './registry.js';

// Import triggers self-registration
import './cli.js';

describe('CLI channel', () => {
  const mockOpts = {
    onMessage: vi.fn(),
    onChatMetadata: vi.fn(),
    registeredGroups: () => ({
      'cli:main': {
        name: 'Main CLI',
        folder: 'main',
        trigger: '@Andy',
        added_at: new Date().toISOString(),
        isMain: true,
      },
    }),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('self-registers as cli in the registry', () => {
    expect(getRegisteredChannelNames()).toContain('cli');
  });

  it('factory always returns an instance (never null)', () => {
    const factory = getChannelFactory('cli');
    expect(factory).toBeDefined();
    const channel = factory!(mockOpts);
    expect(channel).not.toBeNull();
    expect(channel!.name).toBe('cli');
  });

  it('ownsJid returns true for cli: JIDs', () => {
    const channel = getChannelFactory('cli')!(mockOpts)!;
    expect(channel.ownsJid('cli:main')).toBe(true);
    expect(channel.ownsJid('cli:anything')).toBe(true);
  });

  it('ownsJid returns false for non-cli JIDs', () => {
    const channel = getChannelFactory('cli')!(mockOpts)!;
    expect(channel.ownsJid('dc:12345')).toBe(false);
    expect(channel.ownsJid('120363@g.us')).toBe(false);
  });

  it('sendMessage writes to stdout', async () => {
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const channel = getChannelFactory('cli')!(mockOpts)!;
    await channel.sendMessage('cli:main', 'Hello from the agent');
    expect(writeSpy).toHaveBeenCalled();
    const output = writeSpy.mock.calls.map((c) => c[0]).join('');
    expect(output).toContain('Hello from the agent');
    writeSpy.mockRestore();
  });

  it('sendMessage strips internal tags', async () => {
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const channel = getChannelFactory('cli')!(mockOpts)!;
    await channel.sendMessage('cli:main', '<internal>thinking</internal>Visible response');
    const output = writeSpy.mock.calls.map((c) => c[0]).join('');
    expect(output).toContain('Visible response');
    expect(output).not.toContain('thinking');
    writeSpy.mockRestore();
  });

  it('sendMessage does nothing for internal-only messages', async () => {
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const channel = getChannelFactory('cli')!(mockOpts)!;
    await channel.sendMessage('cli:main', '<internal>only internal</internal>');
    expect(writeSpy).not.toHaveBeenCalled();
    writeSpy.mockRestore();
  });
});
