/**
 * LinkedIn Automation — One-time Login Setup
 *
 * Run this interactively ONCE to log in to LinkedIn.
 * Session is saved to data/li-browser-profile/ for all future automation.
 *
 * Usage:
 *   npx dotenv -e .env -- npx tsx .claude/skills/linkedin-automation/scripts/setup.ts
 */

import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';
import { config, cleanupLockFiles } from '../lib/browser.js';

async function setup() {
  console.log('🔗 LinkedIn Authentication Setup');
  console.log('──────────────────────────────────');

  // Ensure data dir exists
  fs.mkdirSync(config.browserDataDir, { recursive: true });
  cleanupLockFiles();

  const context = await chromium.launchPersistentContext(config.browserDataDir, {
    executablePath:    config.chromePath,
    headless:          true,
    viewport:          config.viewport,
    args:              config.chromeArgs,
    ignoreDefaultArgs: config.chromeIgnoreDefaultArgs,
  });

  const page = context.pages()[0] || await context.newPage();

  console.log('→ Navigating to LinkedIn login...');
  await page.goto(config.urls.login, { waitUntil: 'domcontentloaded' });

  // Auto-fill credentials if provided
  const email    = process.env.LINKEDIN_EMAIL;
  const password = process.env.LINKEDIN_PASSWORD;

  if (email && password) {
    console.log(`→ Auto-filling credentials for ${email}...`);
    try {
      await page.waitForSelector(config.selectors.emailInput, { timeout: config.timeouts.elementWait });
      await page.fill(config.selectors.emailInput, email);
      await page.fill(config.selectors.passwordInput, password);
      await page.waitForTimeout(1000);
      await page.click(config.selectors.loginBtn);
      console.log('→ Credentials submitted. Waiting for login...');
    } catch (err) {
      console.log('⚠ Could not auto-fill credentials — please log in manually in the browser window.');
    }
  } else {
    console.log('ℹ No credentials in .env — please log in manually in the browser window.');
  }

  console.log('⏳ Waiting for LinkedIn to redirect after login...');

  // In headless mode, poll for the feed URL instead of waiting for user input
  let currentUrl = page.url();
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    currentUrl = page.url();
    if (currentUrl.includes('/feed') || currentUrl.includes('/mynetwork') || currentUrl.includes('/in/')) break;
    await page.waitForTimeout(1500);
  }
  currentUrl = page.url();
  if (currentUrl.includes('/feed') || currentUrl.includes('/in/') || currentUrl.includes('/mynetwork')) {
    console.log('✓ Login detected!');

    // Save auth marker
    const authData = {
      authenticated: true,
      email: email || 'unknown',
      savedAt: new Date().toISOString(),
    };
    fs.mkdirSync(path.dirname(config.authPath), { recursive: true });
    fs.writeFileSync(config.authPath, JSON.stringify(authData, null, 2));
    console.log(`✓ Auth state saved to: ${config.authPath}`);
  } else {
    console.error(`✗ Login not confirmed. Current URL: ${currentUrl}`);
    console.error('  Please try again and make sure you are fully logged in before pressing Enter.');
    process.exit(1);
  }

  await context.close();
  console.log('✓ Setup complete! LinkedIn automation is ready.');
}

setup().catch(err => {
  console.error('Setup failed:', err);
  process.exit(1);
});
