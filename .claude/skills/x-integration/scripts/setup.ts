#!/usr/bin/env npx tsx
/**
 * X Integration - Authentication Setup
 * Usage: npx tsx setup.ts
 *
 * Opens browser for manual login and auto-detects when login is complete.
 */

import fs from 'fs';
import path from 'path';
import { getBrowserContext } from '../lib/browser.js';
import { checkLoginStatus } from '../lib/utils.js';
import { config } from '../lib/config.js';

const POLL_INTERVAL_MS = 3000;
const MAX_WAIT_MINUTES = 5;
const MAX_WAIT_MS = MAX_WAIT_MINUTES * 60 * 1000;

async function setup(): Promise<void> {
  console.log('=== X (Twitter) Authentication Setup ===\n');
  console.log('This will open Chrome for you to log in to X.');
  console.log('Your login session will be saved for automated interactions.\n');
  console.log(`Chrome path: ${config.chromePath}`);
  console.log(`Profile dir: ${config.browserDataDir}\n`);

  // Ensure directories exist
  fs.mkdirSync(path.dirname(config.authPath), { recursive: true });
  fs.mkdirSync(config.browserDataDir, { recursive: true });

  console.log('Launching browser...\n');

  const context = await getBrowserContext(true); // skipAuthCheck = true
  const page = context.pages()[0] || await context.newPage();

  // Navigate to login page
  await page.goto('https://x.com/login');

  console.log('Please log in to X in the browser window.');
  console.log('Waiting for login to complete (auto-detecting)...\n');

  // Poll for login completion
  let elapsed = 0;
  let loggedIn = false;

  while (elapsed < MAX_WAIT_MS) {
    await page.waitForTimeout(POLL_INTERVAL_MS);
    elapsed += POLL_INTERVAL_MS;

    // Check if we're on the home page or still on login
    const url = page.url();
    if (url.includes('/home') || url === 'https://x.com/' || url === 'https://twitter.com/') {
      const status = await checkLoginStatus(page);
      if (status.loggedIn) {
        loggedIn = true;
        break;
      }
    }

    // Also try navigating to home to check
    if (elapsed % 15000 === 0) { // Every 15 seconds
      console.log('Still waiting for login...');
      try {
        await page.goto('https://x.com/home', { timeout: 10000 });
        await page.waitForTimeout(config.timeouts.loadWait);
        const status = await checkLoginStatus(page);
        if (status.loggedIn) {
          loggedIn = true;
          break;
        }
        // If not logged in, go back to login page
        if (status.onLoginPage) {
          await page.goto('https://x.com/login');
        }
      } catch {
        // Ignore navigation errors
      }
    }
  }

  if (loggedIn) {
    // Save auth marker
    fs.writeFileSync(config.authPath, JSON.stringify({
      authenticated: true,
      timestamp: new Date().toISOString()
    }, null, 2));

    console.log('\n✅ Authentication successful!');
    console.log(`Session saved to: ${config.browserDataDir}`);
    console.log('\nYou can now use X integration features.');
  } else {
    console.log(`\n❌ Login timed out after ${MAX_WAIT_MINUTES} minutes.`);
    console.log('Please run the setup again and complete the login.');
  }

  await context.close();
}

setup().catch(err => {
  console.error('Setup failed:', err.message);
  process.exit(1);
});