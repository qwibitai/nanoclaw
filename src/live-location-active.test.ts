import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  _setActiveLiveLocationManager,
  getActiveLiveLocationContext,
} from './live-location.js';
import { installLlFsSpies, makeManager } from './live-location-test-harness.js';

beforeEach(() => {
  vi.useFakeTimers();
  installLlFsSpies();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  _setActiveLiveLocationManager(null);
});

describe('_setActiveLiveLocationManager / getActiveLiveLocationContext', () => {
  it('returns empty string before manager is set', () => {
    expect(getActiveLiveLocationContext('tg:1')).toBe('');
  });

  it('returns prefix string when manager has active session', () => {
    const manager = makeManager();
    manager.startSession('tg:1', 1, 35.6762, 139.6503, 600);
    _setActiveLiveLocationManager(manager);

    const ctx = getActiveLiveLocationContext('tg:1');
    expect(ctx).toContain('[Live location sharing enabled]');
    expect(ctx).toContain('lat: 35.6762');
    expect(ctx).toContain('long: 139.6503');
    expect(ctx).toContain('tail');
    expect(ctx.endsWith('\n')).toBe(true);
  });

  it('returns empty string for unknown chatJid even when manager is set', () => {
    const manager = makeManager();
    _setActiveLiveLocationManager(manager);
    expect(getActiveLiveLocationContext('tg:unknown')).toBe('');
  });

  it('returns empty string after manager is set to null', () => {
    const manager = makeManager();
    manager.startSession('tg:1', 1, 35, 139, 600);
    _setActiveLiveLocationManager(manager);
    expect(getActiveLiveLocationContext('tg:1')).not.toBe('');

    _setActiveLiveLocationManager(null);
    expect(getActiveLiveLocationContext('tg:1')).toBe('');
  });
});
