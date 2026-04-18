import type { MessageMeta, MessageCategory } from './types.js';

interface CategoryFormat {
  icon: string;
  label: string;
}

const CATEGORY_FORMATS: Record<MessageCategory, CategoryFormat> = {
  financial: { icon: '💰', label: 'Financial' },
  security: { icon: '🛡', label: 'Security' },
  email: { icon: '📧', label: 'Email' },
  team: { icon: '👥', label: 'Team' },
  account: { icon: '⚙', label: 'Background' },
  'auto-handled': { icon: '✓', label: 'Auto-handled' },
};

const URGENCY_LABELS: Record<string, string> = {
  info: 'FYI',
  attention: 'needs attention',
  'action-required': 'needs confirmation',
  urgent: 'action plan ready',
};

/**
 * Format a message with categorical prefix for Telegram HTML.
 * Returns the formatted text — buttons are attached separately via sendMessageWithActions.
 */
export function formatWithMeta(text: string, meta: MessageMeta): string {
  const fmt = CATEGORY_FORMATS[meta.category];
  const urgencyLabel = URGENCY_LABELS[meta.urgency] || '';

  const header = `${fmt.icon} <b>${fmt.label}</b>${urgencyLabel ? ` · ${urgencyLabel}` : ''}`;

  // Auto-handled items get dimmed treatment
  if (meta.category === 'auto-handled') {
    return `${header}\n${text}`;
  }

  return `${header}\n\n${text}`;
}

/**
 * Format a batch of auto-handled items into a single collapsed message.
 */
export function formatBatch(items: string[]): string {
  const header = `✓ <b>Auto-handled</b> · ${items.length} items`;
  const body = items.map((item) => `• ${item}`).join('\n');
  return `${header}\n${body}`;
}
