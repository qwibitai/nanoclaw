/**
 * Sheridan Rentals Booking API Server
 *
 * Lightweight HTTP server on port 3200 (no Express).
 * Endpoints:
 *   POST /api/availability   — Check booked date ranges from Google Calendar
 *   POST /api/checkout       — Validate, price, create Square payment link, store booking
 *   POST /api/square-webhook — Payment confirmation → calendar event + email
 *   GET  /api/booking/:id    — Confirmation page data
 *   GET  /health             — Health check
 */
import http from 'http';
import { readEnvFile } from './env.js';
import { EQUIPMENT, calculatePrice } from './pricing.js';
import { getBookedSlots, datesAreAvailable, createBookingEvent, deleteCalendarEvent } from './calendar.js';
import { createPaymentLink, checkOrderPayment, refundPayment } from './square.js';
import {
  initDb, generateBookingId, createBooking, getBooking,
  getBookingByOrderId, updateBookingStatus, setCalendarEventId,
  hasOverlappingBooking, cancelBooking, getActiveBookings, getBookingsByEmail,
} from './db.js';
import {
  sendOwnerNotification, sendCustomerConfirmation,
  sendPaymentReceivedNotification, sendCancellationConfirmation,
} from './email.js';
import type { AvailabilityRequest, CheckoutRequest, EquipmentKey } from './types.js';

// ── Config ──────────────────────────────────────────────────────────

let PORT = 3200;
let ALLOWED_ORIGINS: string[] = ['https://sheridantrailerrentals.us'];

// ── Load env ────────────────────────────────────────────────────────

const envKeys = [
  'SQUARE_ACCESS_TOKEN', 'SQUARE_LOCATION_ID', 'SQUARE_ENVIRONMENT',
  'GOOGLE_SERVICE_ACCOUNT_KEY',
  'SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'SMTP_FROM',
  'BOOKING_PORT', 'BOOKING_ALLOWED_ORIGIN', 'BOOKING_CONFIRMATION_URL',
];

function loadEnv(): void {
  const env = readEnvFile(envKeys);
  for (const [k, v] of Object.entries(env)) {
    if (!process.env[k]) process.env[k] = v;
  }
}

// ── Request Helpers ─────────────────────────────────────────────────

function readBody(req: http.IncomingMessage, maxSize = 1_048_576): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxSize) { req.destroy(); reject(new Error('Payload too large')); return; }
      body += chunk;
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function json(res: http.ServerResponse, status: number, data: unknown): void {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function cors(req: http.IncomingMessage, res: http.ServerResponse): void {
  const origin = req.headers.origin || '';
  if (ALLOWED_ORIGINS.includes('*') || ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin || '*');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

// ── Rate Limiting ───────────────────────────────────────────────────

const rateMap = new Map<string, { count: number; ts: number }>();
const RATE_WINDOW = 60_000;
const RATE_MAX = 20;

function isRateLimited(ip: string): boolean {
  const now = Date.now();
  const entry = rateMap.get(ip);
  if (!entry || now - entry.ts > RATE_WINDOW) {
    rateMap.set(ip, { count: 1, ts: now });
    return false;
  }
  entry.count++;
  return entry.count > RATE_MAX;
}

setInterval(() => {
  const cutoff = Date.now() - RATE_WINDOW * 2;
  for (const [ip, entry] of rateMap) {
    if (entry.ts < cutoff) rateMap.delete(ip);
  }
}, 300_000);

// ── Handlers ────────────────────────────────────────────────────────

async function handleAvailability(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const body = JSON.parse(await readBody(req)) as AvailabilityRequest;

  if (!body.equipment || !EQUIPMENT[body.equipment]) {
    json(res, 400, { error: 'Invalid equipment type' });
    return;
  }
  if (!body.startDate || !body.endDate) {
    json(res, 400, { error: 'startDate and endDate required (YYYY-MM-DD)' });
    return;
  }

  const busySlots = await getBookedSlots(body.equipment, body.startDate, body.endDate);
  json(res, 200, {
    equipment: body.equipment,
    startDate: body.startDate,
    endDate: body.endDate,
    busySlots,
  });
}

async function handleCheckout(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const body = JSON.parse(await readBody(req)) as CheckoutRequest;

  // Validate
  if (!body.equipment || !EQUIPMENT[body.equipment]) {
    json(res, 400, { error: 'Invalid equipment type' });
    return;
  }
  if (!body.dates || body.dates.length === 0) {
    json(res, 400, { error: 'No dates selected' });
    return;
  }
  if (!body.customer?.firstName || !body.customer?.lastName) {
    json(res, 400, { error: 'Customer name required' });
    return;
  }
  if (!body.customer?.email?.includes('@')) {
    json(res, 400, { error: 'Valid email required' });
    return;
  }
  if (!body.customer?.phone) {
    json(res, 400, { error: 'Phone number required' });
    return;
  }

  const dates = [...body.dates].sort();
  const numDays = dates.length;
  const equipmentKey = body.equipment as EquipmentKey;

  // Double-booking prevention: check DB first (fast), then calendar (authoritative)
  if (hasOverlappingBooking(equipmentKey, dates)) {
    json(res, 409, { error: 'Those dates are already booked. Please choose different dates.' });
    return;
  }

  const available = await datesAreAvailable(equipmentKey, dates);
  if (!available) {
    json(res, 409, { error: 'Equipment is not available for the selected dates.' });
    return;
  }

  // Calculate pricing
  const pricing = calculatePrice(equipmentKey, numDays, body.addOns || []);

  // Generate booking ID and create Square payment link
  const bookingId = generateBookingId();

  let paymentResult;
  try {
    paymentResult = await createPaymentLink(pricing, body.customer, bookingId);
  } catch (err: any) {
    console.error('[checkout] Square error:', err.message);
    json(res, 502, { error: 'Failed to create payment link. Please try again.' });
    return;
  }

  // Store booking in DB
  const booking = createBooking({
    id: bookingId,
    equipment: equipmentKey,
    equipmentLabel: pricing.equipment.label,
    dates,
    numDays,
    customer: body.customer,
    subtotal: pricing.subtotal,
    deposit: pricing.deposit,
    balance: pricing.balance,
    addOns: pricing.addOns,
    details: body.details || '',
    squareOrderId: paymentResult.orderId,
    squarePaymentLinkId: paymentResult.paymentLinkId,
    paymentUrl: paymentResult.paymentUrl,
  });

  // Send owner notification (don't block response)
  sendOwnerNotification(booking).catch(err =>
    console.error('[checkout] Email error:', err.message),
  );

  json(res, 200, {
    bookingId: booking.id,
    paymentUrl: paymentResult.paymentUrl,
    pricing: {
      subtotal: pricing.subtotal,
      deposit: pricing.deposit,
      balance: pricing.balance,
      lineItems: pricing.lineItems,
    },
  });
}

async function handleSquareWebhook(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const body = await readBody(req);

  // Respond immediately per Square best practice
  json(res, 200, { ok: true });

  try {
    const payload = JSON.parse(body);
    if (payload.type !== 'payment.completed') return;

    const payment = payload.data?.object?.payment;
    if (!payment) return;

    const orderId = payment.order_id;
    if (!orderId) return;

    console.log(`[webhook] Payment completed for order ${orderId}`);

    // Find the booking
    const booking = getBookingByOrderId(orderId);
    if (!booking) {
      console.warn(`[webhook] No booking found for order ${orderId}`);
      return;
    }

    if (booking.status !== 'pending') {
      console.log(`[webhook] Booking ${booking.id} already processed (status: ${booking.status})`);
      return;
    }

    // Full payment received upfront — go straight to confirmed
    updateBookingStatus(booking.id, 'confirmed');

    // Create calendar event
    try {
      const eventId = await createBookingEvent(
        booking.equipment,
        booking.dates,
        booking.customer,
        {
          subtotal: booking.subtotal,
          deposit: booking.deposit,
          balance: booking.balance,
          addOns: booking.addOns,
        },
      );
      setCalendarEventId(booking.id, eventId);
      console.log(`[webhook] Calendar event created: ${eventId}`);
    } catch (err: any) {
      console.error(`[webhook] Calendar error: ${err.message}`);
      // Don't fail the booking — it's paid, calendar can be added manually
    }

    // Refresh booking with updated fields
    const updatedBooking = getBooking(booking.id)!;

    // Send emails (non-blocking)
    sendCustomerConfirmation(updatedBooking).catch(err =>
      console.error(`[webhook] CRITICAL: Customer confirmation email failed after retries: ${err.message}. Booking ${updatedBooking.id} — manual follow-up required.`),
    );
    sendPaymentReceivedNotification(updatedBooking).catch(err =>
      console.error(`[webhook] CRITICAL: Owner payment notification email failed after retries: ${err.message}. Booking ${updatedBooking.id} — manual follow-up required.`),
    );

  } catch (err: any) {
    console.error(`[webhook] Parse error: ${err.message}`);
  }
}

async function handleCancel(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const body = JSON.parse(await readBody(req));
  const { bookingId, refund } = body as { bookingId: string; refund?: boolean };

  if (!bookingId) {
    json(res, 400, { error: 'bookingId required' });
    return;
  }

  const booking = getBooking(bookingId);
  if (!booking) {
    json(res, 404, { error: 'Booking not found' });
    return;
  }

  if (booking.status === 'cancelled') {
    json(res, 409, { error: 'Booking already cancelled' });
    return;
  }

  let refundResult = null;

  // Process refund if booking was paid/confirmed and refund requested
  if (refund !== false && booking.status === 'confirmed' && booking.squareOrderId) {
    try {
      refundResult = await refundPayment(booking.squareOrderId);
    } catch (err: any) {
      console.error(`[cancel] Refund error: ${err.message}`);
      // Don't fail the cancellation — still cancel the booking
    }
  }

  // Cancel the booking in DB
  cancelBooking(booking.id, refundResult?.refundId);

  // Delete calendar event if it exists
  if (booking.calendarEventId) {
    try {
      await deleteCalendarEvent(booking.equipment as EquipmentKey, booking.calendarEventId);
      console.log(`[cancel] Calendar event deleted: ${booking.calendarEventId}`);
    } catch (err: any) {
      console.error(`[cancel] Calendar delete error: ${err.message}`);
    }
  }

  // Send cancellation email (non-blocking)
  sendCancellationConfirmation(booking, refundResult?.amountCents || 0).catch(err =>
    console.error(`[cancel] Email error: ${err.message}`),
  );

  json(res, 200, {
    cancelled: true,
    bookingId: booking.id,
    refund: refundResult ? {
      refundId: refundResult.refundId,
      status: refundResult.status,
      amount: (refundResult.amountCents / 100).toFixed(2),
    } : null,
  });
}

function handleGetBooking(res: http.ServerResponse, bookingId: string): void {
  const booking = getBooking(bookingId);
  if (!booking) {
    json(res, 404, { error: 'Booking not found' });
    return;
  }

  // Build formatted date range
  const sorted = [...booking.dates].sort();
  const dateRange = sorted.length === 1
    ? formatDatePretty(sorted[0])
    : `${formatDatePretty(sorted[0])} — ${formatDatePretty(sorted[sorted.length - 1])}`;

  // Get unit from equipment config
  const equipConfig = EQUIPMENT[booking.equipment];
  const unit = equipConfig?.unit || 'day';

  json(res, 200, {
    id: booking.id,
    equipment: booking.equipmentLabel,
    equipmentLabel: booking.equipmentLabel,
    dates: booking.dates,
    dateRange,
    numDays: booking.numDays,
    unit,
    subtotal: booking.subtotal,
    total: booking.subtotal, // Full amount charged upfront
    deposit: booking.subtotal, // Paid in full
    balance: 0,
    status: booking.status,
    addOns: booking.addOns,
    customer: {
      firstName: booking.customer.firstName,
      lastName: booking.customer.lastName,
    },
    createdAt: booking.createdAt,
  });
}

function formatDatePretty(dateStr: string): string {
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const parts = dateStr.split('-');
  if (parts.length === 3) {
    return `${months[parseInt(parts[1], 10) - 1]} ${parseInt(parts[2], 10)}, ${parts[0]}`;
  }
  return dateStr;
}

// ── Router ──────────────────────────────────────────────────────────

async function handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const ip = req.headers['x-forwarded-for']?.toString().split(',')[0].trim()
    || req.socket.remoteAddress || 'unknown';

  cors(req, res);

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  if (isRateLimited(ip)) {
    json(res, 429, { error: 'Rate limited' });
    return;
  }

  const url = req.url || '';

  try {
    // GET /health
    if (req.method === 'GET' && url === '/health') {
      json(res, 200, { status: 'ok', service: 'sheridan-booking' });
      return;
    }

    // POST /api/availability
    if (req.method === 'POST' && url === '/api/availability') {
      await handleAvailability(req, res);
      return;
    }

    // POST /api/checkout
    if (req.method === 'POST' && url === '/api/checkout') {
      await handleCheckout(req, res);
      return;
    }

    // POST /api/square-webhook
    if (req.method === 'POST' && url === '/api/square-webhook') {
      await handleSquareWebhook(req, res);
      return;
    }

    // POST /api/cancel
    if (req.method === 'POST' && url === '/api/cancel') {
      await handleCancel(req, res);
      return;
    }

    // GET /api/booking/:id
    if (req.method === 'GET' && url.startsWith('/api/booking/')) {
      const bookingId = url.split('/api/booking/')[1]?.split('?')[0];
      if (bookingId) {
        handleGetBooking(res, bookingId);
        return;
      }
    }

    // Also support the legacy endpoint used by the widget
    if (req.method === 'POST' && url === '/api/create-booking') {
      await handleCheckout(req, res);
      return;
    }

    // Legacy booking status endpoint
    if (req.method === 'GET' && url.startsWith('/api/booking-status')) {
      const params = new URL(url, 'http://localhost').searchParams;
      const id = params.get('id');
      if (id) {
        handleGetBooking(res, id);
        return;
      }
    }

    json(res, 404, { error: 'Not found' });
  } catch (err: any) {
    console.error(`[server] Error handling ${req.method} ${url}:`, err.message);
    json(res, 500, { error: 'Internal server error' });
  }
}

// ── Start ───────────────────────────────────────────────────────────

function start(): void {
  loadEnv();

  PORT = parseInt(process.env.BOOKING_PORT || '3200', 10);
  ALLOWED_ORIGINS = (process.env.BOOKING_ALLOWED_ORIGIN || 'https://sheridantrailerrentals.us')
    .split(',').map(o => o.trim());

  initDb();

  const server = http.createServer(handleRequest);

  server.listen(PORT, () => {
    console.log(`[booking-api] Sheridan Rentals Booking API listening on port ${PORT}`);
    console.log(`[booking-api] Allowed origins: ${ALLOWED_ORIGINS.join(', ')}`);
  });

  // Graceful shutdown
  const shutdown = () => {
    console.log('[booking-api] Shutting down...');
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 5000);
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

start();
