/**
 * Email notifications for Sheridan Rentals Booking API.
 * Sends branded emails: owner notification + customer confirmation.
 * Adapted from nanoclaw/tools/email/send-email.ts
 */
import { createTransport, type Transporter } from 'nodemailer';
import type { Booking, PriceBreakdown } from './types.js';

let transporter: Transporter | null = null;

function getTransporter(): Transporter {
  if (transporter) return transporter;

  const host = process.env.SMTP_HOST;
  const port = parseInt(process.env.SMTP_PORT || '587', 10);
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;

  if (!host || !user || !pass) {
    throw new Error('Missing SMTP configuration (SMTP_HOST, SMTP_USER, SMTP_PASS)');
  }

  transporter = createTransport({
    host,
    port,
    secure: port === 465,
    auth: { user, pass },
  });

  return transporter;
}

async function sendWithRetry(
  t: Transporter,
  mailOptions: Parameters<Transporter['sendMail']>[0],
  maxRetries = 3,
): Promise<void> {
  let lastError: Error | null = null;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const info = await t.sendMail(mailOptions);
      if (info.rejected && info.rejected.length > 0) {
        console.warn(`[email] Rejected recipients: ${info.rejected.join(', ')}`);
      }
      return;
    } catch (err: any) {
      lastError = err;
      console.error(`[email] Attempt ${attempt}/${maxRetries} failed: ${err.message}`);
      if (attempt < maxRetries) {
        await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
      }
    }
  }
  throw lastError || new Error('Email send failed after retries');
}

const OWNER_EMAIL = 'info@sheridantrailerrentals.us';
const FROM_NAME = 'Sheridan Rentals';

function getFrom(): string {
  const user = process.env.SMTP_USER || '';
  return process.env.SMTP_FROM || `${FROM_NAME} <${user}>`;
}

// ── Owner Notification ──────────────────────────────────────────────

export async function sendOwnerNotification(booking: Booking): Promise<void> {
  const t = getTransporter();
  const dates = booking.dates;
  const dateRange = dates.length === 1
    ? dates[0]
    : `${dates[0]} to ${dates[dates.length - 1]}`;

  const statusLabel = booking.status === 'paid' ? 'DEPOSIT PAID' : 'PENDING PAYMENT';

  await sendWithRetry(t, {
    from: getFrom(),
    to: OWNER_EMAIL,
    subject: `New Booking: ${booking.equipmentLabel} — ${dateRange} [${statusLabel}]`,
    html: `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 600px; margin: 0 auto;">
        <div style="background: #1d4ed8; color: white; padding: 20px 24px; border-radius: 8px 8px 0 0;">
          <h2 style="margin: 0; font-size: 20px;">New Booking — ${booking.equipmentLabel}</h2>
          <p style="margin: 4px 0 0; opacity: 0.9; font-size: 14px;">${statusLabel}</p>
        </div>

        <div style="background: #f9fafb; padding: 20px 24px; border: 1px solid #e5e7eb; border-top: none;">
          <h3 style="margin: 0 0 12px; color: #374151;">Customer</h3>
          <table style="font-size: 14px; color: #4b5563;">
            <tr><td style="padding: 2px 12px 2px 0; font-weight: 600;">Name:</td><td>${booking.customer.firstName} ${booking.customer.lastName}</td></tr>
            <tr><td style="padding: 2px 12px 2px 0; font-weight: 600;">Email:</td><td><a href="mailto:${booking.customer.email}">${booking.customer.email}</a></td></tr>
            <tr><td style="padding: 2px 12px 2px 0; font-weight: 600;">Phone:</td><td><a href="tel:${booking.customer.phone}">${booking.customer.phone}</a></td></tr>
          </table>

          <h3 style="margin: 16px 0 12px; color: #374151;">Booking Details</h3>
          <table style="font-size: 14px; color: #4b5563;">
            <tr><td style="padding: 2px 12px 2px 0; font-weight: 600;">Equipment:</td><td>${booking.equipmentLabel}</td></tr>
            <tr><td style="padding: 2px 12px 2px 0; font-weight: 600;">Dates:</td><td>${dateRange}</td></tr>
            <tr><td style="padding: 2px 12px 2px 0; font-weight: 600;">Duration:</td><td>${booking.numDays} day${booking.numDays > 1 ? 's' : ''}</td></tr>
            ${booking.addOns.length > 0 ? `<tr><td style="padding: 2px 12px 2px 0; font-weight: 600;">Add-ons:</td><td>${booking.addOns.join(', ')}</td></tr>` : ''}
            ${booking.details ? `<tr><td style="padding: 2px 12px 2px 0; font-weight: 600;">Notes:</td><td>${escapeHtml(booking.details)}</td></tr>` : ''}
          </table>

          <h3 style="margin: 16px 0 12px; color: #374151;">Pricing</h3>
          <table style="font-size: 14px; color: #4b5563; width: 100%; max-width: 300px;">
            <tr><td style="padding: 2px 0;">Subtotal:</td><td style="text-align: right;">$${booking.subtotal.toFixed(2)}</td></tr>
            <tr style="color: #1d4ed8; font-weight: 600;"><td style="padding: 2px 0;">Deposit:</td><td style="text-align: right;">$${booking.deposit.toFixed(2)}</td></tr>
            <tr><td style="padding: 2px 0;">Balance at pickup:</td><td style="text-align: right;">$${booking.balance.toFixed(2)}</td></tr>
          </table>

          <p style="margin: 16px 0 0; font-size: 13px; color: #9ca3af;">
            Booking ID: ${booking.id} | Created: ${new Date(booking.createdAt).toLocaleString('en-US', { timeZone: 'America/Chicago' })}
          </p>
        </div>
      </div>
    `,
  });
}

// ── Customer Confirmation ───────────────────────────────────────────

export async function sendCustomerConfirmation(booking: Booking): Promise<void> {
  const t = getTransporter();
  const dates = booking.dates;
  const dateRange = dates.length === 1
    ? dates[0]
    : `${dates[0]} to ${dates[dates.length - 1]}`;

  await sendWithRetry(t, {
    from: getFrom(),
    to: booking.customer.email,
    subject: `Booking Confirmed — ${booking.equipmentLabel} | Sheridan Rentals`,
    html: `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 600px; margin: 0 auto;">
        <div style="background: #1d4ed8; color: white; padding: 24px; border-radius: 8px 8px 0 0; text-align: center;">
          <h1 style="margin: 0; font-size: 24px;">Booking Confirmed!</h1>
          <p style="margin: 8px 0 0; opacity: 0.9;">Sheridan Trailer Rentals</p>
        </div>

        <div style="background: white; padding: 24px; border: 1px solid #e5e7eb; border-top: none;">
          <p style="font-size: 16px; color: #374151;">Hi ${escapeHtml(booking.customer.firstName)},</p>
          <p style="font-size: 14px; color: #4b5563; line-height: 1.6;">
            Your payment has been received and your booking is confirmed! Here are your details:
          </p>

          <div style="background: #f9fafb; border-radius: 8px; padding: 16px; margin: 16px 0;">
            <table style="font-size: 14px; color: #4b5563; width: 100%;">
              <tr><td style="padding: 4px 0; font-weight: 600;">Equipment:</td><td>${booking.equipmentLabel}</td></tr>
              <tr><td style="padding: 4px 0; font-weight: 600;">Dates:</td><td>${dateRange}</td></tr>
              <tr><td style="padding: 4px 0; font-weight: 600;">Duration:</td><td>${booking.numDays} day${booking.numDays > 1 ? 's' : ''}</td></tr>
              <tr><td style="padding: 4px 0; font-weight: 600; color: #16a34a;">Total Paid:</td><td style="color: #16a34a;">$${booking.subtotal.toFixed(2)}</td></tr>
            </table>
          </div>

          <h3 style="color: #374151; margin: 20px 0 8px;">Next Steps</h3>
          <ol style="font-size: 14px; color: #4b5563; line-height: 1.8; padding-left: 20px;">
            <li>You'll receive the lock code to access the trailer on pickup day</li>
            <li>Pickup location: Tomball, TX area</li>
            <li>Questions? Just reply to this email or text us</li>
          </ol>

          <p style="font-size: 14px; color: #4b5563; margin-top: 20px;">
            Questions? Reply to this email or text us — we're always available.
          </p>

          <p style="font-size: 13px; color: #9ca3af; margin-top: 24px; padding-top: 16px; border-top: 1px solid #e5e7eb;">
            Booking ID: ${booking.id}<br>
            Sheridan Trailer Rentals — Tomball, TX
          </p>
        </div>
      </div>
    `,
  });
}

// ── Payment Received Notification (to owner) ────────────────────────

export async function sendPaymentReceivedNotification(booking: Booking): Promise<void> {
  const t = getTransporter();

  await sendWithRetry(t, {
    from: getFrom(),
    to: OWNER_EMAIL,
    subject: `Deposit Received: ${booking.equipmentLabel} — ${booking.customer.firstName} ${booking.customer.lastName} ($${booking.deposit.toFixed(2)})`,
    html: `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 600px; margin: 0 auto;">
        <div style="background: #16a34a; color: white; padding: 16px 24px; border-radius: 8px 8px 0 0;">
          <h2 style="margin: 0;">Deposit Received — $${booking.deposit.toFixed(2)}</h2>
        </div>
        <div style="background: #f9fafb; padding: 20px 24px; border: 1px solid #e5e7eb; border-top: none; font-size: 14px; color: #4b5563;">
          <p><strong>${booking.customer.firstName} ${booking.customer.lastName}</strong> paid the $${booking.deposit.toFixed(2)} deposit for <strong>${booking.equipmentLabel}</strong>.</p>
          <p>Dates: ${booking.dates[0]} to ${booking.dates[booking.dates.length - 1]} (${booking.numDays} day${booking.numDays > 1 ? 's' : ''})</p>
          <p>Balance remaining: $${booking.balance.toFixed(2)}</p>
          <p>Calendar event created. Customer confirmation email sent.</p>
          <p style="color: #9ca3af; font-size: 13px; margin-top: 16px;">Booking ID: ${booking.id}</p>
        </div>
      </div>
    `,
  });
}

// ── Cancellation Confirmation ────────────────────────────────────────

export async function sendCancellationConfirmation(booking: Booking, refundAmount: number): Promise<void> {
  const t = getTransporter();

  await sendWithRetry(t, {
    from: getFrom(),
    to: booking.customer.email,
    subject: `Booking Cancelled — ${booking.equipmentLabel} | Sheridan Rentals`,
    html: `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 600px; margin: 0 auto;">
        <div style="background: #dc2626; color: white; padding: 24px; border-radius: 8px 8px 0 0; text-align: center;">
          <h1 style="margin: 0; font-size: 24px;">Booking Cancelled</h1>
          <p style="margin: 8px 0 0; opacity: 0.9;">Sheridan Trailer Rentals</p>
        </div>
        <div style="background: white; padding: 24px; border: 1px solid #e5e7eb; border-top: none;">
          <p style="font-size: 16px; color: #374151;">Hi ${escapeHtml(booking.customer.firstName)},</p>
          <p style="font-size: 14px; color: #4b5563; line-height: 1.6;">
            Your booking has been cancelled. ${refundAmount > 0 ? `A refund of <strong>$${(refundAmount / 100).toFixed(2)}</strong> has been initiated and should appear in your account within 5-10 business days.` : ''}
          </p>
          <div style="background: #f9fafb; border-radius: 8px; padding: 16px; margin: 16px 0;">
            <table style="font-size: 14px; color: #4b5563; width: 100%;">
              <tr><td style="padding: 4px 0; font-weight: 600;">Equipment:</td><td>${booking.equipmentLabel}</td></tr>
              <tr><td style="padding: 4px 0; font-weight: 600;">Dates:</td><td>${booking.dates[0]} to ${booking.dates[booking.dates.length - 1]}</td></tr>
              <tr><td style="padding: 4px 0; font-weight: 600;">Booking ID:</td><td>${booking.id}</td></tr>
            </table>
          </div>
          <p style="font-size: 14px; color: #4b5563; margin-top: 20px;">
            We're sorry to see you go. If you'd like to rebook, visit our website or text us anytime.
          </p>
          <p style="font-size: 13px; color: #9ca3af; margin-top: 24px; padding-top: 16px; border-top: 1px solid #e5e7eb;">
            Sheridan Trailer Rentals — Tomball, TX
          </p>
        </div>
      </div>
    `,
  });
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
