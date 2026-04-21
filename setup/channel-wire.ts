/**
 * Channel picker + wiring for setup:auto. Runs after the scratch CLI agent
 * has been renamed (see auto.ts) and offers the operator a real messaging
 * channel. Two tiers:
 *
 *  - Fully scripted (Telegram, WhatsApp native): install the adapter,
 *    restart the service so the new module loads, authenticate / pair,
 *    read the operator's user-id + chat platform-id out of the status
 *    block (Telegram) or store/auth/creds.json (WhatsApp), and invoke
 *    scripts/init-first-agent.ts with the operator + agent names captured
 *    pre-picker.
 *
 *  - Install + hand-off (other channels): run install-<channel>.sh, persist
 *    the names to .env (so a follow-up `/add-<channel>` can read them), and
 *    print the exact init-first-agent command with --display-name /
 *    --agent-name pre-filled plus a short hint on where to find the
 *    platform IDs. The operator finishes wiring after setup:auto exits.
 *
 * All readline prompts assume a TTY; auto.ts only calls us when stdio is
 * interactive.
 */
import { spawn, spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import readline from 'node:readline/promises';

type Names = { displayName: string; agentName: string };
type Tier = 'scripted' | 'handoff';
type Channel = {
  id: string;
  label: string;
  tier: Tier;
  findIdHint: string;
};

const CHANNELS: Channel[] = [
  { id: 'whatsapp', label: 'WhatsApp (native)', tier: 'scripted', findIdHint: '' },
  {
    id: 'whatsapp-cloud',
    label: 'WhatsApp Cloud (Meta official)',
    tier: 'handoff',
    findIdHint:
      'Your WABA + phone-number-id from business.facebook.com, plus the destination phone number. See /add-whatsapp-cloud.',
  },
  { id: 'telegram', label: 'Telegram', tier: 'scripted', findIdHint: '' },
  {
    id: 'slack',
    label: 'Slack',
    tier: 'handoff',
    findIdHint:
      'Right-click a channel > View channel details — ID at the bottom (C… for channels, D… for DMs). Your user-id is from your Slack profile (U…).',
  },
  {
    id: 'discord',
    label: 'Discord',
    tier: 'handoff',
    findIdHint:
      'Enable Developer Mode, right-click the server > Copy Server ID, then the channel > Copy Channel ID. Platform-id format: discord:{guildId}:{channelId}. User-id is your Discord user snowflake (right-click your name > Copy User ID).',
  },
  {
    id: 'imessage',
    label: 'iMessage',
    tier: 'handoff',
    findIdHint: 'Use the phone number (E.164) or Apple-ID email you want the agent to talk to. See /add-imessage.',
  },
  {
    id: 'teams',
    label: 'Teams',
    tier: 'handoff',
    findIdHint:
      'Tenant ID + team ID + channel ID from the Teams channel URL or admin center. See /add-teams.',
  },
  {
    id: 'matrix',
    label: 'Matrix',
    tier: 'handoff',
    findIdHint:
      'Element > room name > Settings > Advanced — the "Internal room ID" (starts with !) is the platform-id. Or use a #alias:homeserver alias. Your user-id is @handle:homeserver.',
  },
  {
    id: 'gchat',
    label: 'Google Chat',
    tier: 'handoff',
    findIdHint: 'Workspace ID + space ID from the Google Chat URL. See /add-gchat.',
  },
  {
    id: 'linear',
    label: 'Linear',
    tier: 'handoff',
    findIdHint: 'Issue identifier (e.g. ENG-123) as platform-id; your Linear user email as user-id. See /add-linear.',
  },
  {
    id: 'github',
    label: 'GitHub',
    tier: 'handoff',
    findIdHint:
      'Issue or PR URL — "owner/repo#N". Your user-id is your GitHub login. See /add-github.',
  },
  {
    id: 'webex',
    label: 'Webex',
    tier: 'handoff',
    findIdHint: 'Space ID (starts with Y2lzY29z…) from the Webex developer portal. See /add-webex.',
  },
  {
    id: 'resend',
    label: 'Resend (email)',
    tier: 'handoff',
    findIdHint: 'Destination email as platform-id; your own email as user-id. See /add-resend.',
  },
];

type Fields = Record<string, string>;

function parseStatus(stdout: string): Fields {
  const out: Fields = {};
  let inBlock = false;
  for (const line of stdout.split('\n')) {
    if (line.startsWith('=== NANOCLAW SETUP:')) {
      inBlock = true;
      continue;
    }
    if (line.startsWith('=== END ===')) {
      inBlock = false;
      continue;
    }
    if (!inBlock) continue;
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    if (key) out[key] = value;
  }
  return out;
}

function runInherit(cmd: string, args: string[]): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: 'inherit' });
    child.on('close', (code) => resolve(code ?? 1));
  });
}

function runCapturing(
  cmd: string,
  args: string[],
): Promise<{ code: number; fields: Fields }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ['inherit', 'pipe', 'inherit'] });
    let buf = '';
    child.stdout.on('data', (chunk: Buffer) => {
      const s = chunk.toString('utf-8');
      buf += s;
      process.stdout.write(s);
    });
    child.on('close', (code) => resolve({ code: code ?? 1, fields: parseStatus(buf) }));
  });
}

async function promptChannel(): Promise<Channel | null> {
  console.log('\n── channel ────────────────────────────────────');
  console.log('Pick a messaging channel to wire your agent to:');
  console.log('');
  CHANNELS.forEach((c, i) => {
    const tag = c.tier === 'scripted' ? '  (fully scripted)' : '';
    console.log(`  ${String(i + 1).padStart(2)}. ${c.label}${tag}`);
  });
  console.log('   0. Skip for now');
  console.log('');

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    for (;;) {
      const ans = (await rl.question('Choice: ')).trim().toLowerCase();
      if (!ans || ans === '0' || ans === 'skip' || ans === 's') return null;
      const asNum = Number(ans);
      if (Number.isInteger(asNum) && asNum >= 1 && asNum <= CHANNELS.length) {
        return CHANNELS[asNum - 1];
      }
      const byName = CHANNELS.find(
        (c) => c.id === ans || c.label.toLowerCase() === ans,
      );
      if (byName) return byName;
      console.log(`  Not a valid choice. Enter 1–${CHANNELS.length}, or 0 to skip.`);
    }
  } finally {
    rl.close();
  }
}

async function restartService(): Promise<void> {
  console.log('\n[setup:auto] Restarting service so the new channel adapter loads…');
  let ok = false;
  if (process.platform === 'darwin') {
    const uid = spawnSync('id', ['-u'], { encoding: 'utf-8' }).stdout.trim();
    const res = spawnSync('launchctl', ['kickstart', '-k', `gui/${uid}/com.nanoclaw`], {
      stdio: 'inherit',
    });
    ok = res.status === 0;
  } else if (process.platform === 'linux') {
    const res = spawnSync('systemctl', ['--user', 'restart', 'nanoclaw'], {
      stdio: 'inherit',
    });
    ok = res.status === 0;
  }
  if (!ok) {
    console.warn(
      '[setup:auto] Service restart failed — if pairing hangs, restart the service manually and retry.',
    );
  }
  // Brief settle so the adapter's polling loop is up before we try to pair.
  await new Promise((r) => setTimeout(r, 3000));
}

function persistNamesToEnv(names: Names): void {
  const envPath = path.resolve(process.cwd(), '.env');
  let text = '';
  try {
    text = fs.readFileSync(envPath, 'utf-8');
  } catch {
    // fresh file is fine
  }

  for (const [key, value] of [
    ['NANOCLAW_DISPLAY_NAME', names.displayName],
    ['NANOCLAW_AGENT_NAME', names.agentName],
  ] as const) {
    const line = `${key}=${JSON.stringify(value)}`;
    const rx = new RegExp(`^${key}=.*$`, 'm');
    if (rx.test(text)) {
      text = text.replace(rx, line);
    } else {
      if (text && !text.endsWith('\n')) text += '\n';
      text += line + '\n';
    }
  }
  fs.writeFileSync(envPath, text);
}

async function runInitFirstAgent(
  channel: string,
  userId: string,
  platformId: string,
  names: Names,
): Promise<boolean> {
  console.log('\n── init-first-agent ───────────────────────────');
  const code = await runInherit('pnpm', [
    'exec',
    'tsx',
    'scripts/init-first-agent.ts',
    '--channel',
    channel,
    '--user-id',
    userId,
    '--platform-id',
    platformId,
    '--display-name',
    names.displayName,
    '--agent-name',
    names.agentName,
  ]);
  if (code !== 0) {
    console.warn('[setup:auto] init-first-agent failed — you can re-run the command above manually.');
    return false;
  }
  console.log(
    `\n[setup:auto] Your agent is now available on ${channel}. Start chatting when you're ready.`,
  );
  return true;
}

async function wireTelegram(names: Names): Promise<void> {
  console.log('\n── install-telegram ───────────────────────────');
  const installCode = await runInherit('bash', ['setup/install-telegram.sh']);
  if (installCode !== 0) {
    console.warn('[setup:auto] Telegram install failed — skipping channel wiring.');
    return;
  }

  console.log(
    '\nIn Telegram, DM @BotFather: `/newbot` → pick a friendly name → username ending in "bot" → copy the token.',
  );
  console.log(
    'For groups: @BotFather → /mybots → your bot → Bot Settings → Group Privacy → Turn off.',
  );

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  let token: string;
  try {
    token = (await rl.question('\nPaste your bot token: ')).trim();
  } finally {
    rl.close();
  }
  if (!token) {
    console.warn('[setup:auto] No token provided — skipping channel wiring.');
    return;
  }

  const setEnvRes = await runCapturing('pnpm', [
    'exec',
    'tsx',
    'setup/index.ts',
    '--step',
    'set-env',
    '--',
    '--key',
    'TELEGRAM_BOT_TOKEN',
    '--value',
    token,
    '--sync-container',
  ]);
  if (setEnvRes.code !== 0 || setEnvRes.fields.STATUS !== 'success') {
    console.warn('[setup:auto] set-env failed — skipping channel wiring.');
    return;
  }

  await restartService();

  console.log(
    '\n── pair-telegram ──────────────────────────────\n' +
      '[setup:auto] A 4-digit code will appear below. Send it from the Telegram chat you want to register.',
  );
  const pairRes = await runCapturing('pnpm', [
    'exec',
    'tsx',
    'setup/index.ts',
    '--step',
    'pair-telegram',
    '--',
    '--intent',
    'main',
  ]);
  if (pairRes.code !== 0 || pairRes.fields.STATUS !== 'success') {
    console.warn(
      '[setup:auto] pair-telegram did not complete — adapter is installed but no chat is wired yet.',
    );
    return;
  }

  const platformId = pairRes.fields.PLATFORM_ID;
  const pairedUserId = pairRes.fields.PAIRED_USER_ID;
  if (!platformId || !pairedUserId) {
    console.warn(
      '[setup:auto] pair-telegram success block missing PLATFORM_ID / PAIRED_USER_ID — channel is installed but not wired.',
    );
    return;
  }

  await runInitFirstAgent('telegram', pairedUserId, platformId, names);
}

async function wireWhatsApp(names: Names): Promise<void> {
  console.log('\n── install-whatsapp ───────────────────────────');
  const installCode = await runInherit('bash', ['setup/install-whatsapp.sh']);
  if (installCode !== 0) {
    console.warn('[setup:auto] WhatsApp install failed — skipping channel wiring.');
    return;
  }

  await restartService();

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  let method: 'qr-terminal' | 'qr-browser' | 'pairing-code';
  let phone: string | undefined;
  try {
    console.log('\nAuth method:');
    console.log('  1. QR code in terminal');
    console.log('  2. QR code in browser (for remote / headless hosts)');
    console.log('  3. Pairing code (WhatsApp → Linked devices → Link with phone number)');
    const pick = (await rl.question('Choice [1]: ')).trim() || '1';
    if (pick === '2') {
      method = 'qr-browser';
    } else if (pick === '3') {
      method = 'pairing-code';
      phone = (await rl.question('Your phone number (digits only, E.164, no +): ')).trim();
      if (!phone) {
        console.warn('[setup:auto] No phone provided — skipping channel wiring.');
        return;
      }
    } else {
      method = 'qr-terminal';
    }
  } finally {
    rl.close();
  }

  console.log('\n── whatsapp-auth ──────────────────────────────');
  const args = [
    'exec',
    'tsx',
    'setup/index.ts',
    '--step',
    'whatsapp-auth',
    '--',
    '--method',
    method,
  ];
  if (phone) args.push('--phone', phone);
  const authRes = await runCapturing('pnpm', args);
  if (authRes.code !== 0 || authRes.fields.STATUS !== 'authenticated') {
    console.warn(
      '[setup:auto] WhatsApp auth did not complete — channel is installed but no chat is wired yet.',
    );
    return;
  }

  let jid: string;
  try {
    const credsPath = path.resolve(process.cwd(), 'store', 'auth', 'creds.json');
    const creds = JSON.parse(fs.readFileSync(credsPath, 'utf-8'));
    const rawMeId: string | undefined = creds?.me?.id;
    if (!rawMeId) throw new Error('me.id missing from creds.json');
    // me.id is `<phone>:<device>@s.whatsapp.net` — drop the device suffix so the
    // JID addresses the operator's own chat, not a specific linked device.
    const phoneOnly = rawMeId.split(':')[0].split('@')[0];
    if (!phoneOnly) throw new Error(`could not parse phone from me.id=${rawMeId}`);
    jid = `${phoneOnly}@s.whatsapp.net`;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(
      `[setup:auto] Authenticated but couldn't derive JID from store/auth/creds.json (${msg}) — channel is installed but not wired.`,
    );
    return;
  }

  await runInitFirstAgent('whatsapp', jid, jid, names);
}

async function wireHandoff(channel: Channel, names: Names): Promise<void> {
  console.log(`\n── install-${channel.id} ───────────────────────────`);
  const installCode = await runInherit('bash', [`setup/install-${channel.id}.sh`]);
  if (installCode !== 0) {
    console.warn(`[setup:auto] ${channel.label} install failed.`);
    return;
  }

  persistNamesToEnv(names);

  console.log(`\n[setup:auto] ${channel.label} adapter is installed.`);
  console.log('');
  console.log('To finish wiring you need two IDs from the platform:');
  console.log('  • your user-id');
  console.log('  • the chat / channel platform-id');
  if (channel.findIdHint) {
    console.log('');
    console.log(channel.findIdHint);
  }
  console.log(
    '\nOnce you have them (service restart may be needed so the adapter picks up credentials):',
  );
  console.log('');
  console.log(
    `  pnpm exec tsx scripts/init-first-agent.ts \\\n` +
      `    --channel ${channel.id} \\\n` +
      `    --user-id "<YOUR_USER_ID>" \\\n` +
      `    --platform-id "<CHAT_PLATFORM_ID>" \\\n` +
      `    --display-name ${JSON.stringify(names.displayName)} \\\n` +
      `    --agent-name ${JSON.stringify(names.agentName)}`,
  );
  console.log(
    `\nOr run \`/add-${channel.id}\` in Claude Code — it walks the credential + ID capture and calls init-first-agent for you. Your names are persisted to .env so the skill can pick them up.`,
  );
}

export async function runChannelWire(names: Names): Promise<void> {
  const choice = await promptChannel();
  if (!choice) {
    console.log(
      '[setup:auto] No channel wired. You can add one later via `/add-<channel>` in Claude Code.',
    );
    return;
  }

  if (choice.id === 'telegram') {
    await wireTelegram(names);
  } else if (choice.id === 'whatsapp') {
    await wireWhatsApp(names);
  } else {
    await wireHandoff(choice, names);
  }
}
