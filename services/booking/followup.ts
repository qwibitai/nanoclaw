#!/usr/bin/env npx tsx
/**
 * Post-Rental Follow-up Automation for Sheridan Rentals.
 *
 * Finds bookings whose rental period ended 1-2 days ago and sends
 * a "how was your rental?" + Google review request email.
 *
 * Designed to run as a daily scheduled task via NanoClaw's task scheduler.
 *
 * Usage: npx tsx services/booking/followup.ts [--dry-run]
 */
import Database from 'better-sqlite3';
import { createTransport } from 'nodemailer';
import { readFileSync } from 'fs';
import path from 'path';
import { readEnvFile } from './env.js';

// ── Config ──────────────────────────────────────────────────────────

const GOOGLE_REVIEW_LINK = 'https://g.page/r/CfXGb0xX3GFAEBM/review';
const TEMPLATE_PATH = path.join(process.cwd(), 'tools', 'email', 'templates', 'rental-followup.html');
const DB_PATH = path.join(process.cwd(), 'services', 'booking', 'data', 'bookings.db');
const DRY_RUN = process.argv.includes('--dry-run');

// ── Load env ────────────────────────────────────────────────────────

const envKeys = [
  'SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'SMTP_FROM',
];
const env = readEnvFile(envKeys);
for (const [k, v] of Object.entries(env)) {
  if (!process.env[k]) process.env[k] = v;
}

// ── Database ────────────────────────────────────────────────────────

function openDb(): Database.Database {
  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');

  // Ensure followup tracking columns exist
  try {
    db.exec(`ALTER TABLE bookings ADD COLUMN followup_sent INTEGER NOT NULL DEFAULT 0`);
  } catch {
    // Column already exists
  }
  try {
    db.exec(`ALTER TABLE bookings ADD COLUMN followup_sent_at TEXT`);
  } catch {
    // Column already exists
  }

  return db;
}

interface BookingRow {
  id: string;
  equipment_label: string;
  dates: string;
  customer_first: string;
  customer_last: string;
  customer_email: string;
  status: string;
  followup_sent: number;
}

function getBookingsNeedingFollowup(db: Database.Database): BookingRow[] {
  // Find confirmed bookings where:
  // 1. The last rental date was 1-2 days ago
  // 2. No follow-up email has been sent yet
  // 3. Status is 'confirmed' (not cancelled)
  const now = new Date();
  const twoDaysAgo = new Date(now);
  twoDaysAgo.setDate(twoDaysAgo.getDate() - 2);
  const oneDayAgo = new Date(now);
  oneDayAgo.setDate(oneDayAgo.getDate() - 1);

  const rows = db.prepare(`
    SELECT id, equipment_label, dates, customer_first, customer_last,
           customer_email, status, followup_sent
    FROM bookings
    WHERE status = 'confirmed'
      AND followup_sent = 0
  `).all() as BookingRow[];

  // Filter: last date in the booking should be 1-2 days ago
  return rows.filter(row => {
    const dates: string[] = JSON.parse(row.dates);
    const lastDate = dates[dates.length - 1];
    return lastDate >= formatDate(twoDaysAgo) && lastDate <= formatDate(oneDayAgo);
  });
}

function markFollowupSent(db: Database.Database, bookingId: string): void {
  db.prepare(`
    UPDATE bookings SET followup_sent = 1, followup_sent_at = ? WHERE id = ?
  `).run(new Date().toISOString(), bookingId);
}

function formatDate(d: Date): string {
  return d.toISOString().split('T')[0];
}

// ── Email ───────────────────────────────────────────────────────────

function getTransporter() {
  const host = process.env.SMTP_HOST;
  const port = parseInt(process.env.SMTP_PORT || '587', 10);
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;

  if (!host || !user || !pass) {
    throw new Error('Missing SMTP configuration');
  }

  return createTransport({
    host,
    port,
    secure: port === 465,
    auth: { user, pass },
  });
}

function buildEmail(booking: BookingRow): string {
  let html: string;
  try {
    html = readFileSync(TEMPLATE_PATH, 'utf-8');
  } catch {
    // Fallback: inline template if file not found
    html = `<p>Hi {{first_name}}, thanks for renting our {{equipment}}! <a href="{{review_link}}">Leave a review</a></p>`;
  }

  const vars: Record<string, string> = {
    first_name: booking.customer_first,
    equipment: booking.equipment_label,
    review_link: GOOGLE_REVIEW_LINK,
    booking_id: booking.id,
  };

  for (const [key, value] of Object.entries(vars)) {
    html = html.replace(new RegExp(`\\{\\{${key}\\}\\}`, 'g'), value);
  }

  return html;
}

async function sendFollowupEmail(
  transporter: ReturnType<typeof getTransporter>,
  booking: BookingRow,
): Promise<void> {
  const from = process.env.SMTP_FROM || process.env.SMTP_USER || '';
  const html = buildEmail(booking);
  const mailOptions = {
    from: `Sheridan Rentals <${from}>`,
    to: booking.customer_email,
    subject: `How was your ${booking.equipment_label} rental? — Sheridan Rentals`,
    html,
  };

  // Retry up to 3 times with backoff — don't lose review requests to SMTP hiccups
  let lastError: Error | null = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await transporter.sendMail(mailOptions);
      return;
    } catch (err: any) {
      lastError = err;
      console.error(`[followup] Attempt ${attempt}/3 failed: ${err.message}`);
      if (attempt < 3) await new Promise(r => setTimeout(r, 1000 * attempt));
    }
  }
  throw lastError || new Error('Follow-up email failed after 3 retries');
}

// ── Main ────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const db = openDb();

  const bookings = getBookingsNeedingFollowup(db);

  if (bookings.length === 0) {
    console.log(JSON.stringify({
      status: 'success',
      message: 'No follow-ups needed today',
      checked: true,
    }));
    db.close();
    return;
  }

  console.log(`Found ${bookings.length} booking(s) needing follow-up`);

  const transporter = getTransporter();
  const results: Array<{ bookingId: string; email: string; status: string }> = [];

  for (const booking of bookings) {
    if (DRY_RUN) {
      console.log(`[dry-run] Would send follow-up to ${booking.customer_email} for ${booking.id}`);
      results.push({ bookingId: booking.id, email: booking.customer_email, status: 'dry-run' });
      continue;
    }

    try {
      await sendFollowupEmail(transporter, booking);
      markFollowupSent(db, booking.id);
      results.push({ bookingId: booking.id, email: booking.customer_email, status: 'sent' });
      console.log(`Follow-up sent to ${booking.customer_email} for booking ${booking.id}`);
    } catch (err: any) {
      results.push({ bookingId: booking.id, email: booking.customer_email, status: `error: ${err.message}` });
      console.error(`Failed to send follow-up for ${booking.id}: ${err.message}`);
    }
  }

  console.log(JSON.stringify({
    status: 'success',
    followups: results,
    total: results.length,
    sent: results.filter(r => r.status === 'sent').length,
    failed: results.filter(r => r.status.startsWith('error')).length,
  }));

  db.close();
}

main().catch(err => {
  console.error(JSON.stringify({ status: 'error', error: err.message }));
  process.exit(1);
});
