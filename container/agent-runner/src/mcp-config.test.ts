import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { loadMcpConfig } from './mcp-config.js';

describe('loadMcpConfig', () => {
  let sandbox: string;

  beforeEach(() => {
    sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-config-'));
  });

  afterEach(() => {
    try {
      fs.rmSync(sandbox, { recursive: true, force: true });
      // eslint-disable-next-line no-catch-all/no-catch-all
    } catch {
      /* ignore */
    }
  });

  it('returns {} for a non-existent file', () => {
    expect(loadMcpConfig(path.join(sandbox, 'missing.json'))).toEqual({});
  });

  it('returns the servers map when the file is valid', () => {
    const file = path.join(sandbox, 'ok.json');
    fs.writeFileSync(
      file,
      JSON.stringify({
        servers: {
          'fs-tools': { command: 'node', args: ['server.js'] },
          weather: { command: 'weather-cli' },
        },
      }),
    );
    const result = loadMcpConfig(file);
    expect(result['fs-tools']).toEqual({
      command: 'node',
      args: ['server.js'],
    });
    expect(result.weather).toEqual({ command: 'weather-cli' });
  });

  it('returns {} when the JSON lacks a servers field', () => {
    const file = path.join(sandbox, 'no-servers.json');
    fs.writeFileSync(file, JSON.stringify({ other: 'stuff' }));
    expect(loadMcpConfig(file)).toEqual({});
  });

  it('returns {} for malformed JSON (does not throw)', () => {
    const file = path.join(sandbox, 'bad.json');
    fs.writeFileSync(file, '{ not json');
    expect(loadMcpConfig(file)).toEqual({});
  });
});
