import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createDefaultDeps } from './system-prompt.js';

describe('createDefaultDeps.readFile', () => {
  let sandbox: string;
  beforeEach(() => {
    sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-deps-'));
  });
  afterEach(() => {
    fs.rmSync(sandbox, { recursive: true, force: true });
  });

  it('returns the file contents when it exists', () => {
    const file = path.join(sandbox, 'hello.md');
    fs.writeFileSync(file, 'hello world');
    const deps = createDefaultDeps(() => {});
    expect(deps.readFile(file)).toBe('hello world');
  });

  it('returns null when the path does not exist', () => {
    const deps = createDefaultDeps(() => {});
    expect(deps.readFile(path.join(sandbox, 'missing.md'))).toBeNull();
  });

  it('returns null and logs when the path is a directory', () => {
    const log = vi.fn();
    const deps = createDefaultDeps(log);
    expect(deps.readFile(sandbox)).toBeNull();
    expect(log).toHaveBeenCalled();
  });
});

describe('createDefaultDeps.loadMcpConfig', () => {
  let sandbox: string;
  beforeEach(() => {
    sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-mcp-'));
  });
  afterEach(() => {
    fs.rmSync(sandbox, { recursive: true, force: true });
  });

  it('returns {} when the config file is missing', () => {
    const deps = createDefaultDeps(() => {});
    expect(deps.loadMcpConfig(path.join(sandbox, 'none.json'))).toEqual({});
  });

  it('parses `servers` section from a valid config', () => {
    const file = path.join(sandbox, 'mcp.json');
    fs.writeFileSync(
      file,
      JSON.stringify({ servers: { ego: { command: 'python' } } }),
    );
    const deps = createDefaultDeps(() => {});
    expect(deps.loadMcpConfig(file)).toEqual({
      ego: { command: 'python' },
    });
  });

  it('returns {} and logs when the JSON is invalid', () => {
    const file = path.join(sandbox, 'bad.json');
    fs.writeFileSync(file, '{not valid');
    const log = vi.fn();
    const deps = createDefaultDeps(log);
    expect(deps.loadMcpConfig(file)).toEqual({});
    expect(log).toHaveBeenCalled();
  });

  it('returns {} when the JSON has no "servers" key', () => {
    const file = path.join(sandbox, 'empty.json');
    fs.writeFileSync(file, '{}');
    const deps = createDefaultDeps(() => {});
    expect(deps.loadMcpConfig(file)).toEqual({});
  });
});

describe('createDefaultDeps.execSubprocess', () => {
  it('resolves stdout from a successful invocation', async () => {
    const deps = createDefaultDeps(() => {});
    const out = await deps.execSubprocess(
      'node',
      ['-e', 'console.log("ok")'],
      {},
      5000,
    );
    expect(out).toBe('ok');
  });

  it('resolves null when the command exits with an error', async () => {
    const log = vi.fn();
    const deps = createDefaultDeps(log);
    const out = await deps.execSubprocess(
      'node',
      ['-e', 'process.exit(1)'],
      {},
      5000,
    );
    expect(out).toBeNull();
    expect(log).toHaveBeenCalled();
  });

  it('resolves null when stdout is only whitespace', async () => {
    const deps = createDefaultDeps(() => {});
    const out = await deps.execSubprocess(
      'node',
      ['-e', 'process.stdout.write("   \\n")'],
      {},
      5000,
    );
    expect(out).toBeNull();
  });
});
