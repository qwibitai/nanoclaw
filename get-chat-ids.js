/**
 * Quick script to discover Telegram group chat IDs.
 * Run this, then send a message in each Telegram group.
 * It will print the chat ID for each group.
 */
import { Bot } from 'grammy';

const bots = [
  { name: 'Shinobu', token: '8781103733:AAFAexGkqpPUs0ktewZINF66wiJFm6ui5Tk' },
  { name: 'Homura (xiaomeiyan)', token: '8777223841:AAE3PqSjuT5VZGXEJfaZrx9-uvh5EcuyusE' },
  { name: 'Madoka (lumuyuan)', token: '8671666187:AAF40BuXPRpHnFUB1TSO-9QMJ2CpL4aqw9M' },
  { name: 'Nadi', token: '8766817891:AAGCd6tX0gTv-bcNoNOOVWHZjRgiY8PVb-4' },
  { name: 'Alice (ailisi)', token: '8525959326:AAFIs6y3szHjO5_frbxkNg9RMhjsUFV8F4E' },
  { name: 'Luno (luye)', token: '8742015314:AAECwuHJUZxUYBFk8atoqgq3OhNO8pk-1Sg' },
  { name: 'Elaina (yilianna)', token: '8703352641:AAF68cg-FiTm9nJ1jFDP6Mt1e4GmpS9-ZHw' },
];

const found = new Map();

console.log('=== Telegram Chat ID Discovery ===');
console.log('Send a message in each Telegram group. Chat IDs will appear here.');
console.log('Press Ctrl+C when all groups are discovered.\n');

for (const { name, token } of bots) {
  const bot = new Bot(token);

  bot.on('message', (ctx) => {
    const chatId = ctx.chat.id;
    const chatTitle = ctx.chat.title || ctx.chat.first_name || 'Unknown';
    const key = `${name}:${chatId}`;

    if (!found.has(key)) {
      found.set(key, true);
      console.log(`✅ ${name} → chat "${chatTitle}" → ID: ${chatId} → JID: tg:${chatId}`);
    }
  });

  bot.start({ drop_pending_updates: true });
  console.log(`🤖 ${name} bot started, waiting for messages...`);
}
