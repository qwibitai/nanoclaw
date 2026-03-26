import { describe, it, expect, vi } from 'vitest';
import { DiscoveryEmitter } from './discovery.js';

describe('DiscoveryEmitter', () => {
  it('first discovery returns true and emits event', () => {
    const emit = vi.fn();
    const emitter = new DiscoveryEmitter(emit);

    const result = emitter.onUnregisteredMessage(
      'new-group@g.us',
      'New Group',
      'whatsapp',
      'group',
    );

    expect(result).toBe(true);
    expect(emit).toHaveBeenCalledOnce();
    expect(emit).toHaveBeenCalledWith('groups.discovered', {
      chatJid: 'new-group@g.us',
      name: 'New Group',
      channel: 'whatsapp',
      chatType: 'group',
    });
  });

  it('repeat discovery returns false and does NOT emit', () => {
    const emit = vi.fn();
    const emitter = new DiscoveryEmitter(emit);

    emitter.onUnregisteredMessage('group@g.us', 'Group', 'whatsapp', 'group');
    emit.mockClear();

    const result = emitter.onUnregisteredMessage(
      'group@g.us',
      'Group',
      'whatsapp',
      'group',
    );

    expect(result).toBe(false);
    expect(emit).not.toHaveBeenCalled();
  });

  it('different JIDs each emit independently', () => {
    const emit = vi.fn();
    const emitter = new DiscoveryEmitter(emit);

    const r1 = emitter.onUnregisteredMessage(
      'group-a@g.us',
      'Group A',
      'whatsapp',
      'group',
    );
    const r2 = emitter.onUnregisteredMessage(
      'group-b@g.us',
      'Group B',
      'telegram',
      'group',
    );

    expect(r1).toBe(true);
    expect(r2).toBe(true);
    expect(emit).toHaveBeenCalledTimes(2);
    expect(emit).toHaveBeenCalledWith('groups.discovered', {
      chatJid: 'group-a@g.us',
      name: 'Group A',
      channel: 'whatsapp',
      chatType: 'group',
    });
    expect(emit).toHaveBeenCalledWith('groups.discovered', {
      chatJid: 'group-b@g.us',
      name: 'Group B',
      channel: 'telegram',
      chatType: 'group',
    });
  });
});
