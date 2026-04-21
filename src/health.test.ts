// src/health.test.ts
import { describe, it, expect } from 'vitest';
import { HEALTH_SOCKET_PATH } from './config.js';

describe('HEALTH_SOCKET_PATH config', () => {
  it('is a string (empty when env var unset)', () => {
    expect(typeof HEALTH_SOCKET_PATH).toBe('string');
  });
});
