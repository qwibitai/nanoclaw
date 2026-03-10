import Database from 'better-sqlite3';
import { createCorsair } from 'corsair';
import { linear, slack } from 'corsair/plugins';
import path from 'path';

import { STORE_DIR } from './config.js';
import { readEnvFile } from './env.js';

const { CORSAIR_KEK } = readEnvFile(['CORSAIR_KEK']);

const db = new Database(path.join(STORE_DIR, 'messages.db'));

export const corsair = createCorsair({
  plugins: [linear(), slack()],
  database: db as any,
  kek: process.env.CORSAIR_KEK ?? CORSAIR_KEK ?? '',
});

export type AppCorsair = typeof corsair;
