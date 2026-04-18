import Database from 'better-sqlite3';
import { createCorsair, slack } from 'corsair';
// Import only the plugins selected during setup:
// import { slack, github, linear, hubspot, posthog, resend, discord, tavily,
//          gmail, googlecalendar, googledrive, googlesheets, spotify } from 'corsair';
import { STORE_DIR } from './config.js';

export const db = new Database(`${STORE_DIR}/corsair.db`);

export const corsair = createCorsair({
  database: db,
  kek: process.env.CORSAIR_KEK!,
  plugins: [
    slack(),
    // ← Uncomment only the plugins you need
    // slack(), github(), linear(), hubspot(), posthog(), resend(), discord(), tavily(),
    // gmail(), googlecalendar(), googledrive(), googlesheets(), spotify(),
  ],
});
