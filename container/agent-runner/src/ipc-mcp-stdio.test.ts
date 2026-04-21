import { describe, it, expect } from 'vitest';
import { validateImagePath } from './ipc-mcp-stdio.js';

const root = '/workspace/group';

describe('validateImagePath', () => {
  it('accepts a relative path whose file exists', () => {
    const res = validateImagePath('outbox/foo.png', root, {
      existsSync: (p) => p === '/workspace/group/outbox/foo.png',
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.absolute).toBe('/workspace/group/outbox/foo.png');
      expect(res.relative).toBe('outbox/foo.png');
    }
  });

  it('rejects a path that resolves outside workspace', () => {
    const res = validateImagePath('../../etc/passwd', root, {
      existsSync: () => true,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/escapes/);
  });

  it('rejects an absolute path outside workspace', () => {
    const res = validateImagePath('/tmp/foo.png', root, {
      existsSync: () => true,
    });
    expect(res.ok).toBe(false);
  });

  it('accepts an absolute path inside workspace', () => {
    const res = validateImagePath('/workspace/group/a/b.jpg', root, {
      existsSync: (p) => p === '/workspace/group/a/b.jpg',
    });
    expect(res.ok).toBe(true);
  });

  it('rejects a missing file', () => {
    const res = validateImagePath('missing.png', root, {
      existsSync: () => false,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/not found/);
  });
});
