/**
 * X Integration - Configuration
 *
 * All environment-specific settings in one place.
 * Override via environment variables or modify defaults here.
 */

import path from 'path';
import { loadEnv } from './env.js';

loadEnv();

// Project root
const PROJECT_ROOT = process.cwd();

/**
 * Configuration object with all settings
 */
export const config = {
  // ==========================================================================
  // Browser Settings
  // ==========================================================================

  /** Chrome executable path. Override: CHROME_PATH env var */
  chromePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',

  /** Browser profile directory for persistent login sessions */
  browserDataDir: path.join(PROJECT_ROOT, 'data', 'x-browser-profile'),

  /** Auth state marker file - indicates X login is complete */
  authPath: path.join(PROJECT_ROOT, 'data', 'x-auth.json'),

  /** Browser viewport dimensions */
  viewport: { width: 1280, height: 800 },

  /** Chrome launch options */
  chrome: {
    args: [
      '--disable-blink-features=AutomationControlled', // Avoid bot detection
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-sync',
    ],
    ignoreDefaultArgs: ['--enable-automation'],
  },

  // ==========================================================================
  // Timeouts (milliseconds)
  // ==========================================================================

  timeouts: {
    /** Page navigation timeout */
    navigation: 30000,

    /** Wait for element to appear */
    elementWait: 5000,

    /** Wait after page load or form submission */
    loadWait: 3000,

    /** Pause after click or fill actions */
    actionDelay: 1000,

    /** Brief pause for focus/animations */
    shortPause: 500,
  },

  // ==========================================================================
  // X Platform Limits
  // ==========================================================================

  limits: {
    /** Maximum tweet/reply length */
    tweetMaxLength: 280,
  },

  // ==========================================================================
  // X Page Selectors
  // ==========================================================================

  selectors: {
    /** Tweet article container */
    tweet: 'article[data-testid="tweet"]',

    /** Tweet compose textarea */
    tweetTextarea: '[data-testid="tweetTextarea_0"]',

    /** Modal dialog container */
    modalDialog: '[role="dialog"][aria-modal="true"]',

    /** Account switcher (indicates logged in) */
    accountSwitcher: '[data-testid="SideNav_AccountSwitcher_Button"]',

    /** Username input on login page */
    usernameInput: 'input[autocomplete="username"]',

    /** Tweet timestamp link (contains time element, links to tweet status) */
    tweetTimestampLink: 'a[href*="/status/"] time',

    /** Action buttons */
    buttons: {
      postInline: '[data-testid="tweetButtonInline"]',
      postDialog: '[data-testid="tweetButton"]',
      like: '[data-testid="like"]',
      unlike: '[data-testid="unlike"]',
      retweet: '[data-testid="retweet"]',
      unretweet: '[data-testid="unretweet"]',
      retweetConfirm: '[data-testid="retweetConfirm"]',
      reply: '[data-testid="reply"]',
    },
  },
};