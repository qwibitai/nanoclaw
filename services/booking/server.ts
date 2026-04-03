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
  expireStalePendingBookings, getBookedDatesFromDb,
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
  let body: AvailabilityRequest;
  try {
    body = JSON.parse(await readBody(req)) as AvailabilityRequest;
  } catch {
    json(res, 400, { error: 'Invalid JSON' });
    return;
  }

  if (!body.equipment || !EQUIPMENT[body.equipment]) {
    json(res, 400, { error: 'Invalid equipment type' });
    return;
  }
  if (!body.startDate || !body.endDate) {
    json(res, 400, { error: 'startDate and endDate required (YYYY-MM-DD)' });
    return;
  }

  // Expire stale pending bookings before checking availability
  expireStalePendingBookings(30);

  let busySlots: any[] = [];
  try {
    busySlots = await getBookedSlots(body.equipment, body.startDate, body.endDate);
  } catch (err: any) {
    console.error('[availability] Calendar check failed:', err.message);
  }

  // Merge DB bookings (pending/paid/confirmed) so calendar matches checkout
  try {
    const dbSlots = getBookedDatesFromDb(body.equipment, body.startDate, body.endDate);
    busySlots = busySlots.concat(dbSlots);
  } catch (err: any) {
    console.error('[availability] DB check failed:', err.message);
  }

  json(res, 200, {
    equipment: body.equipment,
    startDate: body.startDate,
    endDate: body.endDate,
    busySlots,
  });
}

async function handleCheckout(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  let body: CheckoutRequest;
  try {
    body = JSON.parse(await readBody(req)) as CheckoutRequest;
  } catch {
    json(res, 400, { error: 'Invalid JSON' });
    return;
  }

  // Validate
  if (!body.equipment || !EQUIPMENT[body.equipment]) {
    json(res, 400, { error: 'Invalid equipment type' });
    return;
  }
  if (!body.dates || body.dates.length === 0) {
    json(res, 400, { error: 'No dates selected' });
    return;
  }
  // Validate date format and reject past dates
  // Use local date (TZ=America/Chicago) — .toISOString() returns UTC which
  // causes today's date to be rejected as "past" after 7pm CDT
  const now = new Date();
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  for (const d of body.dates) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) {
      json(res, 400, { error: 'Invalid date format. Use YYYY-MM-DD.' });
      return;
    }
    if (d < today) {
      json(res, 400, { error: 'Cannot book dates in the past.' });
      return;
    }
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

  let available = true;
  try {
    available = await datesAreAvailable(equipmentKey, dates);
  } catch (err: any) {
    // Calendar API failure — log but don't block the booking
    console.error('[checkout] Calendar availability check failed:', err.message);
    // Continue with booking — Square payment will still work, calendar event created on webhook
  }
  if (!available) {
    json(res, 409, { error: 'Equipment is not available for the selected dates.' });
    return;
  }

  // Calculate pricing (pass dates for same-week detection on RV)
  // Only allow deposit mode when frontend explicitly sends 'deposit'
  const rawMode = (body as any).paymentMode;
  const paymentMode: 'full' | 'deposit' | undefined = rawMode === 'deposit' ? 'deposit' : 'full';
  const pricing = calculatePrice(equipmentKey, numDays, body.addOns || [], { dates, paymentMode });

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
      chargeNow: pricing.chargeNow,
      paymentMode: pricing.paymentMode,
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
    console.log(`[webhook] Received event: ${payload.type}`);

    // Square sends payment.created and payment.updated — not payment.completed
    if (!['payment.created', 'payment.updated'].includes(payload.type)) return;

    const payment = payload.data?.object?.payment;
    if (!payment) return;

    // Only process completed payments
    if (payment.status !== 'COMPLETED') {
      console.log(`[webhook] Payment status is ${payment.status}, skipping`);
      return;
    }

    const orderId = payment.order_id;
    if (!orderId) return;

    console.log(`[webhook] Payment completed for order ${orderId}`);

    // Find the booking — check order_id first, then check order metadata for balance payments
    let booking = getBookingByOrderId(orderId);
    if (!booking) {
      // Balance payments have a different order_id. Check if the order metadata has a booking_id.
      const metadata = payment.order?.metadata || payment.metadata || {};
      const metaBookingId = metadata.booking_id;
      if (metaBookingId) {
        booking = getBooking(metaBookingId);
        if (booking) {
          console.log(`[webhook] Found booking ${metaBookingId} via order metadata (balance payment)`);
        }
      }
    }
    if (!booking) {
      console.warn(`[webhook] No booking found for order ${orderId}`);
      return;
    }

    // Handle balance payment — booking already in 'paid' status, now fully paid
    if (booking.status === 'paid' && booking.balance > 0) {
      console.log(`[webhook] Balance payment received for booking ${booking.id}`);
      updateBookingStatus(booking.id, 'confirmed');

      const updatedBooking = getBooking(booking.id)!;
      sendCustomerConfirmation(updatedBooking).catch(err =>
        console.error(`[webhook] Balance confirmation email failed: ${err.message}`),
      );
      sendPaymentReceivedNotification(updatedBooking).catch(err =>
        console.error(`[webhook] Balance owner notification failed: ${err.message}`),
      );
      return;
    }

    if (booking.status === 'cancelled') {
      // Payment arrived after pending booking was expired — resurrect it
      console.log(`[webhook] Booking ${booking.id} was expired but payment received — reactivating`);
      // Fall through to normal confirmation flow below
    } else if (booking.status !== 'pending') {
      console.log(`[webhook] Booking ${booking.id} already processed (status: ${booking.status})`);
      return;
    }

    // Determine status: deposit-only bookings go to 'paid' (balance still owed),
    // full-payment bookings go straight to 'confirmed'
    const isDepositOnly = booking.balance > 0;
    updateBookingStatus(booking.id, isDepositOnly ? 'paid' : 'confirmed');

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
  let body: any;
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    json(res, 400, { error: 'Invalid JSON' });
    return;
  }
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
  if (refund !== false && (booking.status === 'confirmed' || booking.status === 'paid') && booking.squareOrderId) {
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

  const isDepositOnly = booking.balance > 0;
  json(res, 200, {
    id: booking.id,
    equipment: booking.equipmentLabel,
    equipmentLabel: booking.equipmentLabel,
    dates: booking.dates,
    dateRange,
    numDays: booking.numDays,
    unit,
    subtotal: booking.subtotal,
    total: booking.subtotal + booking.deposit,
    deposit: booking.deposit,
    amountPaid: isDepositOnly ? booking.deposit : booking.subtotal + booking.deposit,
    balance: booking.balance,
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

  // Expire stale pending bookings every 5 minutes (frees blocked dates)
  setInterval(() => {
    const expired = expireStalePendingBookings(30);
    if (expired > 0) console.log(`[cleanup] Expired ${expired} stale pending booking(s)`)
  }, 5 * 60 * 1000);

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
