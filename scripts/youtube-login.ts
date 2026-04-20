import os from 'os';
import path from 'path';
import readline from 'readline/promises';

import { chromium } from 'playwright';

function getProfileDir(): string {
  return path.join(
    os.homedir(),
    '.config',
    'nanoclaw',
    'youtube-chrome-profile',
  );
}

function hasAuthCookies(cookies: { name: string }[]): boolean {
  const names = new Set(cookies.map((c) => c.name));
  return (
    names.has('SAPISID') ||
    names.has('__Secure-3PSID') ||
    names.has('__Secure-1PSID')
  );
}

async function main(): Promise<void> {
  const profileDir = getProfileDir();
  const context = await chromium.launchPersistentContext(profileDir, {
    headless: false,
    viewport: { width: 1440, height: 900 },
  });
  const page = await context.newPage();
  await page.goto('https://www.youtube.com/feed/history', {
    waitUntil: 'domcontentloaded',
  });
  console.log(`Opened browser with persistent profile: ${profileDir}`);
  console.log('Log into Google/YouTube in the opened browser window.');
  console.log('After login is complete, press Enter here to verify cookies.');

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  await rl.question('Press Enter to continue...');
  rl.close();

  const cookies = await context.cookies(['https://www.youtube.com']);
  const loggedIn = hasAuthCookies(cookies);
  if (!loggedIn) {
    throw new Error(
      'Login cookies were not detected. Please run the script again and complete login first.',
    );
  }

  console.log('✅ Login cookies detected. YouTube profile setup complete.');
  await context.close();
}

main().catch((err) => {
  console.error(`❌ youtube-login failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
