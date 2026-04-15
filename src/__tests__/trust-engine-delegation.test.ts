import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));
vi.mock('../event-bus.js', () => ({
  eventBus: { emit: vi.fn() },
}));

import { _initTestDatabase, _closeDatabase } from '../db.js';
import { classifyTool, parseActionClass } from '../trust-engine.js';

describe('delegation tool classification', () => {
  beforeEach(() => _initTestDatabase());
  afterEach(() => _closeDatabase());

  it('maps handle_email_reply to comms.write', () => {
    expect(classifyTool('handle_email_reply')).toBe('comms.write');
  });

  it('maps handle_email_send to comms.transact', () => {
    expect(classifyTool('handle_email_send')).toBe('comms.transact');
  });

  it('maps handle_calendar_accept to services.write', () => {
    expect(classifyTool('handle_calendar_accept')).toBe('services.write');
  });

  it('maps handle_calendar_decline to services.write', () => {
    expect(classifyTool('handle_calendar_decline')).toBe('services.write');
  });

  it('maps handle_archive to comms.read', () => {
    expect(classifyTool('handle_archive')).toBe('comms.read');
  });

  it('maps handle_label to comms.write', () => {
    expect(classifyTool('handle_label')).toBe('comms.write');
  });

  it('maps handle_snooze to services.write', () => {
    expect(classifyTool('handle_snooze')).toBe('services.write');
  });

  it('parses delegation action classes correctly', () => {
    const { domain, operation } = parseActionClass('comms.write');
    expect(domain).toBe('comms');
    expect(operation).toBe('write');
  });
});
