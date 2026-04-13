import { initDatabase, setRegisteredGroup } from '../src/db.js';
import { readEnvFile } from '../src/env.js';
import { resolveGroupFolderPath } from '../src/group-folder.js';
import fs from 'fs';
import path from 'path';

const env = readEnvFile(['DISCORD_BOT_TOKEN', 'DISCORD_GUILD_ID']);
const DISCORD_TOKEN = process.env.DISCORD_BOT_TOKEN || env.DISCORD_BOT_TOKEN;
const DISCORD_GUILD_ID = process.env.DISCORD_GUILD_ID || env.DISCORD_GUILD_ID;

if (!DISCORD_TOKEN || !DISCORD_GUILD_ID) {
  console.error('Set DISCORD_BOT_TOKEN and DISCORD_GUILD_ID in .env');
  process.exit(1);
}

async function main() {
  initDatabase();

  // Create Discord channel via REST API
  const res = await fetch(`https://discord.com/api/v10/guilds/${DISCORD_GUILD_ID}/channels`, {
    method: 'POST',
    headers: {
      Authorization: `Bot ${DISCORD_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      name: 'research-partner',
      type: 0, // GUILD_TEXT
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    console.error(`Failed to create channel: ${res.status} ${err}`);
    process.exit(1);
  }

  const channel = (await res.json()) as { id: string; name: string };
  const jid = `dc:${channel.id}`;
  const folder = 'research-partner';

  // Create group folder
  const groupDir = resolveGroupFolderPath(folder);
  fs.mkdirSync(path.join(groupDir, 'logs'), { recursive: true });

  // Seed CLAUDE.md
  const claudeMdPath = path.join(groupDir, 'CLAUDE.md');
  if (!fs.existsSync(claudeMdPath)) {
    fs.writeFileSync(
      claudeMdPath,
      '# Research Partner\n\nMessages in this channel are dispatched to the Research Partner (Letta) service, not to a container agent.\n',
    );
  }

  // Register group
  setRegisteredGroup(jid, {
    name: 'Shoggoth #research-partner',
    folder,
    trigger: '@Shoggoth',
    added_at: new Date().toISOString(),
    requiresTrigger: false,
    dispatch: 'rp_service',
  });

  console.log(`Registered #research-partner channel: ${jid}`);
  console.log(`Group folder: ${groupDir}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
