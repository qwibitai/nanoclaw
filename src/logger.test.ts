import { describe, it, expect } from 'vitest';

import {
  generateCorrelationId,
  createCorrelationLogger,
} from './logger.js';

describe('logger correlation utilities', () => {
  it('generateCorrelationId returns a 12-char hex string', () => {
    const id = generateCorrelationId();
    expect(id).toMatch(/^[0-9a-f]{12}$/);
  });

  it('generateCorrelationId returns unique values', () => {
    const ids = new Set(Array.from({ length: 100 }, () => generateCorrelationId()));
    expect(ids.size).toBe(100);
  });

  it('createCorrelationLogger returns a pino logger with correlationId bound', () => {
    const log = createCorrelationLogger('abc123def456');
    const bindings = log.bindings();
    expect(bindings.correlationId).toBe('abc123def456');
  });

  it('createCorrelationLogger auto-generates correlationId when none provided', () => {
    const log = createCorrelationLogger();
    const bindings = log.bindings();
    expect(bindings.correlationId).toMatch(/^[0-9a-f]{12}$/);
  });

  it('createCorrelationLogger includes additional context in bindings', () => {
    const log = createCorrelationLogger('abc123def456', {
      group: 'test-group',
      op: 'container-spawn',
    });
    const bindings = log.bindings();
    expect(bindings.correlationId).toBe('abc123def456');
    expect(bindings.group).toBe('test-group');
    expect(bindings.op).toBe('container-spawn');
  });
});
