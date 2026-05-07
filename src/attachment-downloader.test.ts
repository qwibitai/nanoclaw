import fs from 'fs';
import path from 'path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { tmpRoot } = vi.hoisted(() => {
  const fsMod = require('fs') as typeof import('fs');
  const osMod = require('os') as typeof import('os');
  const pathMod = require('path') as typeof import('path');
  return { tmpRoot: fsMod.mkdtempSync(pathMod.join(osMod.tmpdir(), 'attach-dl-')) };
});

vi.mock('./db/agent-groups.js', () => ({ getAgentGroup: () => undefined }));
vi.mock('./container-config.js', () => ({ readContainerConfig: () => ({}) }));
vi.mock('./memory-daemon/source-ingest.js', () => ({ isNonSymlinkChain: () => false }));
vi.mock('./session-manager.js', () => ({
  sessionDir: (ag: string, sess: string) => path.join(tmpRoot, ag, sess),
}));
vi.mock('./config.js', () => ({ GROUPS_DIR: path.join(tmpRoot, 'groups') }));

import { persistInboundAttachments } from './attachment-downloader.js';

const AG = 'ag-test';
const SESS = 'sess-test';

beforeEach(() => {
  fs.rmSync(path.join(tmpRoot, AG), { recursive: true, force: true });
});

afterEach(() => {
  fs.rmSync(path.join(tmpRoot, AG), { recursive: true, force: true });
});

describe('persistInboundAttachments', () => {
  it('preserves all attachments when names collide (Slack/Discord paste case)', () => {
    // Four distinct images, all named "image.png" (Slack's default for pasted screenshots).
    const content = {
      text: 'see screenshots',
      attachments: [
        { type: 'image', name: 'image.png', mimeType: 'image/png', data: Buffer.from('AAAA').toString('base64') },
        { type: 'image', name: 'image.png', mimeType: 'image/png', data: Buffer.from('BBBB').toString('base64') },
        { type: 'image', name: 'image.png', mimeType: 'image/png', data: Buffer.from('CCCC').toString('base64') },
        { type: 'image', name: 'image.png', mimeType: 'image/png', data: Buffer.from('DDDD').toString('base64') },
      ],
    };
    const result = persistInboundAttachments(AG, SESS, 'msg-1', JSON.stringify(content));
    const parsed = JSON.parse(result);

    const localPaths = parsed.attachments.map((a: { localPath: string }) => a.localPath);
    expect(new Set(localPaths).size).toBe(4); // four distinct paths

    // Every file must exist on disk and contain the original bytes.
    const expectedBytes = ['AAAA', 'BBBB', 'CCCC', 'DDDD'];
    for (let i = 0; i < 4; i++) {
      const abs = path.join(tmpRoot, AG, SESS, localPaths[i]);
      expect(fs.existsSync(abs)).toBe(true);
      expect(fs.readFileSync(abs).toString()).toBe(expectedBytes[i]);
    }
  });

  it('is idempotent for identical content (same hash → same path → same bytes)', () => {
    const content = {
      attachments: [
        { type: 'image', name: 'image.png', data: Buffer.from('SAME').toString('base64') },
        { type: 'image', name: 'image.png', data: Buffer.from('SAME').toString('base64') },
      ],
    };
    const parsed = JSON.parse(persistInboundAttachments(AG, SESS, 'msg-2', JSON.stringify(content)));
    expect(parsed.attachments[0].localPath).toBe(parsed.attachments[1].localPath);
    const abs = path.join(tmpRoot, AG, SESS, parsed.attachments[0].localPath);
    expect(fs.readFileSync(abs).toString()).toBe('SAME');
  });
});
