import type { EquipmentKey, EquipmentConfig, AddOn, LineItem, PaymentMode, PriceBreakdown } from './types.js';

// ── Equipment Configuration ─────────────────────────────────────────
// Source of truth: groups/sheridan-rentals/pricing.md + inventory.md

export const EQUIPMENT: Record<EquipmentKey, EquipmentConfig> = {
  rv: {
    key: 'rv',
    label: 'RV Camper',
    rate: 150,
    unit: 'night',
    deposit: 250,
    calendarId: 'c_7ba6d46497500abce720f92671ef92bb8bbdd79e741f71d41c01084e6bb0d69c@group.calendar.google.com',
  },
  carhauler: {
    key: 'carhauler',
    label: 'Car Hauler',
    rate: 65,
    unit: 'day',
    deposit: 50,
    calendarId: 'c_f92948a07076df3480b68fcaac0dd44cfc815ca9265999f709254dfca5fc64ad@group.calendar.google.com',
  },
  landscaping: {
    key: 'landscaping',
    label: 'Landscaping Trailer',
    rate: 50,
    unit: 'day',
    deposit: 50,
    calendarId: 'c_684ca11a465fb336458c8d7dfadc9ec83265bce3b8657712d2fa10ea32cc627e@group.calendar.google.com',
  },
};

export const ADD_ONS: Record<string, AddOn> = {
  generator: {
    key: 'generator',
    label: 'Generator',
    rate: 85,
    unit: 'night',
    appliesTo: ['rv'],
  },
  delivery: {
    key: 'delivery',
    label: 'Delivery (within 60mi of Tomball)',
    rate: 250,
    unit: 'flat',
    appliesTo: ['rv'],
  },
};

// ── Holiday Pricing ─────────────────────────────────────────────────
// RV rate bumps to $175/night on US holidays + surrounding weekends.

const RV_HOLIDAY_RATE = 175;

function easterSunday(year: number): string {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return year + '-' + String(month).padStart(2, '0') + '-' + String(day).padStart(2, '0');
}

function nthWeekday(year: number, month: number, weekday: number, n: number): string {
  const first = new Date(year, month - 1, 1);
  let day = 1 + ((weekday - first.getDay() + 7) % 7);
  day += (n - 1) * 7;
  return year + '-' + String(month).padStart(2, '0') + '-' + String(day).padStart(2, '0');
}

function lastWeekday(year: number, month: number, weekday: number): string {
  const lastDay = new Date(year, month, 0).getDate();
  const last = new Date(year, month - 1, lastDay);
  const day = lastDay - ((last.getDay() - weekday + 7) % 7);
  return year + '-' + String(month).padStart(2, '0') + '-' + String(day).padStart(2, '0');
}

function fmtDateLocal(d: Date): string {
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

function addDays(dateStr: string, n: number): string {
  const p = dateStr.split('-').map(Number);
  const d = new Date(p[0], p[1] - 1, p[2]);
  d.setDate(d.getDate() + n);
  return fmtDateLocal(d);
}

const _holidayCache = new Map<number, Set<string>>();

export function getHolidayDates(year: number): Set<string> {
  const cached = _holidayCache.get(year);
  if (cached) return cached;

  const h = new Set<string>();

  // Fixed
  h.add(year + '-01-01');  // New Year's Day
  h.add(year + '-07-03');  // July 4th weekend
  h.add(year + '-07-04');  // Independence Day
  h.add(year + '-07-05');  // July 4th weekend
  h.add(year + '-10-31');  // Halloween
  h.add(year + '-12-24');  // Christmas Eve
  h.add(year + '-12-25');  // Christmas Day
  h.add(year + '-12-31');  // New Year's Eve

  // Floating single-day
  h.add(nthWeekday(year, 1, 1, 3));   // MLK Day (3rd Monday of January)
  h.add(nthWeekday(year, 2, 1, 3));   // Presidents' Day (3rd Monday of February)

  // Easter weekend (Good Friday through Easter Monday)
  const easter = easterSunday(year);
  h.add(addDays(easter, -2)); // Good Friday
  h.add(addDays(easter, -1)); // Easter Saturday
  h.add(easter);              // Easter Sunday
  h.add(addDays(easter, 1));  // Easter Monday

  // Memorial Day weekend (Sat-Mon)
  const memDay = lastWeekday(year, 5, 1);
  h.add(addDays(memDay, -2));
  h.add(addDays(memDay, -1));
  h.add(memDay);

  // Labor Day weekend (Sat-Mon)
  const laborDay = nthWeekday(year, 9, 1, 1);
  h.add(addDays(laborDay, -2));
  h.add(addDays(laborDay, -1));
  h.add(laborDay);

  // Thanksgiving weekend (Thu-Sat)
  const tgDay = nthWeekday(year, 11, 4, 4);
  h.add(tgDay);
  h.add(addDays(tgDay, 1));
  h.add(addDays(tgDay, 2));

  _holidayCache.set(year, h);
  return h;
}

export function isHoliday(dateStr: string): boolean {
  const year = parseInt(dateStr.split('-')[0]);
  return getHolidayDates(year).has(dateStr);
}

// ── Promo Codes ─────────────────────────────────────────────────────
// Owner-distributed codes. RIVER = self-tow mode (no delivery, higher deposit, flat $175/night).

interface PromoOverrides {
  rate?: number;
  deposit?: number;
  removeDelivery?: boolean;
}

const PROMO_CODES: Record<string, { appliesTo: EquipmentKey[]; overrides: PromoOverrides }> = {
  RIVER: {
    appliesTo: ['rv'],
    overrides: {
      rate: 175,
      deposit: 500,
      removeDelivery: true,
    },
  },
};

export function resolvePromoCode(code: string | undefined, equipmentKey: EquipmentKey): PromoOverrides | null {
  if (!code) return null;
  const promo = PROMO_CODES[code.toUpperCase().trim()];
  if (!promo || !promo.appliesTo.includes(equipmentKey)) return null;
  return promo.overrides;
}

// ── Same-Week Detection ─────────────────────────────────────────────

/** Returns true if the earliest rental date is within 7 days of today. */
function isSameWeekBooking(dates: string[]): boolean {
  if (dates.length === 0) return false;
  const sorted = [...dates].sort();
  const earliest = new Date(sorted[0] + 'T00:00:00');
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const diffMs = earliest.getTime() - today.getTime();
  const diffDays = diffMs / (1000 * 60 * 60 * 24);
  return diffDays <= 7;
}

// ── Price Calculation ───────────────────────────────────────────────

export function calculatePrice(
  equipmentKey: EquipmentKey,
  numDays: number,
  addOnKeys: string[] = [],
  opts?: { dates?: string[]; paymentMode?: PaymentMode; promoCode?: string },
): PriceBreakdown {
  const equipment = EQUIPMENT[equipmentKey];
  if (!equipment) throw new Error(`Unknown equipment: ${equipmentKey}`);
  if (numDays < 1) throw new Error('Must rent for at least 1 day');

  const promo = resolvePromoCode(opts?.promoCode, equipmentKey);

  // If promo removes delivery, filter it out of requested add-ons
  let effectiveAddOns = [...addOnKeys];
  if (promo?.removeDelivery) {
    effectiveAddOns = effectiveAddOns.filter(k => k !== 'delivery');
  }

  const lineItems: LineItem[] = [];
  const baseRate = promo?.rate ?? equipment.rate;

  // RV: per-date holiday pricing when no promo is applied.
  // With a promo, the promo's flat rate overrides everything.
  if (equipmentKey === 'rv' && opts?.dates && opts.dates.length > 0 && !promo) {
    let regularCount = 0;
    let holidayCount = 0;
    for (const d of opts.dates) {
      if (isHoliday(d)) holidayCount++;
      else regularCount++;
    }

    if (holidayCount > 0 && regularCount > 0) {
      lineItems.push({
        name: `${equipment.label} — ${regularCount} ${equipment.unit}${regularCount > 1 ? 's' : ''} @ $${baseRate}`,
        quantity: regularCount,
        unitPrice: baseRate,
        total: baseRate * regularCount,
      });
      lineItems.push({
        name: `${equipment.label} — ${holidayCount} holiday ${equipment.unit}${holidayCount > 1 ? 's' : ''} @ $${RV_HOLIDAY_RATE}`,
        quantity: holidayCount,
        unitPrice: RV_HOLIDAY_RATE,
        total: RV_HOLIDAY_RATE * holidayCount,
      });
    } else if (holidayCount > 0) {
      lineItems.push({
        name: `${equipment.label} — ${holidayCount} holiday ${equipment.unit}${holidayCount > 1 ? 's' : ''}`,
        quantity: holidayCount,
        unitPrice: RV_HOLIDAY_RATE,
        total: RV_HOLIDAY_RATE * holidayCount,
      });
    } else {
      lineItems.push({
        name: `${equipment.label} — ${numDays} ${equipment.unit}${numDays > 1 ? 's' : ''}`,
        quantity: numDays,
        unitPrice: baseRate,
        total: baseRate * numDays,
      });
    }
  } else {
    // Non-RV, promo-overridden rate, or no dates provided
    lineItems.push({
      name: `${equipment.label} — ${numDays} ${equipment.unit}${numDays > 1 ? 's' : ''}`,
      quantity: numDays,
      unitPrice: baseRate,
      total: baseRate * numDays,
    });
  }

  // Add-ons
  const validAddOns: string[] = [];
  for (const key of effectiveAddOns) {
    const addOn = ADD_ONS[key];
    if (!addOn) continue;
    if (!addOn.appliesTo.includes(equipmentKey)) continue;

    validAddOns.push(key);

    if (addOn.unit === 'flat') {
      lineItems.push({
        name: addOn.label,
        quantity: 1,
        unitPrice: addOn.rate,
        total: addOn.rate,
      });
    } else {
      lineItems.push({
        name: `${addOn.label} — ${numDays} ${addOn.unit}${numDays > 1 ? 's' : ''}`,
        quantity: numDays,
        unitPrice: addOn.rate,
        total: addOn.rate * numDays,
      });
    }
  }

  const subtotal = lineItems.reduce((sum, item) => sum + item.total, 0);

  // Deposit: promo overrides > equipment default.
  // Delivery is mandatory for RV at the server level; pickup mode is only reachable via a promo
  // that sets its own deposit (e.g. RIVER). So the equipment default always holds for non-promo flows.
  const deposit: number = promo?.deposit ?? equipment.deposit;

  // Payment mode: customer can choose full; same-week RV always full; otherwise deposit allowed
  let paymentMode: PaymentMode;
  if (opts?.paymentMode === 'full') {
    paymentMode = 'full';
  } else if (equipmentKey === 'rv' && opts?.dates && !isSameWeekBooking(opts.dates)) {
    paymentMode = opts?.paymentMode || 'deposit';
  } else {
    paymentMode = 'full';
  }

  const totalWithDeposit = subtotal + deposit;
  const chargeNow = paymentMode === 'deposit' ? deposit : totalWithDeposit;
  const balance = paymentMode === 'deposit' ? subtotal : 0;

  return {
    equipment,
    numDays,
    lineItems,
    subtotal,
    deposit,
    balance,
    addOns: validAddOns,
    paymentMode,
    chargeNow,
  };
}

// ── Square Line Items Builder ───────────────────────────────────────

export function buildSquareLineItems(pricing: PriceBreakdown): Array<{
  name: string;
  quantity: string;
  base_price_money: { amount: number; currency: string };
}> {
  if (pricing.paymentMode === 'deposit') {
    // Deposit-only checkout: single line item for the security deposit
    return [{
      name: `${pricing.equipment.label} — Refundable Security Deposit (balance of $${pricing.subtotal.toFixed(2)} due before rental)`,
      quantity: '1',
      base_price_money: {
        amount: Math.round(pricing.deposit * 100),
        currency: 'USD',
      },
    }];
  }

  // Full payment: all line items + deposit
  const items = pricing.lineItems.map((item) => ({
    name: item.name,
    quantity: item.quantity.toString(),
    base_price_money: {
      amount: Math.round(item.unitPrice * 100),
      currency: 'USD',
    },
  }));

  items.push({
    name: 'Refundable Security Deposit',
    quantity: '1',
    base_price_money: {
      amount: Math.round(pricing.deposit * 100),
      currency: 'USD',
    },
  });

  return items;
}
