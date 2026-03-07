import { describe, expect, it, vi } from 'vitest';

import { WhatsAppChannel } from '../channels/whatsapp.js';
import { WhatsAppProvider } from './whatsapp.js';

describe('WhatsApp provider adapter', () => {
  it('exposes channel as a provider-backed implementation', () => {
    const channel = new WhatsAppChannel({
      onMessage: vi.fn(),
      onChatMetadata: vi.fn(),
      registeredGroups: vi.fn(() => ({})),
    });

    expect(channel).toBeInstanceOf(WhatsAppProvider);
  });
});
