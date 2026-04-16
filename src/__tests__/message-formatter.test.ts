import { describe, it, expect } from 'vitest';
import { formatWithMeta } from '../message-formatter.js';
import type { MessageMeta } from '../types.js';

describe('formatWithMeta', () => {
  it('formats financial message with green prefix', () => {
    const meta: MessageMeta = {
      category: 'financial',
      urgency: 'action-required',
      actions: [],
      batchable: false,
    };
    const result = formatWithMeta('2 incoming wires. Total: $54,900.', meta);
    expect(result).toContain('💰');
    expect(result).toContain('Financial');
    expect(result).toContain('2 incoming wires');
  });

  it('formats security message with shield prefix', () => {
    const meta: MessageMeta = {
      category: 'security',
      urgency: 'urgent',
      actions: [],
      batchable: false,
    };
    const result = formatWithMeta('Spamhaus listing detected', meta);
    expect(result).toContain('🛡');
    expect(result).toContain('Security');
  });

  it('formats auto-handled message dimmed', () => {
    const meta: MessageMeta = {
      category: 'auto-handled',
      urgency: 'info',
      actions: [],
      batchable: true,
    };
    const result = formatWithMeta('Newsletter dismissed', meta);
    expect(result).toContain('✓');
    expect(result).toContain('Auto-handled');
  });

  it('formats team message with team prefix', () => {
    const meta: MessageMeta = {
      category: 'team',
      urgency: 'info',
      actions: [],
      batchable: true,
    };
    const result = formatWithMeta('Dmitrii acknowledged request', meta);
    expect(result).toContain('👥');
    expect(result).toContain('Team');
  });

  it('formats email message with envelope prefix', () => {
    const meta: MessageMeta = {
      category: 'email',
      urgency: 'attention',
      actions: [],
      batchable: false,
    };
    const result = formatWithMeta('Draft enriched for David', meta);
    expect(result).toContain('📧');
    expect(result).toContain('Email');
  });

  it('formats batch of auto-handled items', () => {
    const items = ['Newsletter A dismissed', 'Receipt B processed', 'Promo C ignored'];
    const result = formatWithMeta(items.join('\n'), {
      category: 'auto-handled',
      urgency: 'info',
      actions: [],
      batchable: true,
    });
    expect(result).toContain('Auto-handled');
  });
});
