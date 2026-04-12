#!/usr/bin/env npx tsx
/**
 * Test: broken MCP .ts file does NOT block agent-runner startup.
 * MCP is at /home/node/.claude/mcp/ (separate from /app/src/).
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
const mcpDir = path.join(testDir, 'mcp', 'bad');
const groupDir = path.join(testDir, 'group');
const scriptDir = path.join(testDir, 'scripts');

fs.mkdirSync(mcpDir, { recursive: true });
fs.mkdirSync(groupDir, { recursive: true });
fs.mkdirSync(scriptDir, { recursive: true });

// Broken .ts file with type error
fs.writeFileSync(
  path.join(mcpDir, 'broken.ts'),
  'const x: number = "not a number";\nconsole.log("BROKEN");\n',
);

// Symlink (same as production flow)
fs.symlinkSync('/app/node_modules', path.join(mcpDir, 'node_modules'));

// Test: run tsc (agent-runner compilation) then check if it succeeds
fs.writeFileSync(
  path.join(scriptDir, 'run.sh'),
  [
    '#!/bin/bash',
    '# Step 1: compile agent-runner (entrypoint does this)',
    'cd /app && npx tsc --outDir /tmp/dist 2>&1',
    'tsc_exit=$?',
    'echo "TSC_EXIT:$tsc_exit"',
    '',
    '# Step 2: try running the broken MCP directly',
    'node --experimental-transform-types /home/node/.claude/mcp/bad/broken.ts 2>&1 || true',
    'echo "DONE"',
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
  'mcp-broken-' + Date.now(),
);

const ex = await box.exec(
  '/bin/bash',
  ['/workspace/test/run.sh'],
  null,
  false,
  null,
  60,
  '/workspace/group',
);

try {
  const s = await ex.stdin();
  await s.close();
} catch {
  /* ignore */
}

let stdout = '';
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

await ex.wait().catch(() => {});
try {
  await box.stop();
} catch {
  /* ignore */
}

console.log(stdout.slice(0, 500));

if (stdout.includes('TSC_EXIT:0')) {
  console.log(
    '\nPASS: tsc compiled agent-runner OK — broken MCP .ts does NOT block startup',
  );
} else {
  console.log('\nFAIL: tsc failed — broken MCP blocked agent-runner');
}

fs.rmSync(tmpDir, { recursive: true, force: true });
