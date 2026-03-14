/**
 * SQLite database for Sheridan Rentals bookings.
 * Adapted from nanoclaw/src/db.ts pattern.
 * Uses better-sqlite3 for synchronous operations.
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import type { Booking, BookingStatus, Customer, EquipmentKey } from './types.js';

let db: Database.Database;

export function initDb(dbPath?: string): void {
  const file = dbPath || path.join(process.cwd(), 'data', 'bookings.db');
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });

  db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  createSchema();
}

function createSchema(): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS bookings (
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
    );

    CREATE INDEX IF NOT EXISTS idx_bookings_status ON bookings(status);
    CREATE INDEX IF NOT EXISTS idx_bookings_equipment_dates ON bookings(equipment, dates);
    CREATE INDEX IF NOT EXISTS idx_bookings_square_order ON bookings(square_order_id);
  `);

  // Migrations — add columns that may not exist in older databases
  const migrations = [
    `ALTER TABLE bookings ADD COLUMN refund_id TEXT NOT NULL DEFAULT ''`,
    `ALTER TABLE bookings ADD COLUMN followup_sent INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE bookings ADD COLUMN followup_sent_at TEXT`,
  ];
  for (const sql of migrations) {
    try { db.exec(sql); } catch { /* column already exists */ }
  }
}

// ── Generate Booking ID ─────────────────────────────────────────────

export function generateBookingId(): string {
  // Short, URL-safe booking ID: SR-XXXXXXXX
  return `SR-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
}

// ── CRUD Operations ─────────────────────────────────────────────────

export function createBooking(params: {
  id: string;
  equipment: EquipmentKey;
  equipmentLabel: string;
  dates: string[];
  numDays: number;
  customer: Customer;
  subtotal: number;
  deposit: number;
  balance: number;
  addOns: string[];
  details: string;
  squareOrderId: string;
  squarePaymentLinkId: string;
  paymentUrl: string;
}): Booking {
  const now = new Date().toISOString();

  db.prepare(`
    INSERT INTO bookings (
      id, equipment, equipment_label, dates, num_days,
      customer_first, customer_last, customer_email, customer_phone,
      subtotal, deposit, balance, add_ons, details, status,
      square_order_id, square_payment_link_id, payment_url,
      calendar_event_id, created_at, updated_at
    ) VALUES (
      ?, ?, ?, ?, ?,
      ?, ?, ?, ?,
      ?, ?, ?, ?, ?, 'pending',
      ?, ?, ?,
      '', ?, ?
    )
  `).run(
    params.id, params.equipment, params.equipmentLabel,
    JSON.stringify(params.dates), params.numDays,
    params.customer.firstName, params.customer.lastName,
    params.customer.email, params.customer.phone,
    params.subtotal, params.deposit, params.balance,
    JSON.stringify(params.addOns), params.details,
    params.squareOrderId, params.squarePaymentLinkId, params.paymentUrl,
    now, now,
  );

  return getBooking(params.id)!;
}

export function getBooking(id: string): Booking | null {
  const row = db.prepare('SELECT * FROM bookings WHERE id = ?').get(id) as any;
  if (!row) return null;
  return rowToBooking(row);
}

export function getBookingByOrderId(orderId: string): Booking | null {
  const row = db.prepare('SELECT * FROM bookings WHERE square_order_id = ?').get(orderId) as any;
  if (!row) return null;
  return rowToBooking(row);
}

export function updateBookingStatus(id: string, status: BookingStatus): void {
  db.prepare('UPDATE bookings SET status = ?, updated_at = ? WHERE id = ?')
    .run(status, new Date().toISOString(), id);
}

export function setCalendarEventId(id: string, eventId: string): void {
  db.prepare('UPDATE bookings SET calendar_event_id = ?, updated_at = ? WHERE id = ?')
    .run(eventId, new Date().toISOString(), id);
}

export function cancelBooking(id: string, refundId?: string): void {
  db.prepare(`
    UPDATE bookings
    SET status = 'cancelled',
        updated_at = ?,
        refund_id = COALESCE(?, refund_id)
    WHERE id = ?
  `).run(new Date().toISOString(), refundId || null, id);
}

export function getBookingsByEmail(email: string): Booking[] {
  const rows = db.prepare(`
    SELECT * FROM bookings
    WHERE customer_email = ? AND status != 'cancelled'
    ORDER BY created_at DESC
  `).all(email) as any[];
  return rows.map(rowToBooking);
}

export function getActiveBookings(): Booking[] {
  const rows = db.prepare(`
    SELECT * FROM bookings
    WHERE status IN ('pending', 'confirmed')
    ORDER BY created_at DESC
  `).all() as any[];
  return rows.map(rowToBooking);
}

// ── Double-Booking Prevention ───────────────────────────────────────

export function hasOverlappingBooking(equipment: EquipmentKey, dates: string[]): boolean {
  // Check if any non-cancelled booking overlaps with the requested dates
  const rows = db.prepare(`
    SELECT dates FROM bookings
    WHERE equipment = ? AND status != 'cancelled'
  `).all(equipment) as Array<{ dates: string }>;

  const requestedSet = new Set(dates);

  for (const row of rows) {
    const bookedDates: string[] = JSON.parse(row.dates);
    for (const d of bookedDates) {
      if (requestedSet.has(d)) return true;
    }
  }
  return false;
}

// ── Helpers ─────────────────────────────────────────────────────────

function rowToBooking(row: any): Booking {
  return {
    id: row.id,
    equipment: row.equipment,
    equipmentLabel: row.equipment_label,
    dates: JSON.parse(row.dates),
    numDays: row.num_days,
    customer: {
      firstName: row.customer_first,
      lastName: row.customer_last,
      email: row.customer_email,
      phone: row.customer_phone,
    },
    subtotal: row.subtotal,
    deposit: row.deposit,
    balance: row.balance,
    addOns: JSON.parse(row.add_ons),
    details: row.details,
    status: row.status,
    squareOrderId: row.square_order_id,
    squarePaymentLinkId: row.square_payment_link_id,
    paymentUrl: row.payment_url,
    calendarEventId: row.calendar_event_id,
    refundId: row.refund_id || '',
    followupSent: !!row.followup_sent,
    followupSentAt: row.followup_sent_at || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
