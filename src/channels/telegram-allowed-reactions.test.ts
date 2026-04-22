import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

describe('Telegram allowed reactions allowlist', () => {
  it('host and container copies stay in sync', () => {
    const hostList = JSON.parse(
      fs.readFileSync(
        path.resolve(__dirname, 'telegram-allowed-reactions.json'),
        'utf-8',
      ),
    );
    const containerList = JSON.parse(
      fs.readFileSync(
        path.resolve(
          __dirname,
          '../../container/agent-runner/src/telegram-allowed-reactions.json',
        ),
        'utf-8',
      ),
    );

    expect(Array.isArray(hostList)).toBe(true);
    expect(Array.isArray(containerList)).toBe(true);
    expect(hostList).toEqual(containerList);
  });
});
