import { describe, it, expect } from 'vitest';
import {
  ASSISTANT_NAME,
  POLL_INTERVAL,
  SCHEDULER_POLL_INTERVAL,
  TRIGGER_PATTERN,
  WHATSAPP_ENABLED,
  TELEGRAM_ENABLED,
  DISCORD_ENABLED,
  MAX_CONCURRENT_CONTAINERS,
  CONTAINER_TIMEOUT,
  CONTAINER_IMAGE,
  CONTAINER_RUNTIME,
  GATEWAY_PORT,
  IPC_POLL_INTERVAL,
  STORE_DIR,
  GROUPS_DIR,
  DATA_DIR,
  MAIN_GROUP_FOLDER,
} from '../src/config.js';

describe('Config defaults', () => {
  it('ASSISTANT_NAME defaults to "Andy"', () => {
    // Unless ASSISTANT_NAME env var is set, should be "Andy"
    expect(ASSISTANT_NAME).toBe(process.env.ASSISTANT_NAME || 'Andy');
  });

  it('POLL_INTERVAL is 2000ms', () => {
    expect(POLL_INTERVAL).toBe(2000);
  });

  it('SCHEDULER_POLL_INTERVAL is 60000ms', () => {
    expect(SCHEDULER_POLL_INTERVAL).toBe(60000);
  });

  it('IPC_POLL_INTERVAL is 1000ms', () => {
    expect(IPC_POLL_INTERVAL).toBe(1000);
  });

  it('CONTAINER_RUNTIME defaults to "docker"', () => {
    expect(CONTAINER_RUNTIME).toBe(process.env.CONTAINER_RUNTIME || 'docker');
  });

  it('CONTAINER_IMAGE defaults to "nanoclaw-agent:latest"', () => {
    expect(CONTAINER_IMAGE).toBe(
      process.env.CONTAINER_IMAGE || 'nanoclaw-agent:latest',
    );
  });

  it('CONTAINER_TIMEOUT defaults to 300000', () => {
    expect(CONTAINER_TIMEOUT).toBe(300000);
  });

  it('GATEWAY_PORT defaults to 18790', () => {
    expect(GATEWAY_PORT).toBe(18790);
  });

  it('MAIN_GROUP_FOLDER is "main"', () => {
    expect(MAIN_GROUP_FOLDER).toBe('main');
  });

  it('path constants are absolute paths', () => {
    expect(STORE_DIR).toMatch(/^\//);
    expect(GROUPS_DIR).toMatch(/^\//);
    expect(DATA_DIR).toMatch(/^\//);
  });
});

describe('TRIGGER_PATTERN', () => {
  it('matches "@Andy hello" at start of string', () => {
    expect(TRIGGER_PATTERN.test('@Andy hello')).toBe(true);
  });

  it('matches "@Andy" alone', () => {
    expect(TRIGGER_PATTERN.test('@Andy')).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(TRIGGER_PATTERN.test('@andy hello')).toBe(true);
    expect(TRIGGER_PATTERN.test('@ANDY hello')).toBe(true);
    expect(TRIGGER_PATTERN.test('@aNdY something')).toBe(true);
  });

  it('does NOT match "@Andy" in the middle of a string (requires ^)', () => {
    expect(TRIGGER_PATTERN.test('hello @Andy')).toBe(false);
    expect(TRIGGER_PATTERN.test('hey @Andy what')).toBe(false);
  });

  it('does NOT match partial name like "@Andrew"', () => {
    // The \\b word boundary ensures "Andy" is a full word
    expect(TRIGGER_PATTERN.test('@Andrew hello')).toBe(false);
  });

  it('does NOT match without the @ prefix', () => {
    expect(TRIGGER_PATTERN.test('Andy hello')).toBe(false);
  });

  it('matches "@Andy," with punctuation after name (word boundary)', () => {
    expect(TRIGGER_PATTERN.test('@Andy, how are you?')).toBe(true);
  });
});

describe('Channel config defaults', () => {
  it('WHATSAPP_ENABLED defaults to true', () => {
    // Default: true unless WHATSAPP_ENABLED is explicitly 'false'
    if (process.env.WHATSAPP_ENABLED === 'false') {
      expect(WHATSAPP_ENABLED).toBe(false);
    } else {
      expect(WHATSAPP_ENABLED).toBe(true);
    }
  });

  it('TELEGRAM_ENABLED defaults to false', () => {
    // Default: false unless TELEGRAM_ENABLED is explicitly 'true'
    if (process.env.TELEGRAM_ENABLED === 'true') {
      expect(TELEGRAM_ENABLED).toBe(true);
    } else {
      expect(TELEGRAM_ENABLED).toBe(false);
    }
  });

  it('DISCORD_ENABLED defaults to false', () => {
    if (process.env.DISCORD_ENABLED === 'true') {
      expect(DISCORD_ENABLED).toBe(true);
    } else {
      expect(DISCORD_ENABLED).toBe(false);
    }
  });
});

describe('MAX_CONCURRENT_CONTAINERS', () => {
  it('defaults to 5', () => {
    expect(MAX_CONCURRENT_CONTAINERS).toBe(5);
  });

  it('has a minimum value of 1 (enforced by Math.max)', () => {
    // The source uses Math.max(1, ...) so the value is always >= 1
    expect(MAX_CONCURRENT_CONTAINERS).toBeGreaterThanOrEqual(1);
  });
});
