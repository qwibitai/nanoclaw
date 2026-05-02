import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getTelemetryConfig, getTelemetryConfigOptional } from './telemetry-config.js';

describe('Telemetry Config', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('returns url and token when both env vars are set', () => {
    process.env.TELEMETRY_API_URL = 'https://telemetry.example.com';
    process.env.TELEMETRY_REGISTRATION_TOKEN = 'test-token-123';

    const config = getTelemetryConfig();
    expect(config.telemetryUrl).toBe('https://telemetry.example.com');
    expect(config.token).toBe('test-token-123');
  });

  it('strips trailing slash from URL', () => {
    process.env.TELEMETRY_API_URL = 'https://telemetry.example.com/';
    process.env.TELEMETRY_REGISTRATION_TOKEN = 'test-token-123';

    const config = getTelemetryConfig();
    expect(config.telemetryUrl).toBe('https://telemetry.example.com');
  });

  it('throws when TELEMETRY_API_URL is missing', () => {
    delete process.env.TELEMETRY_API_URL;
    process.env.TELEMETRY_REGISTRATION_TOKEN = 'test-token-123';

    expect(() => getTelemetryConfig()).toThrow('Missing env vars');
  });

  it('throws when TELEMETRY_REGISTRATION_TOKEN is missing', () => {
    process.env.TELEMETRY_API_URL = 'https://telemetry.example.com';
    delete process.env.TELEMETRY_REGISTRATION_TOKEN;

    expect(() => getTelemetryConfig()).toThrow('Missing env vars');
  });

  it('returns null from optional getter when vars are missing', () => {
    delete process.env.TELEMETRY_API_URL;
    delete process.env.TELEMETRY_REGISTRATION_TOKEN;

    const config = getTelemetryConfigOptional();
    expect(config).toBeNull();
  });
});
