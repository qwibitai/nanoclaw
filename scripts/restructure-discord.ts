/**
 * One-time Discord server restructuring script.
 * Creates categories, per-agent channels, moves existing channels,
 * and updates NanoClaw's registered_groups DB.
 *
 * Run from /root/nanoclaw/:
 *   npx tsx scripts/restructure-discord.ts
 */

import {
  Client,
  GatewayIntentBits,
  ChannelType,
  PermissionFlagsBits,
  type CategoryChannel,
  type TextChannel,
} from 'discord.js';
import Database from 'better-sqlite3';
import { copyFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Config ──────────────────────────────────────────────────────────────

const GUILD_ID = '1471976034609004669';
const DB_PATH = path.join(__dirname, '..', 'store', 'messages.db');

// Read token from .env or process.env
const DISCORD_TOKEN = process.env.DISCORD_TOKEN || process.env.DISCORD_BOT_TOKEN;
if (!DISCORD_TOKEN) {
  console.error('ERROR: DISCORD_TOKEN not set. Export it or add to .env');
  process.exit(1);
}

// Existing channel IDs
const EXISTING_CHANNELS = {
  neoBrain:   '1475846814233002055',
  tradingLog: '1474710636049989784',
  alerts:     '1476665384005271755',
  portfolio:  '1476665385213497578',
  generale:   '1471976035204600028',
} as const;

// Categories to create
const CATEGORIES = [
  { name: '📈 Trading',  position: 0 },
  { name: '🌐 Kosmoy',   position: 1 },
  { name: '🏠 Aibilia',   position: 2 },
  { name: '💼 Biz Papà',  position: 3 },
  { name: '🔧 Extra',     position: 4 },
] as const;

// New per-agent channels under Trading
const NEW_AGENT_CHANNELS = [
  { name: 'strategies',   topic: 'NEO Strategies agent output' },
  { name: 'risk',         topic: 'NEO Risk agent output' },
  { name: 'intelligence', topic: 'NEO Intelligence agent output' },
  { name: 'x-intel',      topic: 'NEO X Intelligence agent output' },
  { name: 'learner',      topic: 'NEO Learner agent output' },
  { name: 'housekeeping', topic: 'NEO Housekeeping agent output' },
] as const;

// Agent-to-channel mapping for DB updates
const AGENT_CHANNEL_MAP: Record<string, string> = {
  'scheduled:neo-strategies':  'strategies',
  'scheduled:neo-risk-agent':  'risk',
  'scheduled:neo-intelligence': 'intelligence',
  'scheduled:neo-x-intel':     'x-intel',
  'scheduled:neo-learner':     'learner',
  'scheduled:neo-housekeeping': 'housekeeping',
};

// ── Main ────────────────────────────────────────────────────────────────

async function main() {
  console.log('=== NEO Discord Restructuring ===\n');

  // ── Phase A: Discord API ──────────────────────────────────────────────

  console.log('Phase A: Discord API operations\n');

  const client = new Client({ intents: [GatewayIntentBits.Guilds] });
  await client.login(DISCORD_TOKEN);
  console.log(`  Bot logged in as ${client.user!.tag}`);

  const guild = await client.guilds.fetch(GUILD_ID);
  console.log(`  Guild: ${guild.name} (${guild.id})`);

  // Check permissions
  const botMember = await guild.members.fetch(client.user!.id);
  if (!botMember.permissions.has(PermissionFlagsBits.ManageChannels)) {
    console.error('  ERROR: Bot lacks ManageChannels permission. Aborting.');
    client.destroy();
    process.exit(1);
  }
  console.log('  Bot has ManageChannels permission ✓');

  // Fetch all channels
  await guild.channels.fetch();

  // A1: Create categories
  const categoryMap: Record<string, CategoryChannel> = {};
  for (const cat of CATEGORIES) {
    const existing = guild.channels.cache.find(
      c => c.type === ChannelType.GuildCategory && c.name === cat.name
    );
    if (existing) {
      categoryMap[cat.name] = existing as CategoryChannel;
      console.log(`  Category "${cat.name}" already exists (${existing.id})`);
    } else {
      const created = await guild.channels.create({
        name: cat.name,
        type: ChannelType.GuildCategory,
        position: cat.position,
      });
      categoryMap[cat.name] = created;
      console.log(`  Created category "${cat.name}" (${created.id})`);
    }
  }

  const tradingCat = categoryMap['📈 Trading'];
  const extraCat = categoryMap['🔧 Extra'];

  // A2: Move existing trading channels into Trading category
  const tradingChannelIds = [
    EXISTING_CHANNELS.neoBrain,
    EXISTING_CHANNELS.tradingLog,
    EXISTING_CHANNELS.alerts,
    EXISTING_CHANNELS.portfolio,
  ];

  for (const channelId of tradingChannelIds) {
    try {
      const channel = guild.channels.cache.get(channelId);
      if (channel && channel.type === ChannelType.GuildText) {
        if (channel.parentId !== tradingCat.id) {
          await (channel as TextChannel).setParent(tradingCat.id, { lockPermissions: false });
          console.log(`  Moved #${channel.name} → Trading`);
        } else {
          console.log(`  #${channel.name} already in Trading`);
        }
      } else {
        console.warn(`  Channel ${channelId} not found or not text channel`);
      }
    } catch (err: any) {
      console.error(`  Failed to move channel ${channelId}: ${err.message}`);
    }
  }

  // A3: Move #generale to Extra
  try {
    const generaleChannel = guild.channels.cache.get(EXISTING_CHANNELS.generale);
    if (generaleChannel && generaleChannel.type === ChannelType.GuildText) {
      if (generaleChannel.parentId !== extraCat.id) {
        await (generaleChannel as TextChannel).setParent(extraCat.id, { lockPermissions: false });
        console.log(`  Moved #${generaleChannel.name} → Extra`);
      } else {
        console.log(`  #generale already in Extra`);
      }
    }
  } catch (err: any) {
    console.error(`  Failed to move #generale: ${err.message}`);
  }

  // A4: Create new per-agent channels under Trading
  const newChannelIds: Record<string, string> = {};

  for (const ch of NEW_AGENT_CHANNELS) {
    const existing = guild.channels.cache.find(
      c => c.type === ChannelType.GuildText && c.name === ch.name && c.parentId === tradingCat.id
    );
    if (existing) {
      newChannelIds[ch.name] = existing.id;
      console.log(`  #${ch.name} already exists (${existing.id})`);
    } else {
      const created = await guild.channels.create({
        name: ch.name,
        type: ChannelType.GuildText,
        parent: tradingCat.id,
        topic: ch.topic,
      });
      newChannelIds[ch.name] = created.id;
      console.log(`  Created #${ch.name} (${created.id})`);
    }
  }

  // A5: Create #general placeholders in other categories
  for (const catName of ['🌐 Kosmoy', '🏠 Aibilia', '💼 Biz Papà']) {
    const cat = categoryMap[catName];
    const existing = guild.channels.cache.find(
      c => c.type === ChannelType.GuildText && c.name === 'general' && c.parentId === cat.id
    );
    if (!existing) {
      const created = await guild.channels.create({
        name: 'general',
        type: ChannelType.GuildText,
        parent: cat.id,
        topic: `General channel for ${catName.replace(/^.\s/, '')}`,
      });
      console.log(`  Created #general under ${catName} (${created.id})`);
    } else {
      console.log(`  #general already exists under ${catName}`);
    }
  }

  console.log('\n  Discord API operations complete ✓\n');

  // ── Phase B: SQLite DB updates ────────────────────────────────────────

  console.log('Phase B: Database updates\n');

  // Backup
  const backupPath = DB_PATH.replace('.db', `.db.backup-${Date.now()}`);
  copyFileSync(DB_PATH, backupPath);
  console.log(`  Database backed up → ${backupPath}`);

  const db = new Database(DB_PATH);

  // B1: Register new channels as groups (so NanoClaw can send to them)
  const insertStmt = db.prepare(
    `INSERT OR IGNORE INTO registered_groups (jid, name, folder, trigger_pattern, added_at, container_config, requires_trigger)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  );

  for (const ch of NEW_AGENT_CHANNELS) {
    const channelId = newChannelIds[ch.name];
    if (!channelId) continue;

    const jid = `dc:${channelId}`;
    const name = `NEO #${ch.name}`;
    const folder = `neo-${ch.name}-ch`;
    const now = new Date().toISOString();

    insertStmt.run(jid, name, folder, '@Neo\\b', now, '{}', 1);
    console.log(`  Registered ${jid} → ${name}`);
  }

  // B2: Update each scheduled agent's allowedOutputJids
  const selectStmt = db.prepare('SELECT container_config FROM registered_groups WHERE jid = ?');
  const updateStmt = db.prepare('UPDATE registered_groups SET container_config = ? WHERE jid = ?');

  const alertsJid = `dc:${EXISTING_CHANNELS.alerts}`;

  for (const [agentJid, channelName] of Object.entries(AGENT_CHANNEL_MAP)) {
    const channelId = newChannelIds[channelName];
    if (!channelId) {
      console.warn(`  Skipping ${agentJid}: channel #${channelName} not created`);
      continue;
    }

    const row = selectStmt.get(agentJid) as { container_config: string } | undefined;
    if (!row) {
      console.warn(`  Agent ${agentJid} not found in DB — skipping`);
      continue;
    }

    const config = JSON.parse(row.container_config || '{}');
    const dedicatedJid = `dc:${channelId}`;

    // Dedicated channel first, alerts as secondary
    config.allowedOutputJids = [dedicatedJid, alertsJid];

    updateStmt.run(JSON.stringify(config), agentJid);
    console.log(`  Updated ${agentJid} → outputs: [${dedicatedJid}, ${alertsJid}]`);
  }

  // Also update chats table so NanoClaw recognizes the new channels
  const upsertChat = db.prepare(
    `INSERT OR REPLACE INTO chats (jid, name, channel, is_group) VALUES (?, ?, ?, ?)`
  );
  for (const ch of NEW_AGENT_CHANNELS) {
    const channelId = newChannelIds[ch.name];
    if (!channelId) continue;
    upsertChat.run(`dc:${channelId}`, `NEO #${ch.name}`, 'discord', 1);
  }

  console.log('\n  Database updates complete ✓\n');

  // ── Phase C: Verification ─────────────────────────────────────────────

  console.log('Phase C: Verification\n');

  // Print registered_groups
  const allGroups = db.prepare(
    'SELECT jid, name, folder, container_config FROM registered_groups ORDER BY jid'
  ).all() as Array<{ jid: string; name: string; folder: string; container_config: string }>;

  console.log('  Registered Groups:');
  for (const g of allGroups) {
    const config = JSON.parse(g.container_config || '{}');
    const outputs = config.allowedOutputJids || [];
    console.log(`    ${g.jid} | ${g.name} | folder=${g.folder} | outputs=${JSON.stringify(outputs)}`);
  }

  // Print Discord channel structure
  await guild.channels.fetch(); // refresh
  console.log('\n  Discord Channel Structure:');
  const categories = guild.channels.cache
    .filter(c => c.type === ChannelType.GuildCategory)
    .sort((a, b) => a.position - b.position);

  for (const [, cat] of categories) {
    console.log(`\n  ${cat.name}:`);
    const children = guild.channels.cache
      .filter(c => c.parentId === cat.id)
      .sort((a, b) => a.position - b.position);
    for (const [, ch] of children) {
      console.log(`    #${ch.name} (dc:${ch.id})`);
    }
  }

  // Uncategorized channels
  const uncategorized = guild.channels.cache.filter(
    c => c.type === ChannelType.GuildText && !c.parentId
  );
  if (uncategorized.size > 0) {
    console.log('\n  Uncategorized:');
    for (const [, ch] of uncategorized) {
      console.log(`    #${ch.name} (dc:${ch.id})`);
    }
  }

  db.close();
  client.destroy();

  console.log('\n=== Done. NanoClaw NOT restarted — changes take effect on next agent run. ===');
}

main().catch(err => {
  console.error('FATAL:', err);
  process.exit(1);
});
