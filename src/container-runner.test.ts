import { describe, expect, it } from 'vitest';

import { clearContainerImageCache, containerImageExists, resolveProviderName } from './container-runner.js';

describe('resolveProviderName', () => {
  it('prefers session over group and container.json', () => {
    expect(resolveProviderName('codex', 'opencode', 'claude')).toBe('codex');
  });

  it('falls back to group when session is null', () => {
    expect(resolveProviderName(null, 'codex', 'claude')).toBe('codex');
  });

  it('falls back to container.json when session and group are null', () => {
    expect(resolveProviderName(null, null, 'opencode')).toBe('opencode');
  });

  it('defaults to claude when nothing is set', () => {
    expect(resolveProviderName(null, null, undefined)).toBe('claude');
  });

  it('lowercases the resolved name', () => {
    expect(resolveProviderName('CODEX', null, null)).toBe('codex');
    expect(resolveProviderName(null, 'OpenCode', null)).toBe('opencode');
    expect(resolveProviderName(null, null, 'Claude')).toBe('claude');
  });

  it('treats empty string as unset (falls through)', () => {
    expect(resolveProviderName('', 'codex', null)).toBe('codex');
    expect(resolveProviderName(null, '', 'opencode')).toBe('opencode');
  });
});

describe('containerImageExists', () => {
  it('caches positive inspections per image tag', () => {
    clearContainerImageCache();
    let calls = 0;
    const inspect = () => {
      calls++;
      return true;
    };

    expect(containerImageExists('nanoclaw:test', inspect)).toBe(true);
    expect(containerImageExists('nanoclaw:test', inspect)).toBe(true);
    expect(calls).toBe(1);
  });

  it('does not cache negative inspections', () => {
    clearContainerImageCache();
    let calls = 0;
    const inspect = () => {
      calls++;
      return false;
    };

    expect(containerImageExists('nanoclaw:missing', inspect)).toBe(false);
    expect(containerImageExists('nanoclaw:missing', inspect)).toBe(false);
    expect(calls).toBe(2);
  });

  it('clears cached entries when requested', () => {
    clearContainerImageCache();
    let calls = 0;
    const inspect = () => {
      calls++;
      return true;
    };

    expect(containerImageExists('nanoclaw:test', inspect)).toBe(true);
    clearContainerImageCache('nanoclaw:test');
    expect(containerImageExists('nanoclaw:test', inspect)).toBe(true);
    expect(calls).toBe(2);
  });
});
