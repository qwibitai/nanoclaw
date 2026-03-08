#!/usr/bin/env node
const { spawnSync } = require('child_process');
const path = require('path');

const args = process.argv.slice(2);
const hasFlag = (flag) => args.includes(flag);
const valueFor = (flag) => {
  const index = args.indexOf(flag);
  return index === -1 ? '' : args[index + 1] || '';
};

if (hasFlag('--help') || args.length === 0) {
  console.log(`Register a chat in NanoClaw.

Usage:
  node scripts/register-chat.cjs --jid <jid> --name <name> --folder <folder> [options]

Required:
  --jid <jid>                 Chat ID, e.g. tg:123456789 or tg:-1001234567890
  --name <name>               Human-readable chat name
  --folder <folder>           Group folder name under groups/

Optional:
  --trigger <pattern>         Trigger pattern (defaults to @ASSISTANT_NAME or @Andy)
  --channel <name>            Channel name (default: telegram)
  --assistant-name <name>     Assistant name used to derive default trigger
  --no-trigger-required       Register as respond-to-all chat
  --is-main                   Register as main/admin chat

Examples:
  node scripts/register-chat.cjs \
    --jid tg:123456789 \
    --name "My DM" \
    --folder telegram_main \
    --assistant-name Andy \
    --no-trigger-required \
    --is-main

  node scripts/register-chat.cjs \
    --jid tg:-1001234567890 \
    --name "Family Group" \
    --folder telegram_family \
    --assistant-name Andy
`);
  process.exit(0);
}

const jid = valueFor('--jid');
const name = valueFor('--name');
const folder = valueFor('--folder');
const assistantName = valueFor('--assistant-name') || process.env.ASSISTANT_NAME || 'Andy';
const trigger = valueFor('--trigger') || `@${assistantName}`;
const channel = valueFor('--channel') || 'telegram';

if (!jid || !name || !folder) {
  console.error('Missing required args. Run with --help for usage.');
  process.exit(1);
}

const setupEntrypoint = path.join(process.cwd(), 'setup', 'index.ts');
const cliArgs = [
  'tsx',
  setupEntrypoint,
  '--step',
  'register',
  '--jid',
  jid,
  '--name',
  name,
  '--trigger',
  trigger,
  '--folder',
  folder,
  '--channel',
  channel,
  '--assistant-name',
  assistantName,
];

if (hasFlag('--no-trigger-required')) cliArgs.push('--no-trigger-required');
if (hasFlag('--is-main')) cliArgs.push('--is-main');

const result = spawnSync('npx', cliArgs, { stdio: 'inherit' });
if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}
process.exit(result.status ?? 0);
