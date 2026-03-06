#!/usr/bin/env tsx
/**
 * Sheridan Rentals Booking Query Tool
 * Read-only queries against the bookings SQLite database.
 *
 * Usage:
 *   query-bookings.ts list [--status <status>] [--equipment <key>] [--days <n>]
 *   query-bookings.ts get <booking-id>
 *   query-bookings.ts summary
 *   query-bookings.ts digest
 */
import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

// ── Find Database ───────────────────────────────────────────────────

const DB_PATHS = [
  '/workspace/extra/booking-data/bookings.db',
  '/workspace/project/services/booking/data/bookings.db',
  path.join(process.cwd(), 'data', 'bookings.db'),
];

function findDb(): string {
  for (const p of DB_PATHS) {
    if (fs.existsSync(p)) return p;
  }
  console.error(JSON.stringify({ error: 'Bookings database not found', searched: DB_PATHS }));
  process.exit(1);
}

const db = new Database(findDb(), { readonly: true });

// ── Types ───────────────────────────────────────────────────────────

interface BookingRow {
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
  add_ons: string;
  details: string;
  status: string;
  square_order_id: string;
  calendar_event_id: string;
  created_at: string;
  updated_at: string;
}

function formatRow(row: BookingRow) {
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
    addOns: JSON.parse(row.add_ons),
    details: row.details,
    status: row.status,
    hasCalendarEvent: !!row.calendar_event_id,
    createdAt: row.created_at,
  };
}

// ── Commands ────────────────────────────────────────────────────────

function cmdList(args: string[]) {
  let status: string | null = null;
  let equipment: string | null = null;
  let days: number | null = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--status' && args[i + 1]) { status = args[++i]; }
    else if (args[i] === '--equipment' && args[i + 1]) { equipment = args[++i]; }
    else if (args[i] === '--days' && args[i + 1]) { days = parseInt(args[++i], 10); }
  }

  let sql = 'SELECT * FROM bookings WHERE 1=1';
  const params: any[] = [];

  if (status) {
    sql += ' AND status = ?';
    params.push(status);
  }
  if (equipment) {
    sql += ' AND equipment = ?';
    params.push(equipment);
  }
  if (days) {
    // Filter to bookings with at least one date within the next N days
    const today = new Date().toISOString().split('T')[0];
    const future = new Date(Date.now() + days * 86400000).toISOString().split('T')[0];
    // SQLite JSON: check if any date in the array falls in range
    sql += ` AND EXISTS (
      SELECT 1 FROM json_each(dates) AS d
      WHERE d.value >= ? AND d.value <= ?
    )`;
    params.push(today, future);
  }

  sql += ' ORDER BY created_at DESC LIMIT 50';

  const rows = db.prepare(sql).all(...params) as BookingRow[];
  console.log(JSON.stringify({
    count: rows.length,
    bookings: rows.map(formatRow),
  }, null, 2));
}

function cmdGet(bookingId: string) {
  const row = db.prepare('SELECT * FROM bookings WHERE id = ?').get(bookingId) as BookingRow | undefined;
  if (!row) {
    console.log(JSON.stringify({ error: `Booking ${bookingId} not found` }));
    process.exit(1);
  }
  console.log(JSON.stringify(formatRow(row), null, 2));
}

function cmdSummary() {
  const today = new Date().toISOString().split('T')[0];
  const weekEnd = new Date(Date.now() + 7 * 86400000).toISOString().split('T')[0];

  const upcoming = db.prepare(`
    SELECT * FROM bookings
    WHERE status IN ('confirmed', 'paid')
    AND EXISTS (
      SELECT 1 FROM json_each(dates) AS d
      WHERE d.value >= ? AND d.value <= ?
    )
    ORDER BY created_at ASC
  `).all(today, weekEnd) as BookingRow[];

  const byEquipment: Record<string, any[]> = {};
  for (const row of upcoming) {
    const key = row.equipment_label;
    if (!byEquipment[key]) byEquipment[key] = [];
    byEquipment[key].push(formatRow(row));
  }

  console.log(JSON.stringify({
    period: `${today} to ${weekEnd}`,
    totalBookings: upcoming.length,
    byEquipment,
  }, null, 2));
}

function cmdDigest() {
  const now = new Date();
  const today = now.toISOString().split('T')[0];
  const tomorrow = new Date(now.getTime() + 86400000).toISOString().split('T')[0];
  const weekEnd = new Date(now.getTime() + 7 * 86400000).toISOString().split('T')[0];

  // Tomorrow's bookings (pickups starting tomorrow)
  const tomorrowBookings = db.prepare(`
    SELECT * FROM bookings
    WHERE status IN ('confirmed', 'paid')
    AND EXISTS (
      SELECT 1 FROM json_each(dates) AS d WHERE d.value = ?
    )
  `).all(tomorrow) as BookingRow[];

  // This week's bookings
  const weekBookings = db.prepare(`
    SELECT * FROM bookings
    WHERE status IN ('confirmed', 'paid')
    AND EXISTS (
      SELECT 1 FROM json_each(dates) AS d
      WHERE d.value >= ? AND d.value <= ?
    )
    ORDER BY created_at ASC
  `).all(today, weekEnd) as BookingRow[];

  // Pending bookings (awaiting payment)
  const pending = db.prepare(`
    SELECT * FROM bookings WHERE status = 'pending'
    ORDER BY created_at DESC LIMIT 10
  `).all() as BookingRow[];

  // Revenue for the week
  const weekRevenue = weekBookings.reduce((sum, r) => sum + r.subtotal, 0);

  // Recent bookings (last 24h)
  const oneDayAgo = new Date(now.getTime() - 86400000).toISOString();
  const recentBookings = db.prepare(`
    SELECT * FROM bookings WHERE created_at >= ?
    ORDER BY created_at DESC
  `).all(oneDayAgo) as BookingRow[];

  console.log(JSON.stringify({
    date: today,
    tomorrowPickups: tomorrowBookings.map(formatRow),
    thisWeek: {
      count: weekBookings.length,
      revenue: weekRevenue,
      bookings: weekBookings.map(formatRow),
    },
    pendingPayment: pending.map(formatRow),
    last24h: recentBookings.map(formatRow),
  }, null, 2));
}

// ── CLI Router ──────────────────────────────────────────────────────

const args = process.argv.slice(2);
const command = args[0];

switch (command) {
  case 'list':
    cmdList(args.slice(1));
    break;
  case 'get':
    if (!args[1]) {
      console.error(JSON.stringify({ error: 'Usage: query-bookings.ts get <booking-id>' }));
      process.exit(1);
    }
    cmdGet(args[1]);
    break;
  case 'summary':
    cmdSummary();
    break;
  case 'digest':
    cmdDigest();
    break;
  default:
    console.error(JSON.stringify({
      error: `Unknown command: ${command}`,
      usage: [
        'list [--status confirmed] [--equipment rv] [--days 7]',
        'get <booking-id>',
        'summary',
        'digest',
      ],
    }));
    process.exit(1);
}
