import { Client, GatewayIntentBits, ChannelType } from 'discord.js';

async function main() {
  const client = new Client({ intents: [GatewayIntentBits.Guilds] });
  await client.login(process.env.DISCORD_TOKEN!);
  const guild = await client.guilds.fetch('1471976034609004669');
  await guild.channels.fetch();

  // Delete old NEO Trading category and its children
  const oldCat = guild.channels.cache.find(c => c.type === ChannelType.GuildCategory && c.name === 'NEO Trading');
  if (oldCat) {
    const kids = guild.channels.cache.filter(c => c.parentId === oldCat.id);
    for (const [,ch] of kids) {
      console.log('Deleting old channel: #' + ch.name + ' (' + ch.id + ')');
      await ch.delete('Cleanup old NEO Trading category');
    }
    console.log('Deleting category: ' + oldCat.name);
    await oldCat.delete('Cleanup old NEO Trading category');
  } else {
    console.log('No NEO Trading category found');
  }

  // Clean up empty default categories
  for (const name of ['Canali testuali', 'Canali vocali']) {
    const cat = guild.channels.cache.find(c => c.type === ChannelType.GuildCategory && c.name === name);
    if (cat) {
      const kids = guild.channels.cache.filter(c => c.parentId === cat.id);
      if (kids.size === 0) {
        console.log('Deleting empty category: ' + name);
        await cat.delete('Cleanup');
      } else {
        console.log(name + ' has ' + kids.size + ' children — keeping');
      }
    }
  }

  client.destroy();
  console.log('Cleanup done');
}

main().catch(err => { console.error(err); process.exit(1); });
