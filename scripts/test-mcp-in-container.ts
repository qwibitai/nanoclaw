#!/usr/bin/env npx tsx
/**
 * E2E test: verify custom MCP servers work inside BoxLite containers.
 *
 * Tests the production approach: MCP sources at /app/src/mcp/{name}/
 * resolve /app/node_modules naturally via ESM ancestor walk.
 *
 * Usage: npx tsx scripts/test-mcp-in-container.ts
 * Exit code 0 = all pass, 1 = failure.
 */

import fs from 'fs';
import path from 'path';

// Short path — macOS has 104-byte limit for Unix socket paths
const tmpDir = fs.mkdtempSync('/tmp/al-mcp-');
const BOXLITE_HOME = path.join(tmpDir, 'bl');
fs.mkdirSync(BOXLITE_HOME, { recursive: true });

const { JsBoxlite } = await import('@boxlite-ai/boxlite');
const runtime = new JsBoxlite({ homeDir: BOXLITE_HOME });

const IMAGE = 'ghcr.io/boxlite-ai/agentlite-agent:latest';

let passed = 0;
let failed = 0;

function pass(name: string) {
  console.log(`  PASS  ${name}`);
  passed++;
}

function fail(name: string, reason: string) {
  console.log(`  FAIL  ${name}`);
  console.log(`        ${reason}`);
  failed++;
}

async function runTest(
  name: string,
  mcpFiles: Record<string, string>,
  shellScript: string,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const testDir = path.join(tmpDir, name);
  const mcpDir = path.join(testDir, 'mcp');
  const groupDir = path.join(testDir, 'group');
  const scriptDir = path.join(testDir, 'scripts');

  fs.mkdirSync(mcpDir, { recursive: true });
  fs.mkdirSync(groupDir, { recursive: true });
  fs.mkdirSync(scriptDir, { recursive: true });

  for (const [file, content] of Object.entries(mcpFiles)) {
    fs.writeFileSync(path.join(mcpDir, file), content);
  }

  fs.writeFileSync(path.join(scriptDir, 'run.sh'), shellScript, {
    mode: 0o755,
  });

  const containerName = `mcp-e2e-${name}-${Date.now()}`;

  const box = await runtime.create(
    {
      image: IMAGE,
      autoRemove: true,
      memoryMib: 1024,
      cpus: 1,
      volumes: [
        {
          hostPath: groupDir,
          guestPath: '/workspace/group',
          readOnly: false,
        },
        {
          hostPath: mcpDir,
          guestPath: '/app/src/mcp/test',
          readOnly: false,
        },
        {
          hostPath: scriptDir,
          guestPath: '/workspace/test',
          readOnly: true,
        },
      ],
      env: [],
      workingDir: '/workspace/group',
    },
    containerName,
  );

  const execution = await box.exec(
    '/bin/bash',
    ['/workspace/test/run.sh'],
    null,
    false,
    null,
    30,
    '/workspace/group',
  );

  try {
    const stdin = await execution.stdin();
    await stdin.close();
  } catch {
    /* ignore */
  }

  const readStream = async (
    getStream: () => Promise<{ next: () => Promise<string | null> }>,
  ) => {
    let buf = '';
    try {
      const stream = await getStream();
      while (true) {
        const line = await stream.next();
        if (line === null) break;
        buf += line;
      }
    } catch {
      /* stream ended */
    }
    return buf;
  };

  const [stdout, stderr, result] = await Promise.all([
    readStream(() => execution.stdout()),
    readStream(() => execution.stderr()),
    execution.wait().catch(() => ({ exitCode: 1 })),
  ]);

  try {
    await box.stop();
  } catch {
    /* already stopped */
  }

  return { stdout, stderr, exitCode: result.exitCode };
}

async function main() {
  console.log('\nMCP Server Container E2E Tests\n');
  console.log(`BoxLite home: ${BOXLITE_HOME}`);
  console.log(`Image: ${IMAGE}`);
  console.log('(First run pulls the image — may take a while)\n');

  // Test 1: JS MCP server at /app/src/mcp/ resolves deps via /app/node_modules
  try {
    const { stdout, stderr, exitCode } = await runTest(
      'js-esm',
      {
        'server.mjs': [
          "import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';",
          "console.log('MCP_IMPORT_OK:' + typeof McpServer);",
        ].join('\n'),
      },
      [
        '#!/bin/bash',
        'set -e',
        'node /app/src/mcp/test/server.mjs',
      ].join('\n'),
    );

    if (stdout.includes('MCP_IMPORT_OK:function')) {
      pass('JS MCP server resolves @modelcontextprotocol/sdk via /app/node_modules (no symlink)');
    } else {
      fail(
        'JS MCP server',
        `exit=${exitCode} stdout=${stdout.trim().slice(0, 300)} stderr=${stderr.trim().slice(0, 300)}`,
      );
    }
  } catch (err) {
    fail('JS MCP server', String(err));
  }

  // Test 2: TS MCP server with --experimental-transform-types
  try {
    const { stdout, stderr, exitCode } = await runTest(
      'ts-esm',
      {
        'server.ts': [
          'interface Greeting { msg: string }',
          "const g: Greeting = { msg: 'hello' };",
          "import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';",
          "console.log('TS_MCP_OK:' + typeof McpServer + ':' + g.msg);",
        ].join('\n'),
      },
      [
        '#!/bin/bash',
        'set -e',
        'node --experimental-transform-types /app/src/mcp/test/server.ts',
      ].join('\n'),
    );

    if (stdout.includes('TS_MCP_OK:function:hello')) {
      pass('TS MCP server runs with --experimental-transform-types at /app/src/mcp/');
    } else {
      fail(
        'TS MCP server',
        `exit=${exitCode} stdout=${stdout.trim().slice(0, 300)} stderr=${stderr.trim().slice(0, 300)}`,
      );
    }
  } catch (err) {
    fail('TS MCP server', String(err));
  }

  // Test 3: Control — from a dir NOT under /app/, deps can't resolve
  try {
    const { stdout } = await runTest(
      'no-ancestor',
      {
        'server.mjs': [
          "import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';",
          "console.log('SHOULD_NOT_REACH');",
        ].join('\n'),
      },
      [
        '#!/bin/bash',
        '# Copy to /tmp (no /app/node_modules ancestor)',
        'mkdir -p /tmp/isolated',
        'cp /app/src/mcp/test/server.mjs /tmp/isolated/',
        'node /tmp/isolated/server.mjs 2>/dev/null && echo "UNEXPECTED" || echo "IMPORT_FAILED"',
      ].join('\n'),
    );

    if (stdout.includes('IMPORT_FAILED') && !stdout.includes('SHOULD_NOT_REACH')) {
      pass('Control: outside /app/ tree, import correctly fails');
    } else {
      fail('Control test', `stdout=${stdout.trim()}`);
    }
  } catch (err) {
    fail('Control test', String(err));
  }

  console.log(`\n${passed} passed, ${failed} failed\n`);

  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }

  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('Fatal:', err);
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
  process.exit(1);
});
