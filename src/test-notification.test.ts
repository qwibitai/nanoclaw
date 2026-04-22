import { describe, expect, it } from 'vitest';

import {
  buildMessage,
  parseArgs,
  VALID_TYPES,
  type NotificationType,
} from './test-notification.js';

describe('test-notification', () => {
  // --- VALID_TYPES ---

  describe('VALID_TYPES', () => {
    it('includes the three required event types', () => {
      expect(VALID_TYPES).toContain('task-complete');
      expect(VALID_TYPES).toContain('sprint-complete');
      expect(VALID_TYPES).toContain('custom');
      expect(VALID_TYPES).toHaveLength(3);
    });
  });

  // --- buildMessage ---

  describe('buildMessage', () => {
    it('produces a [TEST]-prefixed task-complete message', () => {
      const msg = buildMessage('task-complete');
      expect(msg).toMatch(/^\[TEST\]/);
      expect(msg).toContain('Task completed');
    });

    it('produces a [TEST]-prefixed sprint-complete message', () => {
      const msg = buildMessage('sprint-complete');
      expect(msg).toMatch(/^\[TEST\]/);
      expect(msg).toContain('Sprint completed');
    });

    it('produces a [TEST]-prefixed custom message', () => {
      const msg = buildMessage('custom', 'Hello from tests');
      expect(msg).toBe('[TEST] Hello from tests');
    });

    it('includes [TEST] prefix for every valid type', () => {
      for (const type of VALID_TYPES) {
        const msg = buildMessage(
          type as NotificationType,
          type === 'custom' ? 'test payload' : undefined,
        );
        expect(msg).toMatch(/^\[TEST\]/);
      }
    });
  });

  // --- parseArgs ---

  describe('parseArgs', () => {
    it('shows help when no arguments provided', () => {
      const result = parseArgs(['node', 'script']);
      expect(result.showHelp).toBe(true);
    });

    it('shows help with --help flag', () => {
      const result = parseArgs(['node', 'script', '--help']);
      expect(result.showHelp).toBe(true);
    });

    it('shows help with -h flag', () => {
      const result = parseArgs(['node', 'script', '-h']);
      expect(result.showHelp).toBe(true);
    });

    it('parses task-complete type', () => {
      const result = parseArgs(['node', 'script', 'task-complete']);
      expect(result.type).toBe('task-complete');
      expect(result.showHelp).toBe(false);
      expect(result.customMessage).toBeUndefined();
      expect(result.chatIdOverride).toBeNull();
    });

    it('parses sprint-complete type', () => {
      const result = parseArgs(['node', 'script', 'sprint-complete']);
      expect(result.type).toBe('sprint-complete');
    });

    it('parses custom type with message', () => {
      const result = parseArgs(['node', 'script', 'custom', 'Hello', 'World']);
      expect(result.type).toBe('custom');
      expect(result.customMessage).toBe('Hello World');
    });

    it('parses --chat-id override', () => {
      const result = parseArgs([
        'node',
        'script',
        'task-complete',
        '--chat-id',
        '12345',
      ]);
      expect(result.type).toBe('task-complete');
      expect(result.chatIdOverride).toBe('12345');
    });

    it('parses --chat-id with custom message', () => {
      const result = parseArgs([
        'node',
        'script',
        'custom',
        '--chat-id',
        '12345',
        'My test message',
      ]);
      expect(result.type).toBe('custom');
      expect(result.chatIdOverride).toBe('12345');
      expect(result.customMessage).toBe('My test message');
    });

    it('handles --chat-id before message args', () => {
      const result = parseArgs([
        'node',
        'script',
        'custom',
        '--chat-id',
        '99',
        'msg',
        'text',
      ]);
      expect(result.chatIdOverride).toBe('99');
      expect(result.customMessage).toBe('msg text');
    });
  });
});
