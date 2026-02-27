import { describe, it, expect } from 'vitest';

/**
 * Tests for setup/groups.ts fixes from issue #537.
 *
 * The sync script is an inline string executed via `node .sync-groups.mjs`.
 * We can't run it without a live WhatsApp connection, but we CAN validate
 * the script structure and the race-condition fix patterns.
 */

// Extract the sync script string the same way groups.ts builds it,
// so we can inspect it for the required patterns.
function getSyncScript(): string {
  // This mirrors the inline script from setup/groups.ts (the `syncScript` const).
  // We re-read it from the source file to stay in sync.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fs = require('fs');
  const path = require('path');
  const source = fs.readFileSync(
    path.join(__dirname, 'groups.ts'),
    'utf-8',
  ) as string;

  // Extract the template literal between the first ` and matching `
  const startMarker = 'const syncScript = `';
  const startIdx = source.indexOf(startMarker);
  if (startIdx === -1) throw new Error('Could not find syncScript in groups.ts');
  const contentStart = startIdx + startMarker.length;
  const endIdx = source.indexOf('`;', contentStart);
  if (endIdx === -1) throw new Error('Could not find end of syncScript');
  return source.slice(contentStart, endIdx);
}

describe('sync script — race condition fix (#537)', () => {
  let script: string;

  it('can extract the sync script from groups.ts', () => {
    script = getSyncScript();
    expect(script).toBeTruthy();
    expect(script.length).toBeGreaterThan(100);
  });

  it('declares a `done` flag before the connection handler', () => {
    script = getSyncScript();
    // The done flag must exist to prevent the close handler from racing
    expect(script).toContain('let done = false');
  });

  it('sets `done = true` in the finally block (before sock.end)', () => {
    script = getSyncScript();
    const finallyIdx = script.indexOf('} finally {');
    const doneSetIdx = script.indexOf('done = true', finallyIdx);
    const sockEndIdx = script.indexOf('sock.end(', finallyIdx);
    expect(finallyIdx).toBeGreaterThan(-1);
    expect(doneSetIdx).toBeGreaterThan(finallyIdx);
    // done = true must come before sock.end to prevent the race
    expect(doneSetIdx).toBeLessThan(sockEndIdx);
  });

  it('guards the close handler with `!done`', () => {
    script = getSyncScript();
    // The close handler must check !done to skip exit(1) after successful sync
    expect(script).toContain("update.connection === 'close' && !done");
  });

  it('exits with 0 on success, not 1', () => {
    script = getSyncScript();
    // The finally block should exit(0)
    const finallyIdx = script.indexOf('} finally {');
    const exitZeroIdx = script.indexOf('process.exit(0)', finallyIdx);
    expect(exitZeroIdx).toBeGreaterThan(finallyIdx);
  });
});

describe('sync script — fetchLatestWaWebVersion (#537)', () => {
  it('imports fetchLatestWaWebVersion from baileys', () => {
    const script = getSyncScript();
    expect(script).toContain('fetchLatestWaWebVersion');
  });

  it('imports DisconnectReason from baileys', () => {
    const script = getSyncScript();
    expect(script).toContain('DisconnectReason');
  });

  it('fetches version before creating socket', () => {
    const script = getSyncScript();
    const versionFetchIdx = script.indexOf('fetchLatestWaWebVersion');
    const makeSocketIdx = script.indexOf('makeWASocket(');
    expect(versionFetchIdx).toBeGreaterThan(-1);
    expect(makeSocketIdx).toBeGreaterThan(-1);
    // Version fetch must happen before socket creation
    expect(versionFetchIdx).toBeLessThan(makeSocketIdx);
  });

  it('passes version to makeWASocket', () => {
    const script = getSyncScript();
    // After makeWASocket({, version should appear before the closing })
    const socketStart = script.indexOf('makeWASocket({');
    const socketEnd = script.indexOf('});', socketStart);
    const socketBlock = script.slice(socketStart, socketEnd);
    expect(socketBlock).toContain('version');
  });

  it('has a graceful fallback if version fetch fails', () => {
    const script = getSyncScript();
    // Should catch errors and fallback to undefined version
    expect(script).toMatch(/fetchLatestWaWebVersion.*\.catch/);
  });
});

describe('sync script — temp file execution (#537)', () => {
  it('writes to a .mjs temp file instead of using node -e', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require('fs');
    const path = require('path');
    const source = fs.readFileSync(
      path.join(__dirname, 'groups.ts'),
      'utf-8',
    ) as string;

    // Should write to a temp .mjs file
    expect(source).toContain('.sync-groups.mjs');
    // Should use `node ${tmpScript}` not `node --input-type=module -e`
    expect(source).toContain('node ${tmpScript}');
    // Should NOT use the old node -e approach
    expect(source).not.toContain('--input-type=module -e');
  });

  it('cleans up the temp file in a finally block', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require('fs');
    const path = require('path');
    const source = fs.readFileSync(
      path.join(__dirname, 'groups.ts'),
      'utf-8',
    ) as string;

    // Should have fs.unlinkSync in a finally block
    expect(source).toContain('fs.unlinkSync(tmpScript)');
  });

  it('logs disconnect reason code on CONNECTION_CLOSED', () => {
    const script = getSyncScript();
    // Should include status code in the error message
    expect(script).toContain("'CONNECTION_CLOSED:'");
    expect(script).toContain('statusCode');
  });
});
