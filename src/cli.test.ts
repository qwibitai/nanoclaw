import { describe, it, expect } from 'vitest';

import { parseArgs } from './cli.js';

describe('parseArgs', () => {
  it('extracts command from argv', () => {
    const result = parseArgs(['node', 'cli.js', 'deploy']);
    expect(result.command).toBe('deploy');
    expect(result.args).toEqual([]);
  });

  it('extracts command with args', () => {
    const result = parseArgs(['node', 'cli.js', 'agent', 'add', 'bob']);
    expect(result.command).toBe('agent');
    expect(result.args).toEqual(['add', 'bob']);
  });

  it('defaults to help when no command', () => {
    const result = parseArgs(['node', 'cli.js']);
    expect(result.command).toBe('help');
  });

  it('passes flags through as args', () => {
    const result = parseArgs(['node', 'cli.js', 'logs', '--follow']);
    expect(result.command).toBe('logs');
    expect(result.args).toEqual(['--follow']);
  });

  it('handles --help as command', () => {
    const result = parseArgs(['node', 'cli.js', '--help']);
    expect(result.command).toBe('--help');
  });
});
