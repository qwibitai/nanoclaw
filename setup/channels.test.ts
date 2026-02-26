import { describe, it, expect } from 'vitest';

/**
 * Tests for the channels step.
 *
 * Verifies: --channels flag parsing, unknown channel detection,
 * .env ENABLED_CHANNELS update/append logic.
 */

const KNOWN_CHANNELS = ['whatsapp', 'telegram', 'slack', 'discord'];

function parseArgs(args: string[]): { channels: string[] } {
  let raw = '';
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--channels' && args[i + 1]) {
      raw = args[i + 1];
      i++;
    }
  }
  const channels = raw
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return { channels };
}

describe('channels flag parsing', () => {
  it('parses single channel', () => {
    const { channels } = parseArgs(['--channels', 'telegram']);
    expect(channels).toEqual(['telegram']);
  });

  it('parses comma-separated channels', () => {
    const { channels } = parseArgs(['--channels', 'whatsapp,telegram,slack']);
    expect(channels).toEqual(['whatsapp', 'telegram', 'slack']);
  });

  it('trims whitespace and lowercases', () => {
    const { channels } = parseArgs(['--channels', ' WhatsApp , Telegram ']);
    expect(channels).toEqual(['whatsapp', 'telegram']);
  });

  it('returns empty array when flag missing', () => {
    const { channels } = parseArgs(['--other', 'value']);
    expect(channels).toEqual([]);
  });

  it('returns empty array when flag has no value', () => {
    const { channels } = parseArgs(['--channels']);
    expect(channels).toEqual([]);
  });
});

describe('unknown channel detection', () => {
  it('identifies unknown channels', () => {
    const channels = ['whatsapp', 'signal', 'telegram'];
    const unknown = channels.filter((c) => !KNOWN_CHANNELS.includes(c));
    expect(unknown).toEqual(['signal']);
  });

  it('returns empty for all known channels', () => {
    const channels = ['whatsapp', 'telegram', 'slack', 'discord'];
    const unknown = channels.filter((c) => !KNOWN_CHANNELS.includes(c));
    expect(unknown).toEqual([]);
  });
});

describe('.env ENABLED_CHANNELS logic', () => {
  it('replaces existing ENABLED_CHANNELS line', () => {
    let envContent =
      'SOME_KEY=value\nENABLED_CHANNELS="whatsapp"\nOTHER=test';
    const value = 'whatsapp,telegram';

    envContent = envContent.replace(
      /^ENABLED_CHANNELS=.*$/m,
      `ENABLED_CHANNELS="${value}"`,
    );

    expect(envContent).toContain('ENABLED_CHANNELS="whatsapp,telegram"');
    expect(envContent).toContain('SOME_KEY=value');
    expect(envContent).toContain('OTHER=test');
    // Old value should be gone
    expect(envContent).not.toContain('ENABLED_CHANNELS="whatsapp"\n');
  });

  it('appends ENABLED_CHANNELS when not present', () => {
    let envContent = 'SOME_KEY=value\n';
    const value = 'telegram';

    if (!envContent.includes('ENABLED_CHANNELS=')) {
      envContent = envContent.trimEnd() + `\nENABLED_CHANNELS="${value}"\n`;
    }

    expect(envContent).toContain('ENABLED_CHANNELS="telegram"');
    expect(envContent).toContain('SOME_KEY=value');
  });

  it('handles empty .env', () => {
    let envContent = '';
    const value = 'slack,discord';

    if (envContent.includes('ENABLED_CHANNELS=')) {
      envContent = envContent.replace(
        /^ENABLED_CHANNELS=.*$/m,
        `ENABLED_CHANNELS="${value}"`,
      );
    } else {
      envContent = envContent.trimEnd() + `\nENABLED_CHANNELS="${value}"\n`;
    }

    expect(envContent).toContain('ENABLED_CHANNELS="slack,discord"');
  });
});
