import { describe, it, expect, beforeEach } from 'vitest';

import {
  registerPlugin,
  getRegisteredPlugins,
  getPluginContainerEnvKeys,
  getPluginContainerEnv,
  _resetForTesting,
} from './registry.js';

beforeEach(() => {
  _resetForTesting();
});

describe('registerPlugin / getRegisteredPlugins', () => {
  it('starts empty', () => {
    expect(getRegisteredPlugins()).toEqual([]);
  });

  it('registers a plugin by name', () => {
    registerPlugin({ name: 'foo' });
    expect(getRegisteredPlugins().map((p) => p.name)).toEqual(['foo']);
  });

  it('registers multiple plugins in order', () => {
    registerPlugin({ name: 'alpha' });
    registerPlugin({ name: 'beta' });
    expect(getRegisteredPlugins().map((p) => p.name)).toEqual(['alpha', 'beta']);
  });

  it('returns a copy — mutations do not affect the registry', () => {
    registerPlugin({ name: 'x' });
    const plugins = getRegisteredPlugins();
    plugins.length = 0;
    expect(getRegisteredPlugins()).toHaveLength(1);
  });
});

describe('getPluginContainerEnvKeys', () => {
  it('returns empty array when no plugins registered', () => {
    expect(getPluginContainerEnvKeys()).toEqual([]);
  });

  it('returns containerEnvKeys declared by a plugin', () => {
    registerPlugin({ name: 'vpn', containerEnvKeys: ['VPN_TOKEN', 'VPN_HOST'] });
    expect(getPluginContainerEnvKeys()).toEqual(
      expect.arrayContaining(['VPN_TOKEN', 'VPN_HOST']),
    );
  });

  it('deduplicates keys across plugins', () => {
    registerPlugin({ name: 'a', containerEnvKeys: ['SHARED_KEY', 'KEY_A'] });
    registerPlugin({ name: 'b', containerEnvKeys: ['SHARED_KEY', 'KEY_B'] });
    const keys = getPluginContainerEnvKeys();
    const unique = new Set(keys);
    expect(keys.length).toBe(unique.size);
    expect(keys).toEqual(expect.arrayContaining(['SHARED_KEY', 'KEY_A', 'KEY_B']));
  });

  it('skips plugins without containerEnvKeys', () => {
    registerPlugin({ name: 'no-env' });
    registerPlugin({ name: 'with-env', containerEnvKeys: ['MY_KEY'] });
    expect(getPluginContainerEnvKeys()).toEqual(['MY_KEY']);
  });
});

describe('getPluginContainerEnv', () => {
  it('returns empty object when no plugins registered', () => {
    expect(getPluginContainerEnv({ FOO: 'bar' })).toEqual({});
  });

  it('returns only keys declared by plugins', () => {
    registerPlugin({ name: 'a', containerEnvKeys: ['KEY_A'] });
    const result = getPluginContainerEnv({ KEY_A: '1', KEY_B: '2', OTHER: '3' });
    expect(result).toEqual({ KEY_A: '1' });
  });

  it('omits declared keys that are absent from env', () => {
    registerPlugin({ name: 'a', containerEnvKeys: ['MISSING_KEY'] });
    expect(getPluginContainerEnv({})).toEqual({});
  });

  it('collects keys from multiple plugins', () => {
    registerPlugin({ name: 'a', containerEnvKeys: ['KEY_A'] });
    registerPlugin({ name: 'b', containerEnvKeys: ['KEY_B'] });
    const result = getPluginContainerEnv({ KEY_A: 'alpha', KEY_B: 'beta', EXTRA: 'x' });
    expect(result).toEqual({ KEY_A: 'alpha', KEY_B: 'beta' });
  });
});
