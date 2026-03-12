// One-time script to register a group directly into the DB
import { initDatabase, setRegisteredGroup } from '../src/db.js';

initDatabase();

setRegisteredGroup('tg:-1003863540828', {
  name: 'Gentech Agency',
  folder: 'telegram_gentech-agency',
  trigger: '@Andy',
  added_at: new Date().toISOString(),
  requiresTrigger: false,
  isMain: false,
});

console.log('Group registered: Gentech Agency (tg:-1003863540828)');
