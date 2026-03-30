/**
 * Register a group folder to a Telegram chat ID.
 *
 * Usage: npx tsx scripts/register-group.ts <chat-jid> <folder> [trigger]
 *
 * Example:
 *   npx tsx scripts/register-group.ts tg:123456789 idea-maze
 */

import { setRegisteredGroup } from '../src/db.js';

const [jid, folder, trigger] = process.argv.slice(2);

if (!jid || !folder) {
  console.error('Usage: npx tsx scripts/register-group.ts <tg:CHAT_ID> <folder> [trigger]');
  process.exit(1);
}

setRegisteredGroup(jid, {
  jid,
  name: folder,
  folder,
  trigger: trigger ?? `@${folder}`,
  added_at: new Date().toISOString(),
  requiresTrigger: false,
});

console.log(`Registered: ${jid} → groups/${folder} (trigger: "${trigger ?? `@${folder}`}")`);
