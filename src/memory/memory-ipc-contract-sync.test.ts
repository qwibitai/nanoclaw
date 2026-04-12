import fs from 'fs';
import path from 'path';

import { describe, expect, it } from 'vitest';

function readFileNormalized(filePath: string): string {
  return fs.readFileSync(filePath, 'utf-8').replace(/\r\n/g, '\n').trim();
}

describe('memory IPC contract sync', () => {
  it('keeps host and agent-runner contract files identical', () => {
    const projectRoot = process.cwd();
    const hostContract = path.join(
      projectRoot,
      'src',
      'memory',
      'memory-ipc-contract.ts',
    );
    const runnerContract = path.join(
      projectRoot,
      'agent-runner',
      'src',
      'memory-ipc-contract.ts',
    );

    expect(readFileNormalized(runnerContract)).toBe(
      readFileNormalized(hostContract),
    );
  });
});
