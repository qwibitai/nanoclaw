/**
 * Tests for the Ollama MCP wrapper's path resolution and body assembly.
 *
 * These helpers live in ollama-helpers.ts so they can be exercised without
 * importing ollama-mcp-stdio.ts (that module starts the MCP server on load).
 */
import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { resolveWorkspacePath, buildGenerateBody } from './ollama-helpers.js';

let tmpRoot: string;
const HI_BYTES = Buffer.from([0x68, 0x69]); // "hi"
const HI_BASE64 = 'aGk=';

beforeAll(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ollama-helpers-'));
  fs.mkdirSync(path.join(tmpRoot, 'inbox', 'abc'), { recursive: true });
  fs.writeFileSync(path.join(tmpRoot, 'inbox', 'abc', 'photo.jpg'), HI_BYTES);
});

afterAll(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('resolveWorkspacePath', () => {
  it('accepts a workspace-relative path', () => {
    const out = resolveWorkspacePath('inbox/abc/photo.jpg', tmpRoot);
    expect(out).toBe(path.join(tmpRoot, 'inbox/abc/photo.jpg'));
  });

  it('accepts an absolute path that already resolves under the workspace root', () => {
    const abs = path.join(tmpRoot, 'inbox/abc/photo.jpg');
    const out = resolveWorkspacePath(abs, tmpRoot);
    expect(out).toBe(abs);
  });

  it('strips a leading "/workspace/" prefix so agents can pass paths verbatim from the formatter', () => {
    // The formatter shows paths like "/workspace/inbox/<msgid>/<file>" to the
    // agent. The resolver should accept that form even when the actual root
    // (in tests) is elsewhere.
    const out = resolveWorkspacePath('/workspace/inbox/abc/photo.jpg', tmpRoot);
    expect(out).toBe(path.join(tmpRoot, 'inbox/abc/photo.jpg'));
  });

  it('rejects a relative path that escapes via ".."', () => {
    expect(() => resolveWorkspacePath('../outside.txt', tmpRoot)).toThrow(/escapes workspace/);
  });

  it('rejects an absolute path outside the workspace root', () => {
    // Use a path that definitely won't be inside macOS tmpdir
    expect(() => resolveWorkspacePath('/var/empty/outside.txt', tmpRoot)).toThrow(/escapes workspace/);
  });
});

describe('buildGenerateBody', () => {
  it('omits images when the field is absent', () => {
    const body = buildGenerateBody({ model: 'gemma3:4b', prompt: 'hi' }, tmpRoot);
    expect(body).toEqual({ model: 'gemma3:4b', prompt: 'hi', stream: false });
    expect('images' in body).toBe(false);
  });

  it('omits images when an empty array is passed', () => {
    const body = buildGenerateBody({ model: 'gemma3:4b', prompt: 'hi', images: [] }, tmpRoot);
    expect('images' in body).toBe(false);
  });

  it('includes a system prompt when provided', () => {
    const body = buildGenerateBody(
      { model: 'gemma3:4b', prompt: 'hi', system: 'you are terse' },
      tmpRoot,
    );
    expect(body.system).toBe('you are terse');
  });

  it('reads each image path under the workspace and base64-encodes the bytes', () => {
    const body = buildGenerateBody(
      { model: 'gemma3:4b', prompt: 'describe', images: ['inbox/abc/photo.jpg'] },
      tmpRoot,
    );
    expect(body.images).toEqual([HI_BASE64]);
  });

  it('encodes multiple images in order', () => {
    fs.writeFileSync(path.join(tmpRoot, 'inbox', 'abc', 'second.jpg'), Buffer.from([0x6f, 0x6b])); // "ok"
    const body = buildGenerateBody(
      {
        model: 'gemma3:4b',
        prompt: 'compare',
        images: ['inbox/abc/photo.jpg', 'inbox/abc/second.jpg'],
      },
      tmpRoot,
    );
    expect(body.images).toEqual([HI_BASE64, 'b2s=']);
  });

  it('propagates the workspace-escape error when an image path tries to break out', () => {
    expect(() =>
      buildGenerateBody(
        { model: 'gemma3:4b', prompt: 'x', images: ['../outside.txt'] },
        tmpRoot,
      ),
    ).toThrow(/escapes workspace/);
  });
});
