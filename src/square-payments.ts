/**
 * Square Payments — deposit collection via Square Payments API
 * With booking database storage and Google Calendar integration.
 */
import crypto from 'crypto';
import path from 'path';
import fs from 'fs';
import nodemailer from 'nodemailer';
import Database from 'better-sqlite3';
import { google, calendar_v3 } from 'googleapis';
import { readEnvFile } from './env.js';
import { logger } from './logger.js';

// ── Square config ───────────────────────────────────────────────
const squareConfig = readEnvFile([
  'SQUARE_ACCESS_TOKEN',
  'SQUARE_LOCATION_ID',
  'SQUARE_ENVIRONMENT',
]);

const ACCESS_TOKEN =
  process.env.SQUARE_ACCESS_TOKEN || squareConfig.SQUARE_ACCESS_TOKEN || '';
const LOCATION_ID =
  process.env.SQUARE_LOCATION_ID || squareConfig.SQUARE_LOCATION_ID || '';
const ENVIRONMENT =
  process.env.SQUARE_ENVIRONMENT || squareConfig.SQUARE_ENVIRONMENT || 'sandbox';

const BASE_URL =
  ENVIRONMENT === 'production'
    ? 'https://connect.squareup.com'
    : 'https://connect.squareupsandbox.com';

// ── SMTP config ─────────────────────────────────────────────────
const smtpConfig = readEnvFile(['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'SMTP_FROM']);
const BUSINESS_EMAIL = 'blayke.elder1@gmail.com';

// ── Google Calendar config ──────────────────────────────────────
const gcalConfig = readEnvFile(['GOOGLE_SERVICE_ACCOUNT_KEY']);

const CALENDAR_IDS: Record<string, string> = {
  rv: 'c_7ba6d46497500abce720f92671ef92bb8bbdd79e741f71d41c01084e6bb0d69c@group.calendar.google.com',
  carhauler: 'c_f92948a07076df3480b68fcaac0dd44cfc815ca9265999f709254dfca5fc64ad@group.calendar.google.com',
  landscaping: 'c_684ca11a465fb336458c8d7dfadc9ec83265bce3b8657712d2fa10ea32cc627e@group.calendar.google.com',
};

// ── Equipment config ────────────────────────────────────────────
const EQUIPMENT_CONFIG: Record<string, { label: string; rate: number; unit: string; deposit: number }> = {
  rv: { label: 'RV Camper', rate: 150, unit: 'night', deposit: 250 },
  carhauler: { label: 'Car Hauler', rate: 65, unit: 'day', deposit: 50 },
  landscaping: { label: 'Landscaping Trailer', rate: 50, unit: 'day', deposit: 50 },
  battery: { label: 'Battery (Test)', rate: 0.10, unit: 'day', deposit: 0.10 },
};

/** Deposit amounts in cents by equipment type */
const DEPOSIT_AMOUNTS: Record<string, number> = {
  rv: 25000,
  carhauler: 5000,
  landscaping: 5000,
  battery: 10,
};

// ── Database ────────────────────────────────────────────────────
const DB_PATH = path.join(process.cwd(), 'services', 'booking', 'data', 'bookings.db');
let db: Database.Database | null = null;

function getDb(): Database.Database {
  if (db) return db;
  const dir = path.dirname(DB_PATH);
  fs.mkdirSync(dir, { recursive: true });
  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  // Ensure table exists
  db.exec(`CREATE TABLE IF NOT EXISTS bookings (
    id TEXT PRIMARY KEY,
    equipment TEXT NOT NULL,
    equipment_label TEXT NOT NULL,
    dates TEXT NOT NULL,
    num_days INTEGER NOT NULL,
    customer_first TEXT NOT NULL,
    customer_last TEXT NOT NULL,
    customer_email TEXT NOT NULL,
    customer_phone TEXT NOT NULL,
    subtotal REAL NOT NULL,
    deposit REAL NOT NULL,
    balance REAL NOT NULL,
    add_ons TEXT NOT NULL DEFAULT '[]',
    details TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'pending',
    square_order_id TEXT NOT NULL DEFAULT '',
    square_payment_link_id TEXT NOT NULL DEFAULT '',
    payment_url TEXT NOT NULL DEFAULT '',
    calendar_event_id TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_bookings_status ON bookings(status)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_bookings_equipment_dates ON bookings(equipment, dates)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_bookings_square_order ON bookings(square_order_id)`);
  // Missed bookings tracking
  db.exec(`CREATE TABLE IF NOT EXISTS missed_bookings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    equipment TEXT NOT NULL,
    equipment_label TEXT NOT NULL,
    requested_dates TEXT NOT NULL,
    num_days INTEGER NOT NULL,
    customer_first TEXT NOT NULL DEFAULT '',
    customer_last TEXT NOT NULL DEFAULT '',
    customer_email TEXT NOT NULL DEFAULT '',
    customer_phone TEXT NOT NULL DEFAULT '',
    reason TEXT NOT NULL,
    conflict_booking_id TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
  )`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_missed_equipment ON missed_bookings(equipment)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_missed_created ON missed_bookings(created_at)`);
  return db;
}

// ── Missed Booking Tracking ─────────────────────────────────────
let missedBookingAlertHandler: ((msg: string) => void) | null = null;

export function setMissedBookingAlertHandler(handler: (msg: string) => void): void {
  missedBookingAlertHandler = handler;
}

interface MissedBookingInfo {
  equipment: string;
  equipmentLabel: string;
  dates: string[];
  customer: { firstName: string; lastName: string; email: string; phone: string };
  reason: string;
  conflictBookingId?: string;
}

function logMissedBooking(info: MissedBookingInfo): void {
  try {
    const d = getDb();
    d.prepare(`INSERT INTO missed_bookings (equipment, equipment_label, requested_dates, num_days, customer_first, customer_last, customer_email, customer_phone, reason, conflict_booking_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      info.equipment,
      info.equipmentLabel,
      JSON.stringify(info.dates),
      info.dates.length,
      info.customer.firstName.trim(),
      info.customer.lastName.trim(),
      info.customer.email.trim(),
      info.customer.phone.trim(),
      info.reason,
      info.conflictBookingId || '',
      new Date().toISOString(),
    );
    logger.info({ equipment: info.equipment, reason: info.reason }, 'Missed booking logged');
  } catch (err) {
    logger.error({ error: err instanceof Error ? err.message : String(err) }, 'Failed to log missed booking');
  }

  // Fire alert (non-blocking)
  try {
    if (missedBookingAlertHandler) {
      const dateNote = info.dates.length === 1 ? info.dates[0] : `${info.dates[0]} to ${info.dates[info.dates.length - 1]}`;
      const msg = [
        `Missed Booking Alert`,
        `Equipment: ${info.equipmentLabel}`,
        `Dates: ${dateNote} (${info.dates.length} day${info.dates.length > 1 ? 's' : ''})`,
        `Customer: ${info.customer.firstName} ${info.customer.lastName}`,
        `Email: ${info.customer.email}`,
        `Phone: ${info.customer.phone}`,
        `Reason: ${info.reason}`,
        info.conflictBookingId ? `Conflict: ${info.conflictBookingId}` : '',
      ].filter(Boolean).join('\n');
      missedBookingAlertHandler(msg);
    }
  } catch (err) {
    logger.error({ error: err instanceof Error ? err.message : String(err) }, 'Failed to send missed booking alert');
  }
}

/** Normalize phone to E.164 for Square (strips non-digits, prepends +1 if needed) */function normalizePhone(phone: string): string {  const digits = phone.replace(/\D/g, '');  if (digits.length === 10) return '+1' + digits;  if (digits.length === 11 && digits.startsWith('1')) return '+' + digits;  if (phone.startsWith('+')) return phone;  return '+1' + digits;}
function generateBookingId(): string {
  return 'SR-' + crypto.randomBytes(4).toString('hex').toUpperCase();
}

// ── Google Calendar ─────────────────────────────────────────────
let calClient: calendar_v3.Calendar | null = null;

function getCalAuth(): InstanceType<typeof google.auth.JWT> | null {
  const keyJson = gcalConfig.GOOGLE_SERVICE_ACCOUNT_KEY || process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
  if (!keyJson) return null;
  try {
    const key = JSON.parse(keyJson);
    return new google.auth.JWT({
      email: key.client_email,
      key: key.private_key,
      scopes: ['https://www.googleapis.com/auth/calendar'],
    });
  } catch {
    logger.error('Failed to parse GOOGLE_SERVICE_ACCOUNT_KEY');
    return null;
  }
}

function getCal(): calendar_v3.Calendar | null {
  if (calClient) return calClient;
  const auth = getCalAuth();
  if (!auth) return null;
  calClient = google.calendar({ version: 'v3', auth });
  return calClient;
}

async function checkCalendarAvailability(equipmentKey: string, dates: string[]): Promise<boolean> {
  const cal = getCal();
  const calId = CALENDAR_IDS[equipmentKey];
  if (!cal || !calId) return true; // If no calendar, allow booking

  const sorted = [...dates].sort();
  const startDate = sorted[0];
  const endDate = sorted[sorted.length - 1];

  try {
    const res = await cal.freebusy.query({
      requestBody: {
        timeMin: `${startDate}T00:00:00Z`,
        timeMax: `${endDate}T23:59:59Z`,
        items: [{ id: calId }],
      },
    });
    const busy = res.data.calendars?.[calId]?.busy || [];
    if (busy.length === 0) return true;

    for (const date of dates) {
      const dayStart = new Date(`${date}T00:00:00Z`).getTime();
      const dayEnd = new Date(`${date}T23:59:59Z`).getTime();
      for (const slot of busy) {
        const busyStart = new Date(slot.start || '').getTime();
        const busyEnd = new Date(slot.end || '').getTime();
        if (dayStart < busyEnd && dayEnd > busyStart) return false;
      }
    }
    return true;
  } catch (err) {
    logger.error({ error: err instanceof Error ? err.message : String(err) }, 'Calendar availability check failed');
    return true; // On error, allow booking (don't block customers)
  }
}

async function createCalendarEvent(
  equipmentKey: string,
  dates: string[],
  customer: { firstName: string; lastName: string; email: string; phone: string },
  deposit: number,
  paymentId: string,
): Promise<string> {
  const cal = getCal();
  const calId = CALENDAR_IDS[equipmentKey];
  if (!cal || !calId) return '';

  const eq = EQUIPMENT_CONFIG[equipmentKey];
  if (!eq) return '';

  const sorted = [...dates].sort();
  const startDate = sorted[0];
  const endDate = sorted[sorted.length - 1];
  const endPlusOne = new Date(`${endDate}T00:00:00Z`);
  endPlusOne.setUTCDate(endPlusOne.getUTCDate() + 1);
  const endDateStr = endPlusOne.toISOString().split('T')[0];

  const name = `${customer.firstName.trim()} ${customer.lastName.trim()}`;

  const res = await cal.events.insert({
    calendarId: calId,
    requestBody: {
      summary: `${eq.label} Rental — ${name}`,
      description: [
        `Customer: ${name}`,
        `Email: ${customer.email.trim()}`,
        `Phone: ${customer.phone.trim()}`,
        `Equipment: ${eq.label}`,
        `Duration: ${dates.length} ${eq.unit}${dates.length > 1 ? 's' : ''}`,
        `Deposit paid: $${deposit.toFixed(2)}`,
        `Square Payment: ${paymentId}`,
        '',
        'Booked via website',
      ].join('\n'),
      location: 'Tomball, TX',
      start: { date: startDate },
      end: { date: endDateStr },
    },
  });

  return res.data.id || '';
}

// ── SMTP ────────────────────────────────────────────────────────
function getSmtpTransporter(): nodemailer.Transporter | null {
  if (!smtpConfig.SMTP_HOST || !smtpConfig.SMTP_USER) return null;
  return nodemailer.createTransport({
    host: smtpConfig.SMTP_HOST,
    port: parseInt(smtpConfig.SMTP_PORT || '587', 10),
    secure: parseInt(smtpConfig.SMTP_PORT || '587', 10) === 465,
    auth: { user: smtpConfig.SMTP_USER, pass: smtpConfig.SMTP_PASS || '' },
  });
}

async function sendConfirmationEmails(
  req: CheckoutRequest,
  dateNote: string,
  amountCents: number,
  paymentId: string,
  receiptUrl: string,
  bookingId: string,
): Promise<void> {
  const transporter = getSmtpTransporter();
  if (!transporter) {
    logger.warn('SMTP not configured — skipping confirmation emails');
    return;
  }

  const { customer, equipment, addOns } = req;
  const name = `${customer.firstName.trim()} ${customer.lastName.trim()}`;
  const eqLabel = EQUIPMENT_CONFIG[equipment?.toLowerCase()]?.label || equipment;
  const depositStr = `$${(amountCents / 100).toFixed(2)}`;
  const from = smtpConfig.SMTP_FROM || smtpConfig.SMTP_USER;
  const addOnsList = addOns?.length ? addOns.map((a) => a.charAt(0).toUpperCase() + a.slice(1)).join(', ') : 'None';

  const customerHtml = `
<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:600px;margin:0 auto">
  <div style="background:#1d4ed8;color:#fff;padding:24px;text-align:center;border-radius:8px 8px 0 0">
    <h1 style="margin:0;font-size:24px">Booking Confirmed!</h1>
    <p style="margin:8px 0 0;opacity:0.9">Sheridan Rentals</p>
  </div>
  <div style="padding:24px;border:1px solid #e5e7eb;border-top:none;border-radius:0 0 8px 8px">
    <p>Hi ${customer.firstName.trim()},</p>
    <p>Thank you for your reservation! Your deposit has been received and your rental is confirmed.</p>
    <table style="width:100%;border-collapse:collapse;margin:16px 0">
      <tr><td style="padding:8px 0;color:#6b7280">Confirmation #</td><td style="padding:8px 0;font-weight:700">${bookingId}</td></tr>
      <tr><td style="padding:8px 0;color:#6b7280">Equipment</td><td style="padding:8px 0;font-weight:700">${eqLabel}</td></tr>
      <tr><td style="padding:8px 0;color:#6b7280">Dates</td><td style="padding:8px 0;font-weight:700">${dateNote}</td></tr>
      <tr><td style="padding:8px 0;color:#6b7280">Add-ons</td><td style="padding:8px 0">${addOnsList}</td></tr>
      <tr style="border-top:2px solid #e5e7eb"><td style="padding:12px 0;color:#6b7280;font-weight:700">Deposit Paid</td><td style="padding:12px 0;font-weight:700;color:#16a34a;font-size:18px">${depositStr}</td></tr>
    </table>
    <p style="background:#fef3c7;padding:12px;border-radius:6px;font-size:14px;color:#92400e">
      <strong>Reminder:</strong> Full rental payment is due at least 1 day before pickup. Your ${depositStr} deposit is refundable upon safe return of the equipment.
    </p>
    ${receiptUrl ? `<p style="text-align:center;margin:20px 0"><a href="${receiptUrl}" style="background:#1d4ed8;color:#fff;padding:12px 24px;border-radius:6px;text-decoration:none;font-weight:600">View Receipt</a></p>` : ''}
    <hr style="border:none;border-top:1px solid #e5e7eb;margin:20px 0">
    <p style="font-size:14px;color:#6b7280">Questions? Contact us:</p>
    <p style="font-size:14px"><a href="tel:+18175871460" style="color:#1d4ed8">(817) 587-1460</a> &nbsp;|&nbsp; <a href="mailto:${BUSINESS_EMAIL}" style="color:#1d4ed8">${BUSINESS_EMAIL}</a></p>
    <p style="font-size:12px;color:#9ca3af;margin-top:20px">Sheridan Rentals &bull; Houston, TX</p>
  </div>
</div>`;

  const bizHtml = `
<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:600px">
  <h2 style="color:#16a34a">New Booking Received &amp; Paid!</h2>
  <table style="width:100%;border-collapse:collapse">
    <tr><td style="padding:6px 0;color:#6b7280">Booking ID</td><td style="padding:6px 0;font-weight:700">${bookingId}</td></tr>
    <tr><td style="padding:6px 0;color:#6b7280">Customer</td><td style="padding:6px 0;font-weight:700">${name}</td></tr>
    <tr><td style="padding:6px 0;color:#6b7280">Email</td><td style="padding:6px 0"><a href="mailto:${customer.email.trim()}">${customer.email.trim()}</a></td></tr>
    <tr><td style="padding:6px 0;color:#6b7280">Phone</td><td style="padding:6px 0"><a href="tel:${customer.phone.trim()}">${customer.phone.trim()}</a></td></tr>
    <tr><td style="padding:6px 0;color:#6b7280">Equipment</td><td style="padding:6px 0;font-weight:700">${eqLabel}</td></tr>
    <tr><td style="padding:6px 0;color:#6b7280">Dates</td><td style="padding:6px 0">${dateNote}</td></tr>
    <tr><td style="padding:6px 0;color:#6b7280">Add-ons</td><td style="padding:6px 0">${addOnsList}</td></tr>
    <tr><td style="padding:6px 0;color:#6b7280">Deposit</td><td style="padding:6px 0;font-weight:700;color:#16a34a">${depositStr}</td></tr>
    <tr><td style="padding:6px 0;color:#6b7280">Payment ID</td><td style="padding:6px 0;font-size:12px">${paymentId}</td></tr>
  </table>
  ${receiptUrl ? `<p><a href="${receiptUrl}">View Square Receipt</a></p>` : ''}
  <p style="font-size:13px;color:#6b7280;margin-top:16px">This booking has been added to the Google Calendar and is visible to Andy.</p>
</div>`;

  const sends = [
    transporter.sendMail({
      from: `"Sheridan Rentals" <${from}>`,
      replyTo: 'info@sheridantrailerrentals.us',
      to: customer.email.trim(),
      subject: `Booking Confirmed — ${eqLabel} (${dateNote}) | ${bookingId}`,
      html: customerHtml,
    }),
    transporter.sendMail({
      from: `"Sheridan Rentals Booking" <${from}>`,
      replyTo: 'info@sheridantrailerrentals.us',
      to: BUSINESS_EMAIL,
      subject: `New Booking: ${name} — ${eqLabel} (${dateNote}) [${bookingId}]`,
      html: bizHtml,
    }),
  ];

  const results = await Promise.allSettled(sends);
  results.forEach((r, i) => {
    const target = i === 0 ? customer.email.trim() : BUSINESS_EMAIL;
    if (r.status === 'fulfilled') {
      logger.info({ to: target, paymentId, bookingId }, 'Confirmation email sent');
    } else {
      logger.error({ to: target, error: r.reason?.message || String(r.reason), paymentId }, 'Failed to send confirmation email');
    }
  });
}

// ── Types ───────────────────────────────────────────────────────
export interface CheckoutRequest {
  equipment: string;
  dates: string[] | { start: string; end: string };
  customer: {
    firstName: string;
    lastName: string;
    email: string;
    phone: string;
  };
  addOns?: string[];
  details?: string;
  timeSlot?: string;
  sourceId?: string;
}

export interface CheckoutResult {
  success: boolean;
  paymentId?: string;
  receiptUrl?: string;
  bookingId?: string;
  paymentUrl?: string;
  error?: string;
}

// ── Main Checkout Handler ───────────────────────────────────────
// Creates a pending booking and returns a Square payment link.
// The actual confirmation happens in handleSquareWebhook when payment completes.
export async function handleSquareCheckout(
  reqBody: CheckoutRequest,
): Promise<CheckoutResult> {
  const { equipment, customer } = reqBody;
  const eqKey = equipment?.toLowerCase();

  if (!ACCESS_TOKEN || !LOCATION_ID) {
    logger.error('Square credentials not configured');
    return { success: false, error: 'Payment system is not configured. Please contact us.' };
  }

  const amountCents = DEPOSIT_AMOUNTS[eqKey];
  if (!amountCents) {
    logger.warn({ equipment }, 'Checkout attempt with unknown equipment type');
    return { success: false, error: 'Invalid equipment selection. Please go back and select your equipment.' };
  }

  if (!customer || typeof customer !== 'object') {
    return { success: false, error: 'Missing customer information. Please go back and fill in your details.' };
  }
  if (!customer.firstName?.trim() || !customer.lastName?.trim()) {
    return { success: false, error: 'Please provide your first and last name.' };
  }
  if (!customer.email?.trim() || !customer.email.includes('@')) {
    return { success: false, error: 'Please provide a valid email address.' };
  }
  if (!customer.phone?.trim()) {
    return { success: false, error: 'Please provide your phone number.' };
  }

  if (!reqBody.dates || (Array.isArray(reqBody.dates) && reqBody.dates.length === 0)) {
    return { success: false, error: 'Please select your rental dates.' };
  }

  // Normalize dates
  let datesArr: string[];
  if (Array.isArray(reqBody.dates)) {
    datesArr = reqBody.dates.slice().sort();
  } else {
    const start = new Date(reqBody.dates.start);
    const end = new Date(reqBody.dates.end);
    datesArr = [];
    for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
      datesArr.push(d.toISOString().split('T')[0]);
    }
  }
  const dateNote = datesArr.length === 1 ? datesArr[0] : `${datesArr[0]} to ${datesArr[datesArr.length - 1]}`;

  // ── Check availability (calendar + DB) ──────────────────────────
  if (eqKey !== 'battery') {
    try {
      const d = getDb();
      const existing = d.prepare(
        `SELECT id, dates FROM bookings WHERE equipment = ? AND status IN ('pending', 'paid', 'confirmed')`,
      ).all(eqKey) as Array<{ id: string; dates: string }>;

      for (const row of existing) {
        const bookedDates: string[] = JSON.parse(row.dates);
        const overlap = datesArr.some((d) => bookedDates.includes(d));
        if (overlap) {
          logger.warn({ equipment: eqKey, dates: datesArr, conflictBooking: row.id }, 'Double-booking prevented (DB)');
          logMissedBooking({
            equipment: eqKey,
            equipmentLabel: EQUIPMENT_CONFIG[eqKey]?.label || equipment,
            dates: datesArr,
            customer,
            reason: 'DB overlap — dates already booked',
            conflictBookingId: row.id,
          });
          return { success: false, error: 'Some of your selected dates are no longer available. Please go back and choose different dates.' };
        }
      }
    } catch (err) {
      logger.error({ error: err instanceof Error ? err.message : String(err) }, 'DB availability check failed');
    }

    const available = await checkCalendarAvailability(eqKey, datesArr);
    if (!available) {
      logger.warn({ equipment: eqKey, dates: datesArr }, 'Double-booking prevented (Calendar)');
      logMissedBooking({
        equipment: eqKey,
        equipmentLabel: EQUIPMENT_CONFIG[eqKey]?.label || equipment,
        dates: datesArr,
        customer,
        reason: 'Calendar conflict — dates busy on Google Calendar',
      });
      return { success: false, error: 'Some of your selected dates are no longer available. Please go back and choose different dates.' };
    }
  }

  // ── Create pending booking in DB ──────────────────────────────
  const bookingId = generateBookingId();
  const eq = EQUIPMENT_CONFIG[eqKey];
  const depositDollars = amountCents / 100;
  const subtotal = (eq?.rate || 0) * datesArr.length;
  const balance = subtotal - depositDollars;
  const now = new Date().toISOString();

  try {
    const d = getDb();
    d.prepare(`INSERT INTO bookings (id, equipment, equipment_label, dates, num_days, customer_first, customer_last, customer_email, customer_phone, subtotal, deposit, balance, add_ons, details, status, square_order_id, square_payment_link_id, payment_url, calendar_event_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      bookingId, eqKey, eq?.label || equipment, JSON.stringify(datesArr), datesArr.length,
      customer.firstName.trim(), customer.lastName.trim(), customer.email.trim(), customer.phone.trim(),
      subtotal, depositDollars, balance > 0 ? balance : 0,
      JSON.stringify(reqBody.addOns || []), reqBody.details || '',
      'pending', '', '', '', '', now, now,
    );
    logger.info({ bookingId, equipment: eqKey }, 'Pending booking stored');
  } catch (err) {
    logger.error({ error: err instanceof Error ? err.message : String(err), bookingId }, 'Failed to store booking');
    return { success: false, error: 'Failed to create booking. Please try again.' };
  }

  // ── Create Square Payment Link ────────────────────────────────
  const name = `${customer.firstName.trim()} ${customer.lastName.trim()}`;
  const idempotencyKey = crypto.randomUUID();

  try {
    const resp = await fetch(`${BASE_URL}/v2/online-checkout/payment-links`, {
      method: 'POST',
      headers: {
        'Square-Version': '2024-11-20',
        Authorization: `Bearer ${ACCESS_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        idempotency_key: idempotencyKey,
        quick_pay: {
          name: `${eq?.label || equipment} Rental — ${dateNote}`,
          price_money: { amount: amountCents, currency: 'USD' },
          location_id: LOCATION_ID,
        },
        pre_populated_data: {
          buyer_email: customer.email.trim(),
          buyer_phone_number: normalizePhone(customer.phone.trim()),
        },
        payment_note: `Booking ${bookingId}: ${eq?.label} rental (${dateNote}) for ${name}`,
        checkout_options: {
          redirect_url: `https://sheridantrailerrentals.us/form/?confirmed=${bookingId}`,
        },
      }),
    });

    const data = (await resp.json()) as {
      payment_link?: { id: string; url: string; order_id: string };
      errors?: Array<{ detail: string; code: string }>;
    };

    if (!resp.ok || data.errors) {
      logger.error({ status: resp.status, errors: data.errors, bookingId }, 'Square payment link creation failed');
      try { getDb().prepare('DELETE FROM bookings WHERE id = ?').run(bookingId); } catch {}
      return { success: false, error: 'Could not create payment link. Please try again.' };
    }

    const linkId = data.payment_link?.id || '';
    const paymentUrl = data.payment_link?.url || '';
    const orderId = data.payment_link?.order_id || '';

    try {
      getDb().prepare('UPDATE bookings SET square_order_id = ?, square_payment_link_id = ?, payment_url = ?, updated_at = ? WHERE id = ?')
        .run(orderId, linkId, paymentUrl, new Date().toISOString(), bookingId);
    } catch {}

    logger.info({ bookingId, linkId, orderId, equipment: eqKey, customer: name }, 'Square payment link created');

    return {
      success: true,
      bookingId,
      paymentUrl,
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ error: message, bookingId }, 'Square payment link request exception');
    try { getDb().prepare('DELETE FROM bookings WHERE id = ?').run(bookingId); } catch {}
    return { success: false, error: 'A network error occurred. Please try again.' };
  }
}

// ── Square Webhook Handler ──────────────────────────────────────
// Called when Square sends payment.completed — confirms the booking,
// creates Google Calendar event, sends emails. Zero credits burned.
export async function handleSquareWebhook(body: string, signature: string): Promise<boolean> {
  const webhookSigKey = process.env.SQUARE_WEBHOOK_SIGNATURE_KEY || '';
  if (webhookSigKey && signature) {
    const hmac = crypto.createHmac('sha256', webhookSigKey);
    hmac.update(body);
    const expected = hmac.digest('base64');
    if (signature !== expected) {
      logger.warn('Square webhook signature mismatch');
      return false;
    }
  }

  let event: { type?: string; data?: { object?: { payment?: { id: string; order_id: string; receipt_url: string; status?: string; note?: string; buyer_email_address?: string; amount_money?: { amount: number } } } } };
  try {
    event = JSON.parse(body);
  } catch {
    logger.error('Square webhook: invalid JSON');
    return false;
  }

  if (event.type !== 'payment.completed' && event.type !== 'payment.updated' && event.type !== 'payment.created') {
    logger.info({ type: event.type }, 'Square webhook: ignoring non-payment event');
    return true;
  }

  const payment = event.data?.object?.payment;
  if (!payment) {
    logger.warn('Square webhook: no payment in event');
    return false;
  }

  // Only process completed payments (skip pending/failed)
  if (payment.status && payment.status !== 'COMPLETED') {
    logger.info({ type: event.type, status: payment.status }, 'Square webhook: ignoring non-completed payment');
    return true;
  }

  const { id: paymentId, order_id: orderId, receipt_url: receiptUrl } = payment;
  const amountCents = payment.amount_money?.amount || 0;
  logger.info({ paymentId, orderId, amountCents, status: payment.status }, 'Square webhook: payment completed');

  // ── Path 1: Check if we have a pending booking in our DB ──────
  const d = getDb();
  const booking = d.prepare(
    `SELECT * FROM bookings WHERE square_order_id = ? AND status = 'pending' LIMIT 1`,
  ).get(orderId) as {
    id: string; equipment: string; equipment_label: string; dates: string; num_days: number;
    customer_first: string; customer_last: string; customer_email: string; customer_phone: string;
    deposit: number; add_ons: string; details: string;
  } | undefined;

  if (booking) {
    return confirmBookingFromDb(booking, paymentId, receiptUrl || '');
  }

  // Check if this order was already confirmed (idempotency guard)
  const alreadyConfirmed = d.prepare(
    `SELECT id FROM bookings WHERE square_order_id = ? AND status = 'confirmed' LIMIT 1`,
  ).get(orderId) as { id: string } | undefined;
  if (alreadyConfirmed) {
    logger.info({ orderId, paymentId, bookingId: alreadyConfirmed.id }, 'Square webhook: order already confirmed, skipping duplicate');
    return true;
  }

  // ── Path 2: No DB booking — fetch order from Square API ───────
  // This handles bookings made through WordPress or manual payment links
  logger.info({ orderId, paymentId }, 'No pending booking in DB — fetching order from Square');
  return confirmBookingFromSquare(orderId, paymentId, receiptUrl || '', amountCents);
}

/** Confirm a booking we already have in our DB (from /api/checkout) */
async function confirmBookingFromDb(
  booking: { id: string; equipment: string; dates: string; customer_first: string; customer_last: string; customer_email: string; customer_phone: string; deposit: number; add_ons: string; details: string },
  paymentId: string,
  receiptUrl: string,
): Promise<boolean> {
  const datesArr: string[] = JSON.parse(booking.dates);
  const dateNote = datesArr.length === 1 ? datesArr[0] : `${datesArr[0]} to ${datesArr[datesArr.length - 1]}`;
  const customer = {
    firstName: booking.customer_first, lastName: booking.customer_last,
    email: booking.customer_email, phone: booking.customer_phone,
  };

  getDb().prepare('UPDATE bookings SET status = ?, updated_at = ? WHERE id = ?')
    .run('confirmed', new Date().toISOString(), booking.id);
  logger.info({ bookingId: booking.id, paymentId }, 'Booking confirmed via webhook (DB path)');

  createCalendarAndEmail(booking.equipment, datesArr, customer, booking.deposit, paymentId, receiptUrl, booking.id);
  return true;
}

/** Confirm a booking by fetching order details from Square API */
async function confirmBookingFromSquare(
  orderId: string, paymentId: string, receiptUrl: string, amountCents: number,
): Promise<boolean> {
  try {
    // Fetch the order to get line items and customer info
    const orderResp = await fetch(`${BASE_URL}/v2/orders/${orderId}`, {
      headers: { 'Square-Version': '2024-11-20', Authorization: `Bearer ${ACCESS_TOKEN}` },
    });

    if (!orderResp.ok) {
      logger.error({ status: orderResp.status, orderId }, 'Failed to fetch Square order');
      return true; // Don't retry
    }

    const orderData = (await orderResp.json()) as {
      order?: {
        id: string;
        line_items?: Array<{ name: string; note?: string; quantity: string }>;
        note?: string;
        fulfillments?: Array<{ pickup_details?: { note?: string; recipient?: { display_name?: string; email_address?: string; phone_number?: string } } }>;
        tenders?: Array<{ note?: string; customer_id?: string }>;
      };
    };

    const order = orderData.order;
    if (!order) {
      logger.warn({ orderId }, 'Square order not found');
      return true;
    }

    // Parse booking details from order
    const lineItem = order.line_items?.[0];
    const itemName = lineItem?.name || '';
    const orderNote = order.note || lineItem?.note || '';

    // Try to identify equipment from the line item name or amount
    let equipmentKey = 'rv'; // default
    const nameLower = itemName.toLowerCase();
    if (nameLower.includes('car hauler') || nameLower.includes('carhauler')) {
      equipmentKey = 'carhauler';
    } else if (nameLower.includes('landscaping')) {
      equipmentKey = 'landscaping';
    } else if (nameLower.includes('rv') || nameLower.includes('camper')) {
      equipmentKey = 'rv';
    } else {
      // Guess from amount: $65/day=carhauler, $50/day=landscaping, $150/night=rv
      const dollars = amountCents / 100;
      if (dollars % 65 === 0) equipmentKey = 'carhauler';
      else if (dollars % 50 === 0 && dollars % 150 !== 0) equipmentKey = 'landscaping';
      else equipmentKey = 'rv';
    }

    // Try to parse dates from the item name (format: "Equipment Rental — 2026-03-10 to 2026-03-15")
    let datesArr: string[] = [];
    const dateRangeMatch = itemName.match(/(\d{4}-\d{2}-\d{2})\s*to\s*(\d{4}-\d{2}-\d{2})/);
    const singleDateMatch = itemName.match(/(\d{4}-\d{2}-\d{2})/);
    if (dateRangeMatch) {
      const start = new Date(dateRangeMatch[1]);
      const end = new Date(dateRangeMatch[2]);
      for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
        datesArr.push(d.toISOString().split('T')[0]);
      }
    } else if (singleDateMatch) {
      datesArr = [singleDateMatch[1]];
    }

    // If no dates found, estimate from amount and rate
    if (datesArr.length === 0) {
      const eq = EQUIPMENT_CONFIG[equipmentKey];
      if (eq && eq.rate > 0) {
        const numDays = Math.round(amountCents / 100 / eq.rate);
        const startDate = new Date();
        startDate.setDate(startDate.getDate() + 1); // tomorrow as default start
        for (let i = 0; i < Math.max(numDays, 1); i++) {
          const d = new Date(startDate);
          d.setDate(d.getDate() + i);
          datesArr.push(d.toISOString().split('T')[0]);
        }
        logger.warn({ equipmentKey, numDays, datesArr }, 'Dates estimated from payment amount — verify in calendar');
      }
    }

    // Try to get customer info from fulfillment or payment
    let customerName = '';
    let customerEmail = '';
    let customerPhone = '';

    const fulfillment = order.fulfillments?.[0];
    if (fulfillment?.pickup_details?.recipient) {
      const r = fulfillment.pickup_details.recipient;
      customerName = r.display_name || '';
      customerEmail = r.email_address || '';
      customerPhone = r.phone_number || '';
    }

    // Fallback: try to get from payment
    if (!customerName || !customerEmail) {
      const payResp = await fetch(`${BASE_URL}/v2/payments/${paymentId}`, {
        headers: { 'Square-Version': '2024-11-20', Authorization: `Bearer ${ACCESS_TOKEN}` },
      });
      if (payResp.ok) {
        const payData = (await payResp.json()) as {
          payment?: { buyer_email_address?: string; note?: string; card_details?: { card?: { cardholder_name?: string } } };
        };
        const p = payData.payment;
        if (p?.buyer_email_address) customerEmail = p.buyer_email_address;
        if (p?.card_details?.card?.cardholder_name) customerName = customerName || p.card_details.card.cardholder_name;
      }
    }

    // Parse name into first/last
    const nameParts = customerName.trim().split(/\s+/);
    const firstName = nameParts[0] || 'Customer';
    const lastName = nameParts.slice(1).join(' ') || '';

    const eq = EQUIPMENT_CONFIG[equipmentKey];
    const depositDollars = amountCents / 100;
    const dateNote = datesArr.length <= 1 ? (datesArr[0] || 'TBD') : `${datesArr[0]} to ${datesArr[datesArr.length - 1]}`;

    logger.info({
      equipmentKey, dateNote, customerName, customerEmail, amountCents, orderId,
    }, 'Parsed booking from Square order');

    // Store in our DB
    const bookingId = generateBookingId();
    const now = new Date().toISOString();
    const subtotal = (eq?.rate || 0) * datesArr.length;
    try {
      getDb().prepare(`INSERT INTO bookings (id, equipment, equipment_label, dates, num_days, customer_first, customer_last, customer_email, customer_phone, subtotal, deposit, balance, add_ons, details, status, square_order_id, square_payment_link_id, payment_url, calendar_event_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        bookingId, equipmentKey, eq?.label || equipmentKey, JSON.stringify(datesArr), datesArr.length,
        firstName, lastName, customerEmail, customerPhone,
        subtotal, depositDollars, 0, '[]', `Auto-imported from Square payment ${paymentId}`,
        'confirmed', orderId, '', receiptUrl, '', now, now,
      );
    } catch (err) {
      logger.error({ error: err instanceof Error ? err.message : String(err) }, 'Failed to store imported booking');
    }

    const customer = { firstName, lastName, email: customerEmail, phone: customerPhone };
    createCalendarAndEmail(equipmentKey, datesArr, customer, depositDollars, paymentId, receiptUrl, bookingId);
    return true;
  } catch (err) {
    logger.error({ error: err instanceof Error ? err.message : String(err), orderId }, 'Failed to process Square order');
    return true;
  }
}

/** Shared: create calendar event + send emails (non-blocking) */
function createCalendarAndEmail(
  equipmentKey: string, datesArr: string[],
  customer: { firstName: string; lastName: string; email: string; phone: string },
  depositDollars: number, paymentId: string, receiptUrl: string, bookingId: string,
): void {
  const dateNote = datesArr.length <= 1 ? (datesArr[0] || 'TBD') : `${datesArr[0]} to ${datesArr[datesArr.length - 1]}`;

  (async () => {
    try {
      const eventId = await createCalendarEvent(equipmentKey, datesArr, customer, depositDollars, paymentId);
      if (eventId) {
        try {
          getDb().prepare('UPDATE bookings SET calendar_event_id = ?, updated_at = ? WHERE id = ?')
            .run(eventId, new Date().toISOString(), bookingId);
        } catch {}
        logger.info({ bookingId, eventId, equipmentKey }, 'Google Calendar event created');
      }
    } catch (err) {
      logger.error({ error: err instanceof Error ? err.message : String(err), bookingId }, 'Failed to create calendar event');
    }
  })();

  const depositCents = Math.round(depositDollars * 100);
  sendConfirmationEmails(
    { equipment: equipmentKey, dates: datesArr, customer, addOns: [], details: '' },
    dateNote, depositCents, paymentId, receiptUrl, bookingId,
  ).catch((err) => {
    logger.error({ error: err instanceof Error ? err.message : String(err) }, 'Confirmation email error');
  });
}

// ── Availability query (for /api/availability endpoint) ─────────────
export async function getAvailabilityBusySlots(
  equipmentKey: string,
  startDate: string,
  endDate: string,
): Promise<{ start: string; end: string }[]> {
  const busySlots: { start: string; end: string }[] = [];

  // ── Source 1: Google Calendar ──
  const cal = getCal();
  const calId = CALENDAR_IDS[equipmentKey];
  if (cal && calId) {
    try {
      const res = await cal.freebusy.query({
        requestBody: {
          timeMin: `${startDate}T00:00:00Z`,
          timeMax: `${endDate}T23:59:59Z`,
          items: [{ id: calId }],
        },
      });
      const busy = res.data.calendars?.[calId]?.busy || [];
      for (const slot of busy) {
        if (slot.start && slot.end) {
          busySlots.push({ start: slot.start, end: slot.end });
        }
      }
    } catch (err) {
      logger.error({ error: err instanceof Error ? err.message : String(err) }, 'Calendar availability query failed');
    }
  }

  // ── Source 2: Local database (confirmed bookings) ──
  try {
    const db = getDb();
    const rows = db.prepare(
      `SELECT dates FROM bookings WHERE equipment = ? AND status = 'confirmed'`,
    ).all(equipmentKey) as { dates: string }[];

    for (const row of rows) {
      let dates: string[];
      try { dates = JSON.parse(row.dates); } catch { continue; }
      for (const d of dates) {
        // Only include dates within the requested range
        if (d >= startDate && d <= endDate) {
          busySlots.push({ start: `${d}T00:00:00Z`, end: `${d}T23:59:59Z` });
        }
      }
    }
  } catch (err) {
    logger.error({ error: err instanceof Error ? err.message : String(err) }, 'DB availability query failed');
  }

  return busySlots;
}
