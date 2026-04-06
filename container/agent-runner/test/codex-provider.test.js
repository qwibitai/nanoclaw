import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const packageRoot = path.resolve(import.meta.dirname, '..');
const runnerModuleUrl = pathToFileURL(
  path.join(packageRoot, 'dist', 'index.js'),
).href;
const sharedTempRoot = fs.mkdtempSync(
  path.join(os.tmpdir(), 'nanoclaw-agent-runner-codex-'),
);
const sharedGroupDir = path.join(sharedTempRoot, 'group');
const sharedGlobalDir = path.join(sharedTempRoot, 'global');
const sharedCodexHomeDir = path.join(sharedTempRoot, 'codex-home');
const sharedFakeCodexPath = path.join(sharedTempRoot, 'codex');
const sharedRecordPath = path.join(sharedTempRoot, 'codex-run.json');
const originalEnv = {
  NANOCLAW_WORKSPACE_GROUP_DIR: process.env.NANOCLAW_WORKSPACE_GROUP_DIR,
  NANOCLAW_WORKSPACE_GLOBAL_DIR: process.env.NANOCLAW_WORKSPACE_GLOBAL_DIR,
  NANOCLAW_CODEX_HOME_DIR: process.env.NANOCLAW_CODEX_HOME_DIR,
  NANOCLAW_CODEX_BIN: process.env.NANOCLAW_CODEX_BIN,
  NANOCLAW_CODEX_RECORD_FILE: process.env.NANOCLAW_CODEX_RECORD_FILE,
  NANOCLAW_CODEX_EMIT_THREAD_STARTED:
    process.env.NANOCLAW_CODEX_EMIT_THREAD_STARTED,
  NANOCLAW_CODEX_RESULT_TEXT: process.env.NANOCLAW_CODEX_RESULT_TEXT,
};

async function collectOutputs(iterable) {
  const outputs = [];
  for await (const output of iterable) {
    outputs.push(output);
  }
  return outputs;
}

async function loadRunnerModule() {
  return import(`${runnerModuleUrl}?t=${Date.now()}-${Math.random()}`);
}

function writeFakeCodexBinary(scriptPath) {
  fs.writeFileSync(
    scriptPath,
    `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');

const recordPath = process.env.NANOCLAW_CODEX_RECORD_FILE;
const configPath = path.join(process.env.CODEX_HOME, 'config.toml');
const authPath = path.join(process.env.CODEX_HOME, 'auth.json');
const agentsPath = path.join(process.cwd(), 'AGENTS.md');
const record = {
  argv: process.argv.slice(2),
  cwd: process.cwd(),
  codexHome: process.env.CODEX_HOME,
  config: fs.existsSync(configPath) ? fs.readFileSync(configPath, 'utf8') : null,
  authCache: fs.existsSync(authPath) ? fs.readFileSync(authPath, 'utf8') : null,
  groupAgents: fs.existsSync(agentsPath) ? fs.readFileSync(agentsPath, 'utf8') : null,
};
fs.writeFileSync(recordPath, JSON.stringify(record, null, 2));

if (process.env.NANOCLAW_CODEX_EMIT_THREAD_STARTED === '1') {
  console.log(JSON.stringify({ type: 'thread.started', thread_id: 'codex-session-next' }));
}

console.log(JSON.stringify({
  type: 'item.completed',
  item: {
    id: 'item_1',
    type: 'agent_message',
    text: process.env.NANOCLAW_CODEX_RESULT_TEXT || 'codex result',
  },
}));
console.log(JSON.stringify({
  type: 'turn.completed',
  usage: {
    input_tokens: 1,
    cached_input_tokens: 0,
    output_tokens: 1,
  },
}));
`,
    { mode: 0o755 },
  );
}

function resetFixture({
  groupAgents = '# Group Memory\n',
  globalAgents = null,
} = {}) {
  fs.rmSync(sharedGroupDir, { recursive: true, force: true });
  fs.rmSync(sharedGlobalDir, { recursive: true, force: true });
  fs.rmSync(sharedCodexHomeDir, { recursive: true, force: true });
  fs.rmSync(sharedRecordPath, { force: true });
  fs.mkdirSync(sharedGroupDir, { recursive: true });
  fs.mkdirSync(sharedGlobalDir, { recursive: true });
  fs.mkdirSync(sharedCodexHomeDir, { recursive: true });
  fs.writeFileSync(path.join(sharedGroupDir, 'AGENTS.md'), groupAgents);
  if (globalAgents != null) {
    fs.writeFileSync(path.join(sharedGlobalDir, 'AGENT.md'), globalAgents);
  }
}

writeFakeCodexBinary(sharedFakeCodexPath);
process.env.NANOCLAW_WORKSPACE_GROUP_DIR = sharedGroupDir;
process.env.NANOCLAW_WORKSPACE_GLOBAL_DIR = sharedGlobalDir;
process.env.NANOCLAW_CODEX_HOME_DIR = sharedCodexHomeDir;
process.env.NANOCLAW_CODEX_BIN = sharedFakeCodexPath;
process.env.NANOCLAW_CODEX_RECORD_FILE = sharedRecordPath;

test.after(() => {
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  fs.rmSync(sharedTempRoot, { recursive: true, force: true });
});

test('built-in Codex provider starts a new conversation with AGENTS memory, global memory, and MCP config', async () => {
  // Arrange
  resetFixture({
    groupAgents: '# Group Memory\nUse the group instructions.\n',
    globalAgents: '# Global Memory\nUse the global instructions.\n',
  });
  process.env.NANOCLAW_CODEX_EMIT_THREAD_STARTED = '1';
  process.env.NANOCLAW_CODEX_RESULT_TEXT = 'codex scheduled result';

  const { dispatchProviderInput } = await loadRunnerModule();

  // Act
  const outputs = await collectOutputs(
    dispatchProviderInput(
      {
        providerId: 'codex',
        runtimeInput: {
          prompt: 'Run the scheduled task.',
          groupFolder: 'codex-group',
          chatJid: 'codex@g.us',
          isMain: false,
          isScheduledTask: true,
        },
      },
      {
        mcpServerPath: '/app/dist/ipc-mcp-stdio.js',
      },
    ),
  );
  const record = JSON.parse(fs.readFileSync(sharedRecordPath, 'utf8'));

  // Assert
  assert.deepEqual(outputs, [
    {
      status: 'success',
      result: 'codex scheduled result',
      newSessionId: 'codex-session-next',
    },
  ]);
  assert.equal(record.cwd, sharedGroupDir);
  assert.equal(record.codexHome, sharedCodexHomeDir);
  assert.equal(
    record.groupAgents,
    '# Group Memory\nUse the group instructions.\n',
  );
  assert.deepEqual(record.argv.slice(0, 6), [
    'exec',
    '--json',
    '--skip-git-repo-check',
    '--dangerously-bypass-approvals-and-sandbox',
    '--add-dir',
    sharedGlobalDir,
  ]);
  assert.match(
    record.argv.at(-1),
    /^\[SCHEDULED TASK - The following message was sent automatically and is not coming directly from the user or group\.\]\n\nRun the scheduled task\.$/,
  );
  assert.match(
    record.config,
    new RegExp(
      `model_instructions_file = ${JSON.stringify(
        path.join(sharedGlobalDir, 'AGENT.md'),
      ).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`,
    ),
  );
  assert.match(record.config, /forced_login_method = "chatgpt"/);
  assert.match(record.config, /cli_auth_credentials_store = "file"/);
  assert.match(record.config, /\[mcp_servers\.nanoclaw\]/);
  assert.match(record.config, /command = "node"/);
  assert.match(record.config, /args = \["\/app\/dist\/ipc-mcp-stdio\.js"\]/);
  assert.match(record.config, /NANOCLAW_CHAT_JID = "codex@g\.us"/);
  assert.match(record.config, /NANOCLAW_GROUP_FOLDER = "codex-group"/);
  assert.match(record.config, /NANOCLAW_IS_MAIN = "0"/);
});

test('built-in Codex provider resumes an existing conversation with the same dispatcher path', async () => {
  // Arrange
  resetFixture({
    groupAgents: '# Group Memory\n',
  });
  delete process.env.NANOCLAW_CODEX_EMIT_THREAD_STARTED;
  process.env.NANOCLAW_CODEX_RESULT_TEXT = 'codex resumed result';

  const { dispatchProviderInput } = await loadRunnerModule();

  // Act
  const outputs = await collectOutputs(
    dispatchProviderInput(
      {
        providerId: 'codex',
        runtimeInput: {
          prompt: 'Continue the existing task.',
          sessionId: 'codex-session-existing',
          groupFolder: 'codex-group',
          chatJid: 'codex@g.us',
          isMain: true,
        },
      },
      {
        mcpServerPath: '/app/dist/ipc-mcp-stdio.js',
      },
    ),
  );
  const record = JSON.parse(fs.readFileSync(sharedRecordPath, 'utf8'));

  // Assert
  assert.deepEqual(outputs, [
    {
      status: 'success',
      result: 'codex resumed result',
      newSessionId: 'codex-session-existing',
    },
  ]);
  assert.deepEqual(record.argv.slice(0, 5), [
    'exec',
    'resume',
    '--json',
    '--skip-git-repo-check',
    '--dangerously-bypass-approvals-and-sandbox',
  ]);
  assert.equal(record.argv.at(-2), 'codex-session-existing');
  assert.equal(record.argv.at(-1), 'Continue the existing task.');
  assert.equal(record.config.includes('model_instructions_file'), false);
  assert.match(record.config, /forced_login_method = "chatgpt"/);
  assert.match(record.config, /cli_auth_credentials_store = "file"/);
});
