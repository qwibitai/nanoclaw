#!/usr/bin/env npx tsx
/**
 * Website Contact Scraper for NanoClaw
 *
 * Visits company websites to extract email addresses, phone numbers, and contact info.
 * Enriches CRM contacts with actionable data.
 *
 * Usage:
 *   npx tsx tools/leads/website-scraper.ts scrape --url "https://example.com" [--contact-id <id>]
 *   npx tsx tools/leads/website-scraper.ts batch --source google_maps [--limit 20]
 *
 * No API keys needed — uses Node built-in fetch.
 */

import Database from 'better-sqlite3';
import { getDbPath } from '../shared/db-path.js';
import fs from 'fs';
import path from 'path';

interface ScrapedData {
  emails: string[];
  phones: string[];
  contactPages: string[];
}

interface Args {
  action: string;
  url?: string;
  contactId?: string;
  source?: string;
  limit: number;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const action = argv[0];

  if (!['scrape', 'batch'].includes(action)) {
    console.error(JSON.stringify({
      status: 'error',
      error: `Unknown action "${action}". Use: scrape, batch`,
      usage: [
        'npx tsx tools/leads/website-scraper.ts scrape --url "https://example.com" [--contact-id <id>]',
        'npx tsx tools/leads/website-scraper.ts batch --source google_maps [--limit 20]',
      ],
    }));
    process.exit(1);
  }

  const flags: Record<string, string> = {};
  for (let i = 1; i < argv.length; i++) {
    if (argv[i].startsWith('--') && i + 1 < argv.length) {
      flags[argv[i].slice(2)] = argv[++i];
    }
  }

  return {
    action,
    url: flags.url,
    contactId: flags['contact-id'],
    source: flags.source,
    limit: parseInt(flags.limit || '20', 10),
  };
}

function getDb(): Database.Database {
  const dbPath = getDbPath();
  if (!fs.existsSync(dbPath)) {
    console.error(JSON.stringify({ status: 'error', error: 'Database not found. Run NanoClaw first.' }));
    process.exit(1);
  }
  return new Database(dbPath);
}

const EMAIL_REGEX = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;
const PHONE_REGEX = /(?:\+?1[-.\s]?)?\(?[2-9]\d{2}\)?[-.\s]?\d{3}[-.\s]?\d{4}/g;
const CONTACT_PAGE_REGEX = /href=["']([^"']*(?:contact|about|team|about-us)[^"']*)["']/gi;

// Common junk emails to filter out
const JUNK_EMAIL_PATTERNS = [
  /noreply@/i, /no-reply@/i, /donotreply@/i,
  /support@google/i, /support@apple/i,
  /@sentry\.io/i, /@wixpress\.com/i, /@squarespace/i,
  /example\.com/i, /@maps\.nanoclaw/i, /@sms\.nanoclaw/i,
  /\.png$/i, /\.jpg$/i, /\.gif$/i, /\.svg$/i,
];

function isJunkEmail(email: string): boolean {
  return JUNK_EMAIL_PATTERNS.some((p) => p.test(email));
}

function extractDomain(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

async function fetchPage(url: string): Promise<string | null> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);

    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; NanoClaw Lead Enrichment)',
        'Accept': 'text/html,application/xhtml+xml',
      },
      redirect: 'follow',
    });

    clearTimeout(timeout);

    if (!res.ok) return null;

    const contentType = res.headers.get('content-type') || '';
    if (!contentType.includes('text/html') && !contentType.includes('text/plain')) return null;

    return await res.text();
  } catch {
    return null;
  }
}

async function scrapeWebsite(url: string): Promise<ScrapedData> {
  const emails = new Set<string>();
  const phones = new Set<string>();
  const contactPages = new Set<string>();

  // Normalize URL
  if (!url.startsWith('http')) url = `https://${url}`;
  const baseUrl = new URL(url);

  // Fetch homepage
  const homepage = await fetchPage(url);
  if (!homepage) {
    return { emails: [], phones: [], contactPages: [] };
  }

  // Extract from homepage
  for (const match of homepage.matchAll(EMAIL_REGEX)) {
    if (!isJunkEmail(match[0])) emails.add(match[0].toLowerCase());
  }
  for (const match of homepage.matchAll(PHONE_REGEX)) {
    phones.add(match[0]);
  }

  // Find contact/about page links
  let linkMatch;
  while ((linkMatch = CONTACT_PAGE_REGEX.exec(homepage)) !== null) {
    try {
      const linkUrl = new URL(linkMatch[1], baseUrl).href;
      // Only follow links on the same domain
      if (new URL(linkUrl).hostname === baseUrl.hostname) {
        contactPages.add(linkUrl);
      }
    } catch {
      // Invalid URL, skip
    }
  }

  // Fetch contact/about pages (max 3 to be polite)
  const pagesToFetch = [...contactPages].slice(0, 3);
  for (const pageUrl of pagesToFetch) {
    // Rate limit: 2 second delay between requests
    await new Promise((r) => setTimeout(r, 2000));

    const pageHtml = await fetchPage(pageUrl);
    if (!pageHtml) continue;

    for (const match of pageHtml.matchAll(EMAIL_REGEX)) {
      if (!isJunkEmail(match[0])) emails.add(match[0].toLowerCase());
    }
    for (const match of pageHtml.matchAll(PHONE_REGEX)) {
      phones.add(match[0]);
    }
  }

  return {
    emails: [...emails],
    phones: [...phones],
    contactPages: [...contactPages],
  };
}

async function scrapeSingle(url: string, contactId?: string) {
  const data = await scrapeWebsite(url);

  if (contactId && (data.emails.length > 0 || data.phones.length > 0)) {
    const db = getDb();
    const now = new Date().toISOString();

    // Pick best email (prefer info@, contact@, sales@ over generic)
    const priorityPrefixes = ['info', 'contact', 'sales', 'hello', 'office'];
    let bestEmail = data.emails[0];
    for (const prefix of priorityPrefixes) {
      const match = data.emails.find((e) => e.startsWith(`${prefix}@`));
      if (match) { bestEmail = match; break; }
    }

    // Update contact — only set email if current one is a placeholder
    const contact = db.prepare('SELECT email, phone FROM contacts WHERE id = ?').get(contactId) as { email: string; phone: string | null } | undefined;

    if (contact) {
      const isPlaceholder = contact.email.endsWith('@maps.nanoclaw') || contact.email.endsWith('@sms.nanoclaw');
      const updates: string[] = [];
      const values: unknown[] = [];

      if (bestEmail && isPlaceholder) {
        updates.push('email = ?');
        values.push(bestEmail);
      }
      if (data.phones.length > 0 && !contact.phone) {
        updates.push('phone = ?');
        values.push(data.phones[0]);
      }
      if (updates.length > 0) {
        updates.push('updated_at = ?');
        values.push(now);
        values.push(contactId);
        db.prepare(`UPDATE contacts SET ${updates.join(', ')} WHERE id = ?`).run(...values);
      }
    }

    db.close();
  }

  console.log(JSON.stringify({
    status: 'success',
    action: 'scrape',
    url,
    emails: data.emails,
    phones: data.phones,
    contactPages: data.contactPages,
    contactUpdated: contactId ? true : false,
  }));
}

async function batchScrape(source: string, limit: number) {
  const db = getDb();

  // Find contacts with websites but placeholder emails
  const contacts = db.prepare(
    `SELECT id, website, email, company FROM contacts
     WHERE source = ? AND website IS NOT NULL AND website != ''
       AND (email LIKE '%@maps.nanoclaw' OR email LIKE '%@sms.nanoclaw')
     ORDER BY created_at ASC LIMIT ?`,
  ).all(source, Math.min(limit, 50)) as Array<{ id: string; website: string; email: string; company: string }>;

  db.close();

  if (contacts.length === 0) {
    console.log(JSON.stringify({
      status: 'success',
      action: 'batch',
      source,
      message: 'No contacts need scraping',
      processed: 0,
    }));
    return;
  }

  let enriched = 0;
  let failed = 0;
  const results: Array<{ company: string; emails: string[]; phones: string[] }> = [];

  for (const contact of contacts) {
    try {
      // Rate limit: 2 second delay between sites
      if (enriched + failed > 0) {
        await new Promise((r) => setTimeout(r, 2000));
      }

      const data = await scrapeWebsite(contact.website);

      if (data.emails.length > 0 || data.phones.length > 0) {
        // Update the contact in DB
        const updateDb = getDb();
        const now = new Date().toISOString();

        const priorityPrefixes = ['info', 'contact', 'sales', 'hello', 'office'];
        let bestEmail = data.emails[0];
        for (const prefix of priorityPrefixes) {
          const match = data.emails.find((e) => e.startsWith(`${prefix}@`));
          if (match) { bestEmail = match; break; }
        }

        const updates: string[] = [];
        const values: unknown[] = [];

        if (bestEmail) {
          updates.push('email = ?');
          values.push(bestEmail);
        }
        if (data.phones.length > 0) {
          updates.push('phone = ?');
          values.push(data.phones[0]);
        }
        if (updates.length > 0) {
          updates.push('updated_at = ?');
          values.push(now);
          values.push(contact.id);
          updateDb.prepare(`UPDATE contacts SET ${updates.join(', ')} WHERE id = ?`).run(...values);
        }
        updateDb.close();

        enriched++;
        results.push({ company: contact.company, emails: data.emails, phones: data.phones });
      } else {
        failed++;
      }
    } catch {
      failed++;
    }
  }

  console.log(JSON.stringify({
    status: 'success',
    action: 'batch',
    source,
    total: contacts.length,
    enriched,
    failed,
    results,
  }));
}

async function main() {
  const args = parseArgs();

  try {
    switch (args.action) {
      case 'scrape':
        if (!args.url) {
          console.error(JSON.stringify({ status: 'error', error: 'scrape requires --url' }));
          process.exit(1);
        }
        await scrapeSingle(args.url, args.contactId);
        break;

      case 'batch':
        if (!args.source) {
          console.error(JSON.stringify({ status: 'error', error: 'batch requires --source' }));
          process.exit(1);
        }
        await batchScrape(args.source, args.limit);
        break;
    }
  } catch (err) {
    console.error(JSON.stringify({
      status: 'error',
      error: err instanceof Error ? err.message : String(err),
    }));
    process.exit(1);
  }
}

main();
