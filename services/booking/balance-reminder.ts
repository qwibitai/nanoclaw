#!/usr/bin/env npx tsx
/**
 * Balance Payment Reminder for Sheridan Rentals.
 *
 * Finds deposit-only RV bookings with unpaid balance and sends
 * reminder emails with a Square payment link for the remaining amount.
 *
 * Reminder schedule:
 *   - 7 days before pickup: first reminder
 *   - 2 days before pickup: urgent reminder
 *   - Day of pickup: final warning + owner alert
 *
 * Designed to run as a daily scheduled task via NanoClaw's task scheduler.
 *
 * Usage: npx tsx services/booking/balance-reminder.ts [--dry-run]
 */
import Database from 'better-sqlite3';
import { createTransport } from 'nodemailer';
import path from 'path';
import { readEnvFile } from './env.js';

// ── Config ──────────────────────────────────────────────────────────

const DB_PATH = path.join(process.cwd(), 'services', 'booking', 'data', 'bookings.db');
const DRY_RUN = process.argv.includes('--dry-run');

// ── Load env ────────────────────────────────────────────────────────

const envKeys = [
  'SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'SMTP_FROM',
  'SQUARE_ACCESS_TOKEN', 'SQUARE_LOCATION_ID', 'SQUARE_ENVIRONMENT',
  'OWNER_EMAIL',
];
const env = readEnvFile(envKeys);
for (const [k, v] of Object.entries(env)) {
  if (!process.env[k]) process.env[k] = v;
}

const OWNER_EMAIL = process.env.OWNER_EMAIL || 'sheridantrailerrentals@gmail.com';

// ── Database ────────────────────────────────────────────────────────

function openDb(): Database.Database {
  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');

  // Ensure balance reminder tracking columns exist
  const migrations = [
    `ALTER TABLE bookings ADD COLUMN balance_reminder_count INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE bookings ADD COLUMN balance_reminder_last TEXT`,
    `ALTER TABLE bookings ADD COLUMN balance_payment_url TEXT NOT NULL DEFAULT ''`,
    `ALTER TABLE bookings ADD COLUMN delivery_address TEXT NOT NULL DEFAULT ''`,
  ];
  for (const sql of migrations) {
    try { db.exec(sql); } catch { /* column already exists */ }
  }

  return db;
}

interface BalanceBooking {
  id: string;
  equipment: string;
  equipment_label: string;
  dates: string;
  num_days: number;
  customer_first: string;
  customer_last: string;
  customer_email: string;
  customer_phone: string;
  subtotal: number;
  deposit: number;
  balance: number;
  status: string;
  balance_reminder_count: number;
  balance_reminder_last: string | null;
  balance_payment_url: string;
}

function formatDate(d: Date): string {
  return d.toISOString().split('T')[0];
}

function daysUntilPickup(booking: BalanceBooking): number {
  const dates: string[] = JSON.parse(booking.dates);
  const firstDate = new Date(dates[0] + 'T00:00:00');
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.floor((firstDate.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
}

function getBookingsNeedingReminder(db: Database.Database): BalanceBooking[] {
  // Find deposit-only bookings with unpaid balance
  const rows = db.prepare(`
    SELECT id, equipment, equipment_label, dates, num_days,
           customer_first, customer_last, customer_email, customer_phone,
           subtotal, deposit, balance, status,
           balance_reminder_count, balance_reminder_last, balance_payment_url
    FROM bookings
    WHERE status = 'paid' AND balance > 0
    ORDER BY created_at ASC
  `).all() as BalanceBooking[];

  const today = formatDate(new Date());

  return rows.filter(booking => {
    const days = daysUntilPickup(booking);

    // Don't remind for rentals that already started or are way in the future
    if (days < 0 || days > 7) return false;

    // Reminder schedule: 7 days, 2 days, day-of
    const count = booking.balance_reminder_count || 0;
    if (days <= 7 && count === 0) return true;  // First reminder
    if (days <= 2 && count === 1) return true;   // Urgent reminder
    if (days <= 0 && count === 2) return true;   // Final warning

    return false;
  });
}

// ── Square Balance Payment Link ─────────────────────────────────────

async function createBalancePaymentLink(
  booking: BalanceBooking,
): Promise<string> {
  const accessToken = process.env.SQUARE_ACCESS_TOKEN;
  const locationId = process.env.SQUARE_LOCATION_ID;
  const environment = process.env.SQUARE_ENVIRONMENT || 'production';
  const baseUrl = environment === 'production'
    ? 'https://connect.squareup.com/v2'
    : 'https://connect.squareupsandbox.com/v2';

  if (!accessToken || !locationId) {
    throw new Error('Missing Square credentials');
  }

  const body = {
    idempotency_key: `balance-${booking.id}-${Date.now()}`,
    order: {
      location_id: locationId,
      line_items: [{
        name: `${booking.equipment_label} — Remaining Balance`,
        quantity: '1',
        base_price_money: {
          amount: Math.round(booking.balance * 100),
          currency: 'USD',
        },
      }],
      metadata: {
        booking_id: booking.id,
        payment_type: 'balance',
      },
    },
    checkout_options: {
      allow_tipping: false,
      redirect_url: `https://sheridantrailerrentals.us/form/?booking=${booking.id}`,
      ask_for_shipping_address: false,
    },
  };

  const resp = await fetch(`${baseUrl}/online-checkout/payment-links`, {
    method: 'POST',
    headers: {
      'Square-Version': '2024-12-18',
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  const data = await resp.json() as any;
  if (!resp.ok || data.errors) {
    throw new Error(`Square error: ${JSON.stringify(data.errors || data)}`);
  }

  return data.payment_link?.url || '';
}

// ── Email ───────────────────────────────────────────────────────────

function getTransporter() {
  const host = process.env.SMTP_HOST;
  const port = parseInt(process.env.SMTP_PORT || '587', 10);
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;

  if (!host || !user || !pass) throw new Error('Missing SMTP configuration');

  return createTransport({
    host,
    port,
    secure: port === 465,
    auth: { user, pass },
  });
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function buildReminderEmail(booking: BalanceBooking, paymentUrl: string, daysLeft: number): { subject: string; html: string } {
  const dates: string[] = JSON.parse(booking.dates);
  const dateRange = dates.length === 1 ? dates[0] : `${dates[0]} to ${dates[dates.length - 1]}`;
  const firstName = escapeHtml(booking.customer_first);

  let urgency: string;
  let subject: string;
  if (daysLeft <= 0) {
    urgency = 'Your rental starts today! Please complete your balance payment now to receive the lock code.';
    subject = `ACTION REQUIRED: Balance due today — ${booking.equipment_label} | Sheridan Rentals`;
  } else if (daysLeft <= 2) {
    urgency = `Your rental starts in ${daysLeft} day${daysLeft > 1 ? 's' : ''}. Please pay your remaining balance to secure your booking.`;
    subject = `Reminder: Balance due soon — ${booking.equipment_label} | Sheridan Rentals`;
  } else {
    urgency = `Your rental starts in ${daysLeft} days. Just a friendly reminder to complete your balance payment before pickup.`;
    subject = `Upcoming Rental — Balance Reminder | Sheridan Rentals`;
  }

  const html = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 600px; margin: 0 auto;">
      <div style="background: #1d4ed8; color: white; padding: 24px; border-radius: 8px 8px 0 0; text-align: center;">
        <h1 style="margin: 0; font-size: 22px;">Balance Payment Reminder</h1>
        <p style="margin: 8px 0 0; opacity: 0.9;">Sheridan Trailer Rentals</p>
      </div>

      <div style="background: white; padding: 24px; border: 1px solid #e5e7eb; border-top: none;">
        <p style="font-size: 16px; color: #374151;">Hi ${firstName},</p>
        <p style="font-size: 14px; color: #4b5563; line-height: 1.6;">${urgency}</p>

        <div style="background: #f9fafb; border-radius: 8px; padding: 16px; margin: 16px 0;">
          <table style="font-size: 14px; color: #4b5563; width: 100%;">
            <tr><td style="padding: 4px 0; font-weight: 600;">Equipment:</td><td>${booking.equipment_label}</td></tr>
            <tr><td style="padding: 4px 0; font-weight: 600;">Dates:</td><td>${dateRange}</td></tr>
            <tr><td style="padding: 4px 0; font-weight: 600;">Deposit Paid:</td><td style="color: #16a34a;">$${booking.deposit.toFixed(2)}</td></tr>
            <tr><td style="padding: 4px 0; font-weight: 600; color: #d97706;">Balance Due:</td><td style="color: #d97706; font-weight: 600;">$${booking.balance.toFixed(2)}</td></tr>
          </table>
        </div>

        <div style="text-align: center; margin: 24px 0;">
          <a href="${paymentUrl}" style="display: inline-block; background: #16a34a; color: white; text-decoration: none; padding: 14px 32px; border-radius: 8px; font-size: 16px; font-weight: 600;">
            Pay $${booking.balance.toFixed(2)} Now
          </a>
        </div>

        <p style="font-size: 13px; color: #6b7280; text-align: center;">
          Once paid, you'll receive the lock code to access the equipment.
        </p>

        <p style="font-size: 13px; color: #9ca3af; text-align: center; margin-top: 8px;">
          If you've already submitted your payment, please disregard this message — it may take a moment to process.
        </p>

        <p style="font-size: 14px; color: #4b5563; margin-top: 20px;">
          Questions? Reply to this email or text us at (817) 587-1460.
        </p>

        <p style="font-size: 13px; color: #9ca3af; margin-top: 24px; padding-top: 16px; border-top: 1px solid #e5e7eb;">
          Booking ID: ${booking.id}<br>
          Sheridan Trailer Rentals — Tomball, TX
        </p>
      </div>
    </div>
  `;

  return { subject, html };
}

function buildOwnerAlert(booking: BalanceBooking, daysLeft: number): { subject: string; html: string } {
  const dates: string[] = JSON.parse(booking.dates);
  const dateRange = dates.length === 1 ? dates[0] : `${dates[0]} to ${dates[dates.length - 1]}`;

  const urgencyTag = daysLeft <= 0 ? 'TODAY' : daysLeft <= 2 ? 'URGENT' : 'REMINDER';
  const action = daysLeft <= 0
    ? 'Pickup is TODAY. Call the customer or cancel the booking.'
    : daysLeft <= 2
    ? 'Pickup is in ' + daysLeft + ' day' + (daysLeft > 1 ? 's' : '') + '. Customer has been reminded — follow up if needed.'
    : 'First reminder sent. No action needed yet.';

  return {
    subject: `[${urgencyTag}] Unpaid balance: ${booking.customer_first} ${booking.customer_last} — ${booking.equipment_label} ($${booking.balance.toFixed(2)})`,
    html: `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 600px; margin: 0 auto;">
        <div style="background: ${daysLeft <= 0 ? '#dc2626' : daysLeft <= 2 ? '#d97706' : '#2563eb'}; color: white; padding: 16px 24px; border-radius: 8px 8px 0 0;">
          <h2 style="margin: 0;">${urgencyTag}: Unpaid Balance — $${booking.balance.toFixed(2)}</h2>
        </div>
        <div style="background: #f9fafb; padding: 20px 24px; border: 1px solid #e5e7eb; border-top: none; font-size: 14px; color: #4b5563;">
          <p><strong>${action}</strong></p>
          <table style="width: 100%; font-size: 14px;">
            <tr><td style="padding: 4px 0; font-weight: 600;">Customer:</td><td>${booking.customer_first} ${booking.customer_last}</td></tr>
            <tr><td style="padding: 4px 0; font-weight: 600;">Phone:</td><td><a href="tel:${booking.customer_phone}">${booking.customer_phone}</a></td></tr>
            <tr><td style="padding: 4px 0; font-weight: 600;">Email:</td><td>${booking.customer_email}</td></tr>
            <tr><td style="padding: 4px 0; font-weight: 600;">Equipment:</td><td>${booking.equipment_label}</td></tr>
            <tr><td style="padding: 4px 0; font-weight: 600;">Dates:</td><td>${dateRange}</td></tr>
            <tr><td style="padding: 4px 0; font-weight: 600;">Balance:</td><td style="color: #dc2626; font-weight: 700;">$${booking.balance.toFixed(2)}</td></tr>
            <tr><td style="padding: 4px 0; font-weight: 600;">Reminders sent:</td><td>${booking.balance_reminder_count + 1} of 3</td></tr>
          </table>
          <p style="color: #9ca3af; font-size: 13px; margin-top: 16px;">Booking ID: ${booking.id}</p>
        </div>
      </div>
    `,
  };
}

// ── Main ────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const db = openDb();
  const bookings = getBookingsNeedingReminder(db);

  if (bookings.length === 0) {
    console.log(JSON.stringify({
      status: 'success',
      message: 'No balance reminders needed today',
    }));
    db.close();
    return;
  }

  console.log(`Found ${bookings.length} booking(s) needing balance reminder`);
  const transporter = getTransporter();
  const results: Array<{ bookingId: string; email: string; status: string; daysLeft: number }> = [];

  for (const booking of bookings) {
    const days = daysUntilPickup(booking);

    if (DRY_RUN) {
      console.log(`[dry-run] Would remind ${booking.customer_email} for ${booking.id} ($${booking.balance} due, ${days} days left)`);
      results.push({ bookingId: booking.id, email: booking.customer_email, status: 'dry-run', daysLeft: days });
      continue;
    }

    try {
      // Create or reuse balance payment link
      let paymentUrl = booking.balance_payment_url;
      if (!paymentUrl) {
        paymentUrl = await createBalancePaymentLink(booking);
        db.prepare(`UPDATE bookings SET balance_payment_url = ?, updated_at = ? WHERE id = ?`)
          .run(paymentUrl, new Date().toISOString(), booking.id);
      }

      // Send customer reminder
      const { subject, html } = buildReminderEmail(booking, paymentUrl, days);
      const from = process.env.SMTP_FROM || process.env.SMTP_USER || '';

      await transporter.sendMail({
        from: `Sheridan Rentals <${from}>`,
        to: booking.customer_email,
        subject,
        html,
      });

      // Update reminder tracking
      db.prepare(`
        UPDATE bookings
        SET balance_reminder_count = balance_reminder_count + 1,
            balance_reminder_last = ?,
            updated_at = ?
        WHERE id = ?
      `).run(new Date().toISOString(), new Date().toISOString(), booking.id);

      // Alert the owner on every balance reminder so they have full visibility
      const alert = buildOwnerAlert(booking, days);
      await transporter.sendMail({
        from: `Sheridan Rentals <${from}>`,
        to: OWNER_EMAIL,
        subject: alert.subject,
        html: alert.html,
      }).catch(err => console.error(`[balance] Owner alert failed: ${err.message}`));

      results.push({ bookingId: booking.id, email: booking.customer_email, status: 'sent', daysLeft: days });
      console.log(`Balance reminder sent to ${booking.customer_email} for ${booking.id} ($${booking.balance}, ${days} days left)`);

    } catch (err: any) {
      results.push({ bookingId: booking.id, email: booking.customer_email, status: `error: ${err.message}`, daysLeft: days });
      console.error(`Failed to send balance reminder for ${booking.id}: ${err.message}`);
    }
  }

  console.log(JSON.stringify({
    status: 'success',
    reminders: results,
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
