import fs from 'fs';

import { vi } from 'vitest';

export function createMockProcess(pid = 12345) {
  return {
    pid,
    unref: vi.fn(),
    kill: vi.fn(),
    stdin: { write: vi.fn(), end: vi.fn() },
  };
}

export interface RcFsSpies {
  readFileSync: ReturnType<typeof vi.spyOn>;
  writeFileSync: ReturnType<typeof vi.spyOn>;
  unlinkSync: ReturnType<typeof vi.spyOn>;
  openSync: ReturnType<typeof vi.spyOn>;
  closeSync: ReturnType<typeof vi.spyOn>;
  getStdoutContent: () => string;
  setStdoutContent: (value: string) => void;
}

/**
 * Install the fs spy set used by every remote-control test. The default
 * readFileSync throws ENOENT for the json state file and returns the
 * stdout buffer managed via `setStdoutContent` for the `.stdout` file.
 */
export function installRcFsSpies(): RcFsSpies {
  let stdoutFileContent = '';

  vi.spyOn(fs, 'mkdirSync')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .mockImplementation(() => undefined as any);
  const writeFileSync = vi
    .spyOn(fs, 'writeFileSync')
    .mockImplementation(() => {});
  const unlinkSync = vi.spyOn(fs, 'unlinkSync').mockImplementation(() => {});
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const openSync = vi.spyOn(fs, 'openSync').mockReturnValue(42 as any);
  const closeSync = vi.spyOn(fs, 'closeSync').mockImplementation(() => {});

  const readFileSync = vi.spyOn(fs, 'readFileSync').mockImplementation(((
    p: string,
  ) => {
    if (p.endsWith('remote-control.stdout')) return stdoutFileContent;
    if (p.endsWith('remote-control.json')) {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    }
    return '';
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any);

  return {
    readFileSync,
    writeFileSync,
    unlinkSync,
    openSync,
    closeSync,
    getStdoutContent: () => stdoutFileContent,
    setStdoutContent: (value: string) => {
      stdoutFileContent = value;
    },
  };
}
