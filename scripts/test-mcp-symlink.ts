#!/usr/bin/env npx tsx
/**
 * Test: host-created dangling symlink to /app/node_modules resolves in container.
 * This verifies the final approach: MCP in .claude/mcp/ + host symlink.
 */

import fs from 'fs';
import path from 'path';

const tmpDir = fs.mkdtempSync('/tmp/al-mcp-');
const BOXLITE_HOME = path.join(tmpDir, 'bl');
fs.mkdirSync(BOXLITE_HOME, { recursive: true });

const { JsBoxlite } = await import('@boxlite-ai/boxlite');
const runtime = new JsBoxlite({ homeDir: BOXLITE_HOME });
const IMAGE = 'ghcr.io/boxlite-ai/agentlite-agent:latest';

const testDir = path.join(tmpDir, 'test');
const mcpDir = path.join(testDir, 'mcp', 'myserver');
const groupDir = path.join(testDir, 'group');
const scriptDir = path.join(testDir, 'scripts');

fs.mkdirSync(mcpDir, { recursive: true });
fs.mkdirSync(groupDir, { recursive: true });
fs.mkdirSync(scriptDir, { recursive: true });

fs.writeFileSync(
  path.join(mcpDir, 'server.ts'),
  [
    'interface Foo { x: string }',
    'const f: Foo = { x: "works" };',
    "import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';",
    "console.log('SYMLINK_OK:' + typeof McpServer + ':' + f.x);",
  ].join('\n'),
);

// Dangling symlink on host — resolves inside container
fs.symlinkSync('/app/node_modules', path.join(mcpDir, 'node_modules'));

fs.writeFileSync(
  path.join(scriptDir, 'run.sh'),
  [
    '#!/bin/bash',
    'set -e',
    'node --experimental-transform-types /home/node/.claude/mcp/myserver/server.ts',
  ].join('\n'),
  { mode: 0o755 },
);

const box = await runtime.create(
  {
    image: IMAGE,
    autoRemove: true,
    memoryMib: 1024,
    cpus: 1,
    volumes: [
      { hostPath: groupDir, guestPath: '/workspace/group', readOnly: false },
      {
        hostPath: path.join(testDir, 'mcp'),
        guestPath: '/home/node/.claude/mcp',
        readOnly: false,
      },
      { hostPath: scriptDir, guestPath: '/workspace/test', readOnly: true },
    ],
    env: [],
    workingDir: '/workspace/group',
  },
  'mcp-sym-' + Date.now(),
);

const ex = await box.exec(
  '/bin/bash',
  ['/workspace/test/run.sh'],
  null,
  false,
  null,
  30,
  '/workspace/group',
);

try {
  const s = await ex.stdin();
  await s.close();
} catch {
  /* ignore */
}

let stdout = '';
let stderr = '';
try {
  const stream = await ex.stdout();
  while (true) {
    const l = await stream.next();
    if (l === null) break;
    stdout += l;
  }
} catch {
  /* done */
}
try {
  const stream = await ex.stderr();
  while (true) {
    const l = await stream.next();
    if (l === null) break;
    stderr += l;
  }
} catch {
  /* done */
}

await ex.wait().catch(() => {});
try {
  await box.stop();
} catch {
  /* ignore */
}

if (stdout.includes('SYMLINK_OK:function:works')) {
  console.log(
    'PASS: host symlink + .claude/mcp/ + --experimental-transform-types works',
  );
} else {
  console.log('FAIL');
  console.log('stdout:', stdout.slice(0, 300));
  console.log('stderr:', stderr.slice(0, 300));
}

fs.rmSync(tmpDir, { recursive: true, force: true });
