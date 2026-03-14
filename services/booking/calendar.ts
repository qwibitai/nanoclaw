/**
 * Google Calendar integration for Sheridan Rentals Booking API.
 * Adapted from nanoclaw/tools/calendar/calendar.ts
 *
 * Uses service account JWT auth to check freeBusy and create events.
 */
import { google, calendar_v3 } from 'googleapis';
import type { EquipmentKey, BusySlot, Customer } from './types.js';
import { EQUIPMENT } from './pricing.js';

let calClient: calendar_v3.Calendar | null = null;

function getAuth(): InstanceType<typeof google.auth.JWT> {
  const keyJson = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
  if (!keyJson) throw new Error('Missing GOOGLE_SERVICE_ACCOUNT_KEY');

  const key = JSON.parse(keyJson);
  return new google.auth.JWT({
    email: key.client_email,
    key: key.private_key,
    scopes: ['https://www.googleapis.com/auth/calendar'],
  });
}

function getCal(): calendar_v3.Calendar {
  if (!calClient) {
    calClient = google.calendar({ version: 'v3', auth: getAuth() });
  }
  return calClient;
}

// ── Free/Busy Check ─────────────────────────────────────────────────

export async function getBookedSlots(
  equipmentKey: EquipmentKey,
  startDate: string,
  endDate: string,
): Promise<BusySlot[]> {
  const equipment = EQUIPMENT[equipmentKey];
  if (!equipment) throw new Error(`Unknown equipment: ${equipmentKey}`);

  const cal = getCal();
  const res = await cal.freebusy.query({
    requestBody: {
      timeMin: `${startDate}T00:00:00`,
      timeMax: `${endDate}T23:59:59`,
      timeZone: 'America/Chicago',
      items: [{ id: equipment.calendarId }],
    },
  });

  const busy = res.data.calendars?.[equipment.calendarId]?.busy || [];
  return busy.map((slot) => ({
    start: slot.start || '',
    end: slot.end || '',
  }));
}

// ── Check if specific dates overlap with existing bookings ──────────

export async function datesAreAvailable(
  equipmentKey: EquipmentKey,
  dates: string[],
): Promise<boolean> {
  if (dates.length === 0) return false;

  const sorted = [...dates].sort();
  const startDate = sorted[0];
  const endDate = sorted[sorted.length - 1];

  const busySlots = await getBookedSlots(equipmentKey, startDate, endDate);
  if (busySlots.length === 0) return true;

  // Convert busy slots to date sets for comparison (all-day events)
  const busyDates = new Set<string>();
  for (const slot of busySlots) {
    const start = new Date(slot.start);
    const end = new Date(slot.end);
    const current = new Date(start);
    while (current < end) {
      busyDates.add(current.toISOString().split('T')[0]);
      current.setDate(current.getDate() + 1);
    }
  }

  for (const date of dates) {
    if (busyDates.has(date)) return false;
  }

  return true;
}

// ── Delete Calendar Event ───────────────────────────────────────────

export async function deleteCalendarEvent(
  equipmentKey: EquipmentKey,
  eventId: string,
): Promise<void> {
  const equipment = EQUIPMENT[equipmentKey];
  if (!equipment) throw new Error(`Unknown equipment: ${equipmentKey}`);

  const cal = getCal();
  await cal.events.delete({
    calendarId: equipment.calendarId,
    eventId,
  });
}

// ── Create Booking Event ────────────────────────────────────────────

export async function createBookingEvent(
  equipmentKey: EquipmentKey,
  dates: string[],
  customer: Customer,
  pricing: { subtotal: number; deposit: number; balance: number; addOns: string[] },
): Promise<string> {
  const equipment = EQUIPMENT[equipmentKey];
  if (!equipment) throw new Error(`Unknown equipment: ${equipmentKey}`);

  const sorted = [...dates].sort();
  const startDate = sorted[0];
  const endDate = sorted[sorted.length - 1];

  // Add one day to end for all-day event range
  const endPlusOne = new Date(`${endDate}T00:00:00Z`);
  endPlusOne.setUTCDate(endPlusOne.getUTCDate() + 1);
  const endDateStr = endPlusOne.toISOString().split('T')[0];

  const addOnText = pricing.addOns.length > 0
    ? `\nAdd-ons: ${pricing.addOns.join(', ')}`
    : '';

  const cal = getCal();
  const res = await cal.events.insert({
    calendarId: equipment.calendarId,
    requestBody: {
      summary: `${equipment.label} Rental — ${customer.firstName} ${customer.lastName}`,
      description: [
        `Customer: ${customer.firstName} ${customer.lastName}`,
        `Email: ${customer.email}`,
        `Phone: ${customer.phone}`,
        `Equipment: ${equipment.label}`,
        `Duration: ${dates.length} ${equipment.unit}${dates.length > 1 ? 's' : ''}`,
        `Total: $${pricing.subtotal.toFixed(2)}`,
        `Deposit: $${pricing.deposit.toFixed(2)}`,
        `Balance due at pickup: $${pricing.balance.toFixed(2)}`,
        addOnText,
        `\nBooked via website`,
      ].filter(Boolean).join('\n'),
      location: 'Tomball, TX',
      start: { date: startDate },
      end: { date: endDateStr },
    },
  });

  return res.data.id || '';
}
