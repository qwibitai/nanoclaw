import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { describe, it, expect } from 'bun:test';

import {
  type AppServer,
  type JsonRpcServerRequest,
  STALE_THREAD_RE,
  attachCodexAutoApproval,
  tomlBasicString,
} from './codex-app-server.js';

describe('tomlBasicString', () => {
  it('leaves safe strings unchanged inside quotes', () => {
    expect(tomlBasicString('hello')).toBe('"hello"');
    expect(tomlBasicString('bun')).toBe('"bun"');
    expect(tomlBasicString('/usr/local/bin/node')).toBe('"/usr/local/bin/node"');
  });

  it('escapes double-quotes', () => {
    expect(tomlBasicString('a"b')).toBe('"a\\"b"');
    expect(tomlBasicString('"quoted"')).toBe('"\\"quoted\\""');
  });

  it('escapes backslashes', () => {
    expect(tomlBasicString('a\\b')).toBe('"a\\\\b"');
    expect(tomlBasicString('C:\\path\\to\\bin')).toBe('"C:\\\\path\\\\to\\\\bin"');
  });

  it('escapes backslash before quote (order matters)', () => {
    expect(tomlBasicString('\\"')).toBe('"\\\\\\""');
  });

  it('rejects strings containing newlines', () => {
    expect(() => tomlBasicString('line1\nline2')).toThrow(/newline/);
    expect(() => tomlBasicString('trailing\n')).toThrow(/newline/);
    expect(() => tomlBasicString('crlf\r\nhere')).toThrow(/newline/);
  });
});

describe('STALE_THREAD_RE', () => {
  it('matches stale-thread error messages', () => {
    expect(STALE_THREAD_RE.test('thread not found')).toBe(true);
    expect(STALE_THREAD_RE.test('unknown thread xyz')).toBe(true);
    expect(STALE_THREAD_RE.test('No such thread: abc')).toBe(true);
    expect(STALE_THREAD_RE.test('invalid thread_id')).toBe(true);
  });

  it('does not match transient or unrelated errors', () => {
    expect(STALE_THREAD_RE.test('rate limit exceeded')).toBe(false);
    expect(STALE_THREAD_RE.test('authentication failed')).toBe(false);
    expect(STALE_THREAD_RE.test('connection reset by peer')).toBe(false);
    expect(STALE_THREAD_RE.test('internal server error')).toBe(false);
  });
});

describe('Codex CLI pin contract', () => {
  it('keeps app-server behind a concrete pinned @openai/codex install', () => {
    const testDir = path.dirname(fileURLToPath(import.meta.url));
    const dockerfile = fs.readFileSync(path.resolve(testDir, '../../../Dockerfile'), 'utf-8');

    const versionMatch = dockerfile.match(/^ARG CODEX_VERSION=(.+)$/m);
    expect(versionMatch).not.toBeNull();
    expect(versionMatch![1]).not.toBe('latest');
    expect(versionMatch![1]).toMatch(/^\d+\.\d+\.\d+$/);
    expect(dockerfile).toContain('pnpm install -g "@openai/codex@${CODEX_VERSION}"');
  });
});

describe('attachCodexAutoApproval', () => {
  function fakeServer(): { server: AppServer; writes: string[] } {
    const writes: string[] = [];
    const server = {
      process: {
        stdin: {
          write: (line: string) => {
            writes.push(line);
            return true;
          },
        },
      },
      pending: new Map(),
      notificationHandlers: [],
      serverRequestHandlers: [],
    } as unknown as AppServer;

    return { server, writes };
  }

  function send(server: AppServer, method: string): void {
    const request: JsonRpcServerRequest = { id: 7, method, params: {} };
    server.serverRequestHandlers[0](request);
  }

  it('auto-accepts command and file approvals inside the container sandbox', () => {
    const { server, writes } = fakeServer();
    attachCodexAutoApproval(server);

    send(server, 'item/commandExecution/requestApproval');
    send(server, 'item/fileChange/requestApproval');

    expect(writes.map((line) => JSON.parse(line).result.decision)).toEqual(['accept', 'accept']);
  });

  it('grants broad app-server permissions because NanoClaw relies on container mounts as the boundary', () => {
    const { server, writes } = fakeServer();
    attachCodexAutoApproval(server);

    send(server, 'item/permissions/requestApproval');

    const result = JSON.parse(writes[0]).result;
    expect(result).toEqual({
      permissions: { fileSystem: { read: ['/'], write: ['/'] }, network: { enabled: true } },
      scope: 'session',
    });
  });
});
