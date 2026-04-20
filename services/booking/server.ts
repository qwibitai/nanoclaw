/**
 * Sheridan Rentals Booking API Server
 *
 * Lightweight HTTP server on port 3200 (no Express).
 * Endpoints:
 *   POST /api/availability      — Check booked date ranges from Google Calendar
 *   POST /api/checkout          — Validate, price, create Square payment link, store booking
 *   POST /api/square-webhook    — Payment confirmation → calendar event + email
 *   POST /api/upload            — License photo upload (multipart)
 *   POST /api/upload-inspection — Car hauler inspection photo upload (multipart)
 *   GET  /api/inspection/:id    — List inspection photos for a booking
 *   POST /api/cancel            — Cancel a booking (+optional refund)
 *   GET  /api/booking/:id       — Confirmation page data
 *   GET  /health                — Health check
 */
import http from 'http';
import fs from 'fs';
import path from 'path';
import { readEnvFile } from './env.js';
import { EQUIPMENT, calculatePrice, resolvePromoCode } from './pricing.js';
import { getBookedSlots, datesAreAvailable, createBookingEvent, deleteCalendarEvent } from './calendar.js';
import { createPaymentLink, checkOrderPayment, refundPayment } from './square.js';
import {
  initDb, generateBookingId, createBooking, getBooking,
  getBookingByOrderId, updateBookingStatus, setCalendarEventId,
  hasOverlappingBooking, cancelBooking, getActiveBookings, getBookingsByEmail,
  expireStalePendingBookings, getBookedDatesFromDb, clearBalance, setLicensePhoto,
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
  'OWNER_EMAIL',
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
const checkoutRateMap = new Map<string, { count: number; ts: number }>();
const RATE_WINDOW = 60_000;
const RATE_MAX = 20;
const CHECKOUT_RATE_MAX = 5;

function bumpRate(bucket: Map<string, { count: number; ts: number }>, ip: string, max: number): boolean {
  const now = Date.now();
  const entry = bucket.get(ip);
  if (!entry || now - entry.ts > RATE_WINDOW) {
    bucket.set(ip, { count: 1, ts: now });
    return false;
  }
  entry.count++;
  return entry.count > max;
}

function isRateLimited(ip: string): boolean {
  return bumpRate(rateMap, ip, RATE_MAX);
}

function isCheckoutRateLimited(ip: string): boolean {
  return bumpRate(checkoutRateMap, ip, CHECKOUT_RATE_MAX);
}

setInterval(() => {
  const cutoff = Date.now() - RATE_WINDOW * 2;
  for (const [ip, entry] of rateMap) if (entry.ts < cutoff) rateMap.delete(ip);
  for (const [ip, entry] of checkoutRateMap) if (entry.ts < cutoff) checkoutRateMap.delete(ip);
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
  // Honeypot: the form's hidden "website" field must be empty. Bots fill it.
  if (typeof (body as any).website === 'string' && (body as any).website.trim() !== '') {
    json(res, 200, { bookingId: 'hp', paymentUrl: '', pricing: null });
    return;
  }
  if (!body.customer?.firstName || !body.customer?.lastName) {
    json(res, 400, { error: 'Customer name required' });
    return;
  }
  const email = (body.customer?.email || '').trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
    json(res, 400, { error: 'Valid email required' });
    return;
  }
  body.customer.email = email;
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
  const rawMode = body.paymentMode;
  const paymentMode: 'full' | 'deposit' | undefined = rawMode === 'deposit' ? 'deposit' : 'full';
  const promoCode = body.promoCode;
  const pricing = calculatePrice(equipmentKey, numDays, body.addOns || [], { dates, paymentMode, promoCode });

  // RV: delivery is mandatory unless a promo (e.g. RIVER) explicitly removes it.
  // No self-service pickup — customers must contact the owner to get a promo code.
  const deliveryAddress = (body.deliveryAddress || '').trim();
  if (equipmentKey === 'rv') {
    const promo = resolvePromoCode(promoCode, equipmentKey);
    const promoRemovesDelivery = promo?.removeDelivery === true;
    if (!promoRemovesDelivery && !pricing.addOns.includes('delivery')) {
      json(res, 400, { error: 'Delivery is required for RV rentals.' });
      return;
    }
    if (pricing.addOns.includes('delivery')) {
      if (!deliveryAddress) {
        json(res, 400, { error: 'Delivery address is required for RV rentals.' });
        return;
      }
      if (deliveryAddress.length > 500) {
        json(res, 400, { error: 'Delivery address is too long (max 500 characters).' });
        return;
      }
    }
  }

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
    deliveryAddress,
  });

  // Associate uploaded license photo with the booking (move session-scoped upload → booking-scoped)
  if (body.licenseFileId && body.sessionId
      && isSafePathSegment(body.licenseFileId) && isSafePathSegment(body.sessionId)) {
    const srcDir = path.join(UPLOAD_DIR, body.sessionId);
    const destDir = path.join(UPLOAD_DIR, bookingId);
    try {
      fs.mkdirSync(destDir, { recursive: true });
      const srcFile = path.join(srcDir, body.licenseFileId);
      if (fs.existsSync(srcFile)) {
        fs.copyFileSync(srcFile, path.join(destDir, body.licenseFileId));
        fs.unlinkSync(srcFile);
        try { fs.rmdirSync(srcDir); } catch { /* non-empty is fine */ }
      }
      setLicensePhoto(bookingId, body.licenseFileId);
      console.log(`[checkout] License photo linked: ${bookingId}/${body.licenseFileId}`);
    } catch (err: any) {
      console.error(`[checkout] License photo link error: ${err.message}`);
      // Non-fatal — booking is paid, owner can request a re-upload
    }
  }

  // Owner notification is sent from the Square webhook after payment is confirmed.
  // This avoids alerting on abandoned carts and bot submissions.

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
    // Only if this is a DIFFERENT order (balance payment link), not a duplicate webhook for the original deposit
    if (booking.status === 'paid' && booking.balance > 0 && orderId !== booking.squareOrderId) {
      console.log(`[webhook] Balance payment received for booking ${booking.id} (balance order: ${orderId})`);
      updateBookingStatus(booking.id, 'confirmed');
      clearBalance(booking.id);

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
    } else if (booking.status === 'paid' && orderId === booking.squareOrderId) {
      // Duplicate webhook for a deposit that was already processed — ignore
      console.log(`[webhook] Booking ${booking.id} deposit already processed, ignoring duplicate`);
      return;
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

    // Send emails (non-blocking). Owner gets the full-detail notification only
    // after payment is confirmed — prevents spam/abandoned-cart alerts.
    sendCustomerConfirmation(updatedBooking).catch(err =>
      console.error(`[webhook] CRITICAL: Customer confirmation email failed after retries: ${err.message}. Booking ${updatedBooking.id} — manual follow-up required.`),
    );
    sendOwnerNotification(updatedBooking).catch(err =>
      console.error(`[webhook] CRITICAL: Owner notification email failed after retries: ${err.message}. Booking ${updatedBooking.id} — manual follow-up required.`),
    );

  } catch (err: any) {
    console.error(`[webhook] Parse error: ${err.message}`);
  }
}

// ── File Uploads (License + Inspection Photos) ──────────────────────

const UPLOAD_DIR = path.join(process.cwd(), 'data', 'uploads');
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024; // 10 MB
const ALLOWED_IMAGE_TYPES = new Set(['image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'image/heic', 'image/heif']);
const ALLOWED_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.heic', '.heif']);
const SAFE_SEGMENT = /^[A-Za-z0-9._-]+$/;

/** Reject anything that could traverse out of UPLOAD_DIR. Accepts only alphanumerics, dot, underscore, hyphen. */
function isSafePathSegment(s: string | undefined | null): s is string {
  return typeof s === 'string' && s.length > 0 && s.length <= 128 && SAFE_SEGMENT.test(s) && s !== '.' && s !== '..';
}

interface ParsedUpload {
  fields: Record<string, string>;
  file?: { name: string; data: Buffer; contentType: string };
}

function parseMultipartFormData(req: http.IncomingMessage, maxSize = MAX_UPLOAD_BYTES): Promise<ParsedUpload> {
  return new Promise((resolve, reject) => {
    const contentType = req.headers['content-type'] || '';
    const boundaryMatch = contentType.match(/boundary=(?:"?)([^";]+)/);
    if (!boundaryMatch) { reject(new Error('No multipart boundary')); return; }
    const boundary = boundaryMatch[1];

    const chunks: Buffer[] = [];
    let size = 0;
    let aborted = false;
    req.on('data', (chunk: Buffer) => {
      if (aborted) return;
      size += chunk.length;
      if (size > maxSize) {
        aborted = true;
        req.destroy();
        reject(new Error('Payload too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (aborted) return;
      const buf = Buffer.concat(chunks);
      // Split on boundary using binary-preserving encoding
      const parts = buf.toString('binary').split('--' + boundary);
      const fields: Record<string, string> = {};
      let file: ParsedUpload['file'];

      for (const part of parts) {
        if (part === '--\r\n' || part === '--' || !part.includes('Content-Disposition')) continue;
        const headerEnd = part.indexOf('\r\n\r\n');
        if (headerEnd === -1) continue;
        const headers = part.substring(0, headerEnd);
        let bodyStr = part.substring(headerEnd + 4);
        if (bodyStr.endsWith('\r\n')) bodyStr = bodyStr.slice(0, -2);

        const nameMatch = headers.match(/name="([^"]+)"/);
        if (!nameMatch) continue;
        const fieldName = nameMatch[1];

        const filenameMatch = headers.match(/filename="([^"]+)"/);
        if (filenameMatch) {
          const ctMatch = headers.match(/Content-Type:\s*([^\r\n;]+)/i);
          file = {
            name: filenameMatch[1],
            data: Buffer.from(bodyStr, 'binary'),
            contentType: ctMatch ? ctMatch[1].trim().toLowerCase() : 'application/octet-stream',
          };
        } else {
          fields[fieldName] = bodyStr;
        }
      }
      resolve({ fields, file });
    });
    req.on('error', reject);
  });
}

function safeExtension(filename: string): string {
  const ext = path.extname(filename).toLowerCase();
  return ALLOWED_EXTENSIONS.has(ext) ? ext : '.jpg';
}

async function handleUpload(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  let parsed: ParsedUpload;
  try {
    parsed = await parseMultipartFormData(req);
  } catch (err: any) {
    const status = err.message === 'Payload too large' ? 413 : 400;
    json(res, status, { error: err.message });
    return;
  }

  const { fields, file } = parsed;
  if (!file) { json(res, 400, { error: 'No file uploaded' }); return; }
  if (!ALLOWED_IMAGE_TYPES.has(file.contentType)) {
    json(res, 400, { error: 'Unsupported image type. Use JPEG, PNG, WebP, or HEIC.' });
    return;
  }

  // Session ID: use supplied value if safe, else generate one
  const suppliedSession = fields.sessionId;
  const sessionId = isSafePathSegment(suppliedSession)
    ? suppliedSession
    : `sess-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;

  const fileId = `lic-${Date.now()}-${Math.random().toString(36).substring(2, 8)}${safeExtension(file.name)}`;

  try {
    const dir = path.join(UPLOAD_DIR, sessionId);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, fileId), file.data);
    console.log(`[upload] License photo saved: ${sessionId}/${fileId} (${file.data.length} bytes)`);
    json(res, 200, { fileId, sessionId });
  } catch (err: any) {
    console.error(`[upload] Write error: ${err.message}`);
    json(res, 500, { error: 'Upload failed' });
  }
}

async function handleUploadInspection(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  let parsed: ParsedUpload;
  try {
    parsed = await parseMultipartFormData(req);
  } catch (err: any) {
    const status = err.message === 'Payload too large' ? 413 : 400;
    json(res, status, { error: err.message });
    return;
  }

  const { fields, file } = parsed;
  if (!file) { json(res, 400, { error: 'No file uploaded' }); return; }
  if (!ALLOWED_IMAGE_TYPES.has(file.contentType)) {
    json(res, 400, { error: 'Unsupported image type' });
    return;
  }

  const bookingId = fields.bookingId;
  const type = fields.type;   // 'before' | 'after'
  const angle = fields.angle; // 'front' | 'back' | 'left' | 'right'

  if (!bookingId || !type || !angle) {
    json(res, 400, { error: 'bookingId, type, and angle are required' });
    return;
  }
  if (!isSafePathSegment(bookingId)) { json(res, 400, { error: 'Invalid bookingId' }); return; }
  if (!['before', 'after'].includes(type) || !['front', 'back', 'left', 'right'].includes(angle)) {
    json(res, 400, { error: 'Invalid type or angle' });
    return;
  }

  const booking = getBooking(bookingId);
  if (!booking) { json(res, 404, { error: 'Booking not found' }); return; }
  if (booking.equipment !== 'carhauler') {
    json(res, 400, { error: 'Inspection photos are only available for Car Hauler rentals' });
    return;
  }

  const fileId = `insp-${type}-${angle}-${Date.now()}${safeExtension(file.name)}`;
  try {
    const dir = path.join(UPLOAD_DIR, bookingId, 'inspection');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, fileId), file.data);
    console.log(`[inspection] Photo saved: ${bookingId}/inspection/${fileId} (${file.data.length} bytes)`);
    json(res, 200, { fileId, bookingId, type, angle });
  } catch (err: any) {
    console.error(`[inspection] Write error: ${err.message}`);
    json(res, 500, { error: 'Upload failed' });
  }
}

function handleGetInspection(res: http.ServerResponse, bookingId: string, typeFilter: string): void {
  if (!isSafePathSegment(bookingId)) { json(res, 400, { error: 'Invalid bookingId' }); return; }

  const dir = path.join(UPLOAD_DIR, bookingId, 'inspection');
  const photos: Array<{ fileId: string; type: string; angle: string }> = [];

  try {
    if (fs.existsSync(dir)) {
      const files = fs.readdirSync(dir);
      for (const f of files) {
        const match = f.match(/^insp-(before|after)-(front|back|left|right)-/);
        if (!match) continue;
        const fType = match[1];
        const fAngle = match[2];
        if (!typeFilter || fType === typeFilter) {
          photos.push({ fileId: f, type: fType, angle: fAngle });
        }
      }
    }
  } catch (err: any) {
    console.error(`[inspection] Read error: ${err.message}`);
  }

  json(res, 200, { bookingId, photos });
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
      if (isCheckoutRateLimited(ip)) {
        json(res, 429, { error: 'Too many checkout attempts. Please wait a minute and try again.' });
        return;
      }
      await handleCheckout(req, res);
      return;
    }

    // POST /api/square-webhook
    if (req.method === 'POST' && url === '/api/square-webhook') {
      await handleSquareWebhook(req, res);
      return;
    }

    // POST /api/upload  (license photo)
    if (req.method === 'POST' && url === '/api/upload') {
      await handleUpload(req, res);
      return;
    }

    // POST /api/upload-inspection  (car hauler inspection photos)
    if (req.method === 'POST' && url === '/api/upload-inspection') {
      await handleUploadInspection(req, res);
      return;
    }

    // GET /api/inspection/:bookingId?type=before|after
    if (req.method === 'GET' && url.startsWith('/api/inspection/')) {
      const rest = url.split('/api/inspection/')[1] || '';
      const [inspBookingId, qs] = rest.split('?');
      const typeFilter = new URLSearchParams(qs || '').get('type') || '';
      if (inspBookingId) {
        handleGetInspection(res, inspBookingId, typeFilter);
        return;
      }
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
