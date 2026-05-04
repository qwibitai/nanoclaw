import { describe, expect, it } from 'vitest';

import { TenantCache } from '../tenant-cache.js';

describe('TenantCache', () => {
  it('returns null for missing keys', () => {
    const cache = new TenantCache();
    expect(cache.get('+5491100000001')).toBeNull();
  });

  it('stores and retrieves a value', () => {
    const cache = new TenantCache();
    cache.set('+5491100000001', 'tenant_a');
    expect(cache.get('+5491100000001')).toBe('tenant_a');
  });

  it('evicts entries past their TTL', () => {
    let now = 1_000_000;
    const cache = new TenantCache({ ttlMs: 1000, now: () => now });
    cache.set('+5491100000001', 'tenant_a');
    expect(cache.get('+5491100000001')).toBe('tenant_a');
    now += 1500;
    expect(cache.get('+5491100000001')).toBeNull();
    expect(cache.size()).toBe(0);
  });

  it('evicts the oldest entry when over capacity', () => {
    const cache = new TenantCache({ maxEntries: 3 });
    cache.set('a', 'tenant_a');
    cache.set('b', 'tenant_b');
    cache.set('c', 'tenant_c');
    cache.set('d', 'tenant_d'); // evicts 'a'
    expect(cache.get('a')).toBeNull();
    expect(cache.get('b')).toBe('tenant_b');
    expect(cache.get('c')).toBe('tenant_c');
    expect(cache.get('d')).toBe('tenant_d');
    expect(cache.size()).toBe(3);
  });

  it('refreshes recency on read so LRU evicts truly cold entries', () => {
    const cache = new TenantCache({ maxEntries: 3 });
    cache.set('a', 'tenant_a');
    cache.set('b', 'tenant_b');
    cache.set('c', 'tenant_c');
    // Touch 'a' so 'b' is now the oldest.
    expect(cache.get('a')).toBe('tenant_a');
    cache.set('d', 'tenant_d');
    expect(cache.get('b')).toBeNull();
    expect(cache.get('a')).toBe('tenant_a');
  });

  it('overwrites existing entries without growing past capacity', () => {
    const cache = new TenantCache({ maxEntries: 2 });
    cache.set('a', 'tenant_a1');
    cache.set('a', 'tenant_a2');
    expect(cache.get('a')).toBe('tenant_a2');
    expect(cache.size()).toBe(1);
  });

  it('supports concurrent reads without invalidating other entries', () => {
    const cache = new TenantCache({ maxEntries: 5 });
    cache.set('a', 'tenant_a');
    cache.set('b', 'tenant_b');
    cache.set('c', 'tenant_c');
    // Simulate concurrent access — each get() must yield the right value.
    const results = ['a', 'b', 'c', 'a', 'b'].map((k) => cache.get(k));
    expect(results).toEqual([
      'tenant_a',
      'tenant_b',
      'tenant_c',
      'tenant_a',
      'tenant_b',
    ]);
  });

  it('supports delete and clear', () => {
    const cache = new TenantCache();
    cache.set('a', 'tenant_a');
    cache.set('b', 'tenant_b');
    cache.delete('a');
    expect(cache.get('a')).toBeNull();
    expect(cache.get('b')).toBe('tenant_b');
    cache.clear();
    expect(cache.size()).toBe(0);
  });
});
