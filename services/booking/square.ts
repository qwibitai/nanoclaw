/**
 * Square Payment Links integration for Sheridan Rentals Booking API.
 * Adapted from nanoclaw-deploy/tools/square/square.ts
 *
 * Uses raw fetch against Square API v2 — no SDK dependency.
 */
import type { PriceBreakdown, Customer } from './types.js';
import { buildSquareLineItems } from './pricing.js';

interface SquareConfig {
  accessToken: string;
  locationId: string;
  baseUrl: string;
}

let config: SquareConfig | null = null;

function getConfig(): SquareConfig {
  if (config) return config;

  const accessToken = process.env.SQUARE_ACCESS_TOKEN;
  const locationId = process.env.SQUARE_LOCATION_ID;
  const environment = process.env.SQUARE_ENVIRONMENT || 'production';

  if (!accessToken) throw new Error('Missing SQUARE_ACCESS_TOKEN');
  if (!locationId) throw new Error('Missing SQUARE_LOCATION_ID');

  config = {
    accessToken,
    locationId,
    baseUrl: environment === 'sandbox'
      ? 'https://connect.squareupsandbox.com/v2'
      : 'https://connect.squareup.com/v2',
  };
  return config;
}

async function squareRequest(
  method: string,
  path: string,
  body?: unknown,
): Promise<any> {
  const cfg = getConfig();
  const response = await fetch(`${cfg.baseUrl}${path}`, {
    method,
    headers: {
      'Square-Version': '2024-12-18',
      Authorization: `Bearer ${cfg.accessToken}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const data = await response.json();
  if (!response.ok) {
    throw new Error(`Square API ${response.status}: ${JSON.stringify(data.errors || data)}`);
  }
  return data;
}

// ── Create Payment Link ─────────────────────────────────────────────

export async function createPaymentLink(
  pricing: PriceBreakdown,
  customer: Customer,
  bookingId: string,
): Promise<{ paymentUrl: string; paymentLinkId: string; orderId: string }> {
  const cfg = getConfig();
  const lineItems = buildSquareLineItems(pricing);
  const idempotencyKey = `sheridan-${bookingId}`;

  const redirectUrl = process.env.BOOKING_CONFIRMATION_URL
    || 'https://sheridantrailerrentals.us/booking-confirmation';

  const body: any = {
    idempotency_key: idempotencyKey,
    order: {
      location_id: cfg.locationId,
      line_items: lineItems,
      metadata: {
        booking_id: bookingId,
      },
    },
    checkout_options: {
      allow_tipping: false,
      redirect_url: `${redirectUrl}?booking=${bookingId}`,
      ask_for_shipping_address: false,
    },
  };

  // NOTE: pre_populated_data removed — Square's email validation is too strict
  // and rejects many valid emails. Customer enters their info on Square's checkout page.

  const data = await squareRequest('POST', '/online-checkout/payment-links', body);
  const link = data.payment_link;

  return {
    paymentUrl: link?.url || link?.long_url || '',
    paymentLinkId: link?.id || '',
    orderId: link?.order_id || '',
  };
}

// ── Refund Payment ──────────────────────────────────────────────────

export async function refundPayment(orderId: string, amountCents?: number): Promise<{
  refundId: string;
  status: string;
  amountCents: number;
}> {
  // 1. Get the order to find payment_id from tenders
  const orderData = await squareRequest('GET', `/orders/${orderId}`);
  const tenders = orderData.order?.tenders || [];
  if (tenders.length === 0) throw new Error('No payment found for this order');

  const paymentId = tenders[0].id;
  const paidCents = tenders[0].amount_money?.amount || 0;
  const refundAmount = amountCents || paidCents;

  // 2. Create refund via Square Refunds API
  const refundData = await squareRequest('POST', '/refunds', {
    idempotency_key: `refund-${orderId}-${Date.now()}`,
    payment_id: paymentId,
    amount_money: {
      amount: refundAmount,
      currency: 'USD',
    },
    reason: 'Customer cancellation',
  });

  return {
    refundId: refundData.refund?.id || '',
    status: refundData.refund?.status || 'UNKNOWN',
    amountCents: refundAmount,
  };
}

// ── Check Order Payment Status ──────────────────────────────────────

export async function checkOrderPayment(orderId: string): Promise<{
  isPaid: boolean;
  totalPaidCents: number;
  orderState: string;
}> {
  const data = await squareRequest('GET', `/orders/${orderId}`);
  const order = data.order;
  const tenders = order?.tenders || [];
  const isPaid = tenders.length > 0;
  const totalPaidCents = tenders.reduce(
    (sum: number, t: any) => sum + (t.amount_money?.amount || 0),
    0,
  );

  return {
    isPaid,
    totalPaidCents,
    orderState: order?.state || 'UNKNOWN',
  };
}
