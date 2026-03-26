/**
 * LinkedIn Automation — Shared Playwright Utilities
 */

import { chromium, BrowserContext, Page } from 'playwright';
import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { config } from './config.js';

export { config };

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ScriptResult {
  success: boolean;
  message: string;
  data?: unknown;
}

export interface DailyCounts {
  date: string;
  connections: number;
  messages: number;
  profileViews: number;
  likes: number;
  comments: number;
  follows: number;
}

// ─── Stdin / Stdout ──────────────────────────────────────────────────────────

export async function readInput<T>(): Promise<T> {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => { data += chunk; });
    process.stdin.on('end', () => {
      try { resolve(JSON.parse(data)); }
      catch (err) { reject(new Error(`Invalid JSON input: ${err}`)); }
    });
    process.stdin.on('error', reject);
  });
}

export function writeResult(result: ScriptResult): void {
  console.log(JSON.stringify(result));
}

// ─── Daily Limits ─────────────────────────────────────────────────────────────

function todayStr(): string {
  return new Date().toISOString().slice(0, 10);
}

export function loadDailyCounts(): DailyCounts {
  try {
    if (fs.existsSync(config.limitsPath)) {
      const saved = JSON.parse(fs.readFileSync(config.limitsPath, 'utf-8'));
      if (saved.date === todayStr()) return saved;
    }
  } catch {}
  return { date: todayStr(), connections: 0, messages: 0, profileViews: 0, likes: 0, comments: 0, follows: 0 };
}

export function saveDailyCounts(counts: DailyCounts): void {
  fs.mkdirSync(path.dirname(config.limitsPath), { recursive: true });
  fs.writeFileSync(config.limitsPath, JSON.stringify(counts, null, 2));
}

export function incrementCount(field: keyof Omit<DailyCounts, 'date'>): DailyCounts {
  const counts = loadDailyCounts();
  counts[field]++;
  saveDailyCounts(counts);
  return counts;
}

export function checkLimit(field: keyof Omit<DailyCounts, 'date'>, limitKey: keyof typeof config.limits): boolean {
  const counts = loadDailyCounts();
  return counts[field] < config.limits[limitKey];
}

// ─── Browser ──────────────────────────────────────────────────────────────────

export function cleanupLockFiles(): void {
  // Kill any orphaned Chrome processes still holding the profile lock.
  // This happens when a previous script was killed via SIGTERM (e.g. timeout)
  // and Chrome (a grandchild process) didn't get the signal.
  spawnSync('pkill', ['-f', config.browserDataDir], { stdio: 'ignore' });

  for (const lockFile of ['SingletonLock', 'SingletonSocket', 'SingletonCookie']) {
    const lockPath = path.join(config.browserDataDir, lockFile);
    if (fs.existsSync(lockPath)) {
      try { fs.unlinkSync(lockPath); } catch {}
    }
  }
}

export async function getBrowserContext(): Promise<BrowserContext> {
  if (!fs.existsSync(config.authPath)) {
    throw new Error('LinkedIn not authenticated. Ask @Andy to run /linkedin-automation setup first.');
  }
  cleanupLockFiles();
  const context = await chromium.launchPersistentContext(config.browserDataDir, {
    executablePath:      config.chromePath,
    headless:            true,
    viewport:            config.viewport,
    args:                config.chromeArgs,
    ignoreDefaultArgs:   config.chromeIgnoreDefaultArgs,
  });
  return context;
}

export function getPage(context: BrowserContext): Page {
  return context.pages()[0] || context.newPage() as unknown as Page;
}

// ─── Human-like Delays ────────────────────────────────────────────────────────

export async function randomDelay(minMs = config.delays.minMs, maxMs = config.delays.maxMs): Promise<void> {
  const ms = Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
  await new Promise(r => setTimeout(r, ms));
}

export async function humanType(page: Page, selector: string, text: string): Promise<void> {
  await page.click(selector);
  await page.waitForTimeout(config.delays.afterClick);
  await page.fill(selector, '');
  // Type character by character with small random delays
  for (const char of text) {
    await page.type(selector, char, { delay: Math.floor(Math.random() * 80) + 30 });
  }
  await page.waitForTimeout(config.delays.afterType);
}

// ─── Navigation ───────────────────────────────────────────────────────────────

export async function navigateToProfile(
  context: BrowserContext,
  profileUrl: string
): Promise<{ page: Page; success: boolean; error?: string }> {
  const page = context.pages()[0] || await context.newPage();
  // Normalize URL
  let url = profileUrl.trim();
  if (!url.startsWith('http')) url = `https://www.linkedin.com/in/${url}`;

  try {
    await page.goto(url, { timeout: config.timeouts.navigation, waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(config.delays.afterPageLoad);

    // Check if profile exists
    const notFound = await page.locator('h1:has-text("Page not found")').isVisible().catch(() => false);
    if (notFound) return { page, success: false, error: 'Profile not found.' };

    return { page, success: true };
  } catch (err) {
    return { page, success: false, error: `Navigation failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

export async function navigateToPost(
  context: BrowserContext,
  postUrl: string
): Promise<{ page: Page; success: boolean; error?: string }> {
  const page = context.pages()[0] || await context.newPage();
  try {
    await page.goto(postUrl, { timeout: config.timeouts.navigation, waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(config.delays.afterPageLoad);
    return { page, success: true };
  } catch (err) {
    return { page, success: false, error: `Navigation failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

// ─── Profile Data Extraction ──────────────────────────────────────────────────

export interface ProfileData {
  name: string;
  headline: string;
  location: string;
  about: string;
  profileUrl: string;
  company: string;
  email: string;
}

export async function extractProfileData(page: Page, profileUrl: string): Promise<ProfileData> {
  const name     = await page.locator(config.selectors.profileName).first().textContent().catch(() => '') ?? '';
  const headline = await page.locator(config.selectors.profileHeadline).first().textContent().catch(() => '') ?? '';
  const location = await page.locator('span.text-body-small.inline.t-black--light').first().textContent().catch(() => '') ?? '';

  // About section
  let about = '';
  try {
    const aboutBtn = page.locator('#about ~ div button[aria-label*="more"]');
    if (await aboutBtn.isVisible()) await aboutBtn.click();
    about = await page.locator('#about ~ div .full-width span[aria-hidden="true"]').first().textContent() ?? '';
  } catch {}

  // Current company — try experience section selectors, then fall back to headline parsing
  let company = '';
  const companySelectors = [
    'section#experience li:first-child .t-14.t-normal span[aria-hidden="true"]',
    '#experience ~ div li:first-child span[aria-hidden="true"]:nth-of-type(2)',
    '#experience ~ div li:first-child span[aria-hidden="true"]:nth-child(2)',
    'section#experience li:first-child span[aria-hidden="true"]:nth-of-type(2)',
  ];
  for (const sel of companySelectors) {
    try {
      const text = await page.locator(sel).first().textContent({ timeout: 2000 }) ?? '';
      if (text.trim()) { company = text.trim().split('·')[0].trim(); break; }
    } catch {}
  }
  // Fallback: parse "Title @ Company" from headline (handles class-randomisation)
  if (!company && headline) {
    const m = headline.match(/@\s*([^|·\n]+)/);
    if (m) company = m[1].trim();
  }

  // Email (if publicly visible on contact info)
  let email = '';
  try {
    const contactBtn = page.locator('a[href*="overlay/contact-info"]');
    if (await contactBtn.isVisible({ timeout: 2000 })) {
      await contactBtn.click();
      await page.waitForTimeout(1500);
      email = await page.locator('section.ci-email a').textContent().catch(() => '') ?? '';
      await page.keyboard.press('Escape');
    }
  } catch {}

  return {
    name:       name.trim(),
    headline:   headline.trim(),
    location:   location.trim(),
    about:      about.trim(),
    profileUrl: profileUrl.trim(),
    company:    company.trim(),
    email:      email.trim(),
  };
}

// ─── Script Runner ────────────────────────────────────────────────────────────

export async function runScript<T>(
  handler: (input: T) => Promise<ScriptResult>
): Promise<void> {
  try {
    const input = await readInput<T>();
    const result = await handler(input);
    writeResult(result);
  } catch (err) {
    writeResult({
      success: false,
      message: `Script failed: ${err instanceof Error ? err.message : String(err)}`,
    });
    process.exit(1);
  }
}
