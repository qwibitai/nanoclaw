/**
 * X Integration - Utility functions
 * Validation, UI interaction, and display helpers
 */

import { Page, Locator } from 'playwright';
import { ScriptResult } from './script.js';
import { config } from './config.js';
import { navigateTo } from './browser.js';

// Shorthand for selectors
const sel = config.selectors;
const btn = sel.buttons;

// ── Validation ──────────────────────────────────────────────────────────────

export function validateTweetUrl(tweetUrl: string | undefined): ScriptResult | null {
  if (!tweetUrl) {
    return { success: false, message: 'Please provide a tweet URL' };
  }
  return null;
}

export function validateContent(content: string | undefined, type = 'Tweet'): ScriptResult | null {
  if (!content || content.length === 0) {
    return { success: false, message: `${type} content cannot be empty` };
  }
  if (content.length > config.limits.tweetMaxLength) {
    return {
      success: false,
      message: `${type} exceeds ${config.limits.tweetMaxLength} character limit (current: ${content.length})`
    };
  }
  return null;
}

// ── UI interaction ──────────────────────────────────────────────────────────

export async function isButtonDisabled(button: Locator): Promise<boolean> {
  const ariaDisabled = await button.getAttribute('aria-disabled');
  return ariaDisabled === 'true';
}

export function getFirstTweet(page: Page): Locator {
  return page.locator(sel.tweet).first();
}

export async function clickTweetButton(tweet: Locator, selector: string, page: Page): Promise<void> {
  const button = tweet.locator(selector);
  await button.waitFor({ timeout: config.timeouts.elementWait });
  await button.click({ force: true });
  await page.waitForTimeout(config.timeouts.actionDelay);
}

export async function checkLoginStatus(page: Page): Promise<{ loggedIn: boolean; onLoginPage: boolean }> {
  const isLoggedIn = await page.locator(sel.accountSwitcher).isVisible().catch(() => false);
  if (isLoggedIn) {
    return { loggedIn: true, onLoginPage: false };
  }

  const onLoginPage = await page.locator(sel.usernameInput).isVisible().catch(() => false);
  return { loggedIn: false, onLoginPage };
}

// ── Dialog submit ───────────────────────────────────────────────────────────

export interface DialogSubmitOptions {
  page: Page;
  content: string;
  contentLabel: string;
}

export interface DialogSubmitResult {
  success: boolean;
  error?: string;
}

export async function fillDialogAndSubmit(options: DialogSubmitOptions): Promise<DialogSubmitResult> {
  const { page, content, contentLabel } = options;

  const dialog = page.locator(sel.modalDialog);
  await dialog.waitFor({ timeout: config.timeouts.elementWait });

  const textInput = dialog.locator(sel.tweetTextarea);
  await textInput.waitFor({ timeout: config.timeouts.elementWait });
  await textInput.click();
  await page.waitForTimeout(config.timeouts.shortPause);
  await textInput.type(content + ' ');  // Trailing space closes hashtag/mention popups
  await page.waitForTimeout(config.timeouts.actionDelay);

  const submitButton = dialog.locator(btn.postDialog);
  await submitButton.waitFor({ timeout: config.timeouts.elementWait });

  if (await isButtonDisabled(submitButton)) {
    return {
      success: false,
      error: `Submit button disabled. ${contentLabel} may be empty or exceed character limit.`
    };
  }

  await submitButton.click({ force: true });

  // Verify dialog closed (confirms submission)
  const dialogClosed = await dialog.waitFor({ state: 'hidden', timeout: config.timeouts.loadWait })
    .then(() => true)
    .catch(() => false);

  if (!dialogClosed) {
    return { success: false, error: 'Dialog still visible after submit — tweet may not have been posted.' };
  }

  return { success: true };
}

// ── Post verification ───────────────────────────────────────────────────────

export interface ProfileState {
  profilePath: string;
  username: string;
  urlsBefore: string[];
}

/**
 * Capture the user's profile state before posting.
 * Navigates to the user's profile "Replies" tab to snapshot current tweet URLs.
 * Must be called on a page where the left sidebar is visible.
 */
export async function captureProfileState(page: Page): Promise<ProfileState | null> {
  const profileLink = page.locator('a[data-testid="AppTabBar_Profile_Link"]');
  const profilePath = await profileLink.getAttribute('href').catch(() => null);
  if (!profilePath) return null;

  const username = profilePath.replace('/', '');
  const urlsBefore = await getProfileTweetUrls(page, profilePath, username);
  return { profilePath, username, urlsBefore };
}

/**
 * Verify a tweet was posted by comparing profile state before and after.
 * Navigates to the user's profile and checks for a new tweet (higher status ID).
 * @returns The new tweet URL, or null if no new tweet was found.
 */
export async function verifyNewTweet(page: Page, state: ProfileState): Promise<string | null> {
  const urlsAfter = await getProfileTweetUrls(page, state.profilePath, state.username);
  return findNewTweetUrl(state.urlsBefore, urlsAfter);
}

// ── Toggle action (like/retweet) ────────────────────────────────────────────

export interface ToggleActionOptions {
  tweet: Locator;
  page: Page;
  doneButtonSelector: string;
  actionButtonSelector: string;
  actionName: string;
  onAfterClick?: () => Promise<void>;
}

export interface ToggleActionResult {
  success: boolean;
  message: string;
  alreadyDone?: boolean;
}

export async function toggleTweetAction(options: ToggleActionOptions): Promise<ToggleActionResult> {
  const { tweet, page, doneButtonSelector, actionButtonSelector, actionName, onAfterClick } = options;

  const doneButton = tweet.locator(doneButtonSelector);
  const actionButton = tweet.locator(actionButtonSelector);

  const alreadyDone = await doneButton.isVisible().catch(() => false);
  if (alreadyDone) {
    return {
      success: true,
      message: `Tweet already ${actionName.toLowerCase()}d`,
      alreadyDone: true
    };
  }

  await actionButton.waitFor({ timeout: config.timeouts.elementWait });
  await actionButton.click({ force: true });
  await page.waitForTimeout(config.timeouts.actionDelay);

  if (onAfterClick) {
    await onAfterClick();
  }

  const nowDone = await doneButton.isVisible().catch(() => false);
  if (nowDone) {
    return { success: true, message: `${actionName} successful` };
  }

  return {
    success: false,
    message: `${actionName} action completed but could not verify success`
  };
}

// ── Internal helpers (not exported) ─────────────────────────────────────────

async function getTweetUrl(tweet: Locator): Promise<string | null> {
  const timestampLink = tweet.locator(sel.tweetTimestampLink).first();
  const isVisible = await timestampLink.isVisible({ timeout: config.timeouts.elementWait }).catch(() => false);
  if (!isVisible) return null;

  const link = timestampLink.locator('xpath=ancestor::a');
  const href = await link.getAttribute('href').catch(() => null);
  if (!href) return null;

  return href.startsWith('http') ? href : `https://x.com${href}`;
}

async function getOwnTweetUrls(page: Page, username: string, limit = 5): Promise<string[]> {
  const tweets = page.locator(sel.tweet);
  const count = await tweets.count();
  const urls: string[] = [];

  for (let i = 0; i < Math.min(count, limit + 5); i++) {
    const tweet = tweets.nth(i);
    const url = await getTweetUrl(tweet);
    if (url && url.includes(`/${username}/`)) {
      urls.push(url);
      if (urls.length >= limit) break;
    }
  }

  return urls;
}

async function getProfileTweetUrls(page: Page, profilePath: string, username: string): Promise<string[]> {
  await navigateTo(page, `https://x.com${profilePath}/with_replies`);
  return getOwnTweetUrls(page, username);
}

function getStatusId(url: string): bigint {
  const match = url.match(/\/status\/(\d+)/);
  return match ? BigInt(match[1]) : 0n;
}

function findNewTweetUrl(urlsBefore: string[], urlsAfter: string[]): string | null {
  const maxIdBefore = urlsBefore.reduce((max, url) => {
    const id = getStatusId(url);
    return id > max ? id : max;
  }, 0n);

  let newestUrl: string | null = null;
  let newestId = 0n;
  for (const url of urlsAfter) {
    const id = getStatusId(url);
    if (id > newestId) {
      newestId = id;
      newestUrl = url;
    }
  }

  if (newestUrl && newestId > maxIdBefore) {
    return newestUrl;
  }

  return null;
}