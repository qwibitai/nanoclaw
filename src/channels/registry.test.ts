import { describe, it, expect, beforeEach } from 'vitest';

import {
  registerChannel,
  getChannelFactory,
  getRegisteredChannelNames,
} from './registry.js';

// The registry is module-level state, so we need a fresh module per test.
// We use dynamic import with cache-busting to isolate tests.
// However, since vitest runs each file in its own context and we control
// registration order, we can test the public API directly.

describe('channel registry', () => {
  // Note: registry is shared module state across tests in this file.
  // Tests are ordered to account for cumulative registrations.

  it('getChannelFactory returns undefined for unknown channel', () => {
    expect(getChannelFactory('nonexistent')).toBeUndefined();
  });

  it('registerChannel and getChannelFactory round-trip', () => {
    const factory = () => null;
    registerChannel('test-channel', factory);
    expect(getChannelFactory('test-channel')).toBe(factory);
  });

  it('getRegisteredChannelNames includes registered channels', () => {
    registerChannel('another-channel', () => null);
    const names = getRegisteredChannelNames();
    expect(names).toContain('test-channel');
    expect(names).toContain('another-channel');
  });

  it('later registration overwrites earlier one', () => {
    const factory1 = () => null;
    const factory2 = () => null;
    registerChannel('overwrite-test', factory1);
    registerChannel('overwrite-test', factory2);
    expect(getChannelFactory('overwrite-test')).toBe(factory2);
  });

  it('ChannelOpts accepts optional download tracking callbacks', () => {
    // Verify the factory typechecks with download callbacks
    const factory = (opts: import('./registry.js').ChannelOpts) => {
      opts.onDownloadStart?.('chat1', 'dl-1');
      opts.onDownloadComplete?.('chat1', 'dl-1');
      return null;
    };
    registerChannel('download-test', factory);

    const retrieved = getChannelFactory('download-test')!;
    // Calling without callbacks should not throw
    expect(() =>
      retrieved({
        onMessage: () => {},
        onChatMetadata: () => {},
        registeredGroups: () => ({}),
      }),
    ).not.toThrow();
  });
});
