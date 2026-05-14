/**
 * X Integration - Configuration
 *
 * All environment-specific settings in one place.
 * Override via environment variables or modify defaults here.
 */

import path from 'path';
import { detectChromePath } from './chrome-detect.js';

// Project root - can be overridden for different deployments
const PROJECT_ROOT = process.env.NANOCLAW_ROOT || process.cwd();

/**
 * Configuration object with all settings
 */
export const config = {
  // Chrome executable path. Resolution: CHROME_PATH env > platform probe.
  // Throws at first access if no Chrome is installed — fail loud so the
  // user sees an install hint instead of a silent Playwright launch error.
  chromePath: detectChromePath(),

  // Browser profile directory for persistent login sessions
  browserDataDir: path.join(PROJECT_ROOT, 'data', 'x-browser-profile'),

  // Auth state marker file
  authPath: path.join(PROJECT_ROOT, 'data', 'x-auth.json'),

  // Browser viewport settings
  viewport: {
    width: 1280,
    height: 800,
  },

  // Timeouts (in milliseconds)
  timeouts: {
    navigation: 30000,
    elementWait: 5000,
    afterClick: 1000,
    afterFill: 1000,
    afterSubmit: 3000,
    pageLoad: 3000,
  },

  // X character limits + per-tool result caps
  limits: {
    tweetMaxLength: 280,
    /** Direct-message body cap (X allows up to 10,000 chars in DMs). */
    dmMaxLength: 10000,
    /** Cap on items returned by each read tool — protects against
     * runaway scrolls and stays comfortably under the 120s timeout. */
    readMax: 50,
    /** Cap on attached images per tweet (X UI allows 4). */
    mediaMaxPerTweet: 4,
  },

  // Pacing — minimum wall-clock spacing between sequential X actions.
  // Enforced by host.ts's pacedRun() mutex, NOT by per-script sleep
  // (sleep can't enforce delay across separate subprocess invocations).
  pacing: {
    actionDelayMs: 10000,
  },

  // Where script failures dump screenshots + DOM snapshots for debugging.
  failureDumpDir: path.join(PROJECT_ROOT, 'logs', 'x-failures'),

  // Chrome launch arguments
  chromeArgs: [
    '--disable-blink-features=AutomationControlled',
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-sync',
  ],

  // Args to ignore when launching Chrome
  chromeIgnoreDefaultArgs: ['--enable-automation'],
};

