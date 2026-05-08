import { describe, expect, it } from 'vitest';

import { buildResourceLimitArgs, resolveProviderName } from './container-runner.js';

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

describe('buildResourceLimitArgs', () => {
  it('emits all three flags when all values are set', () => {
    expect(buildResourceLimitArgs('512m', '1', '512')).toEqual([
      '--memory',
      '512m',
      '--cpus',
      '1',
      '--pids-limit',
      '512',
    ]);
  });

  it('omits a flag when its value is "0" (Docker unlimited convention)', () => {
    expect(buildResourceLimitArgs('0', '1', '512')).toEqual(['--cpus', '1', '--pids-limit', '512']);
    expect(buildResourceLimitArgs('512m', '0', '512')).toEqual(['--memory', '512m', '--pids-limit', '512']);
    expect(buildResourceLimitArgs('512m', '1', '0')).toEqual(['--memory', '512m', '--cpus', '1']);
  });

  it('omits a flag when its value is empty', () => {
    expect(buildResourceLimitArgs('', '', '')).toEqual([]);
  });

  it('passes values through verbatim — runtime is the unit-validation authority', () => {
    expect(buildResourceLimitArgs('1g', '0.5', '1024')).toEqual([
      '--memory',
      '1g',
      '--cpus',
      '0.5',
      '--pids-limit',
      '1024',
    ]);
  });
});
