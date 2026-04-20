import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { calculatePrice, buildSquareLineItems, EQUIPMENT } from './pricing.js';

// ── Helper: generate dates relative to today ─────────────────────────

function daysFromNow(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10); // YYYY-MM-DD
}

// ── calculatePrice — basic pricing ───────────────────────────────────

describe('calculatePrice — basic', () => {
  it('calculates RV price for 3 nights (pricing-only — $250 equipment default)', () => {
    const result = calculatePrice('rv', 3);
    expect(result.subtotal).toBe(150 * 3);
    // Pricing uses the equipment default; the server layer enforces that RV must include
    // delivery (or an explicit promo override), so an un-configured RV never reaches Square.
    expect(result.deposit).toBe(250);
    expect(result.numDays).toBe(3);
    expect(result.equipment.key).toBe('rv');
  });

  it('calculates carhauler price for 2 days', () => {
    const result = calculatePrice('carhauler', 2);
    expect(result.subtotal).toBe(65 * 2);
    expect(result.deposit).toBe(50);
  });

  it('includes valid add-ons', () => {
    const result = calculatePrice('rv', 3, ['generator', 'delivery']);
    // Base: 150*3 = 450, Generator: 85*3 = 255, Delivery: 250 flat
    expect(result.subtotal).toBe(450 + 255 + 250);
    expect(result.addOns).toEqual(['generator', 'delivery']);
    expect(result.lineItems).toHaveLength(3);
  });

  it('ignores add-ons that do not apply to equipment', () => {
    // Generator only applies to RV
    const result = calculatePrice('carhauler', 2, ['generator']);
    expect(result.addOns).toEqual([]);
    expect(result.subtotal).toBe(65 * 2);
  });

  it('ignores unknown add-on keys', () => {
    const result = calculatePrice('rv', 1, ['nonexistent']);
    expect(result.addOns).toEqual([]);
  });

  it('throws on unknown equipment', () => {
    expect(() => calculatePrice('jetski' as any, 1)).toThrow('Unknown equipment');
  });

  it('throws on zero days', () => {
    expect(() => calculatePrice('rv', 0)).toThrow('Must rent for at least 1 day');
  });
});

// ── calculatePrice — RV payment mode logic ───────────────────────────

describe('calculatePrice — RV payment mode', () => {
  it('same-week dates → paymentMode = full, chargeNow = subtotal + deposit', () => {
    const dates = [daysFromNow(2), daysFromNow(3), daysFromNow(4)];
    const result = calculatePrice('rv', 3, [], { dates });
    expect(result.paymentMode).toBe('full');
    expect(result.chargeNow).toBe(result.subtotal + result.deposit);
    expect(result.balance).toBe(0);
  });

  it('advance dates (>7 days out) → paymentMode = deposit, chargeNow = deposit only', () => {
    const dates = [daysFromNow(14), daysFromNow(15), daysFromNow(16)];
    const result = calculatePrice('rv', 3, [], { dates });
    expect(result.paymentMode).toBe('deposit');
    expect(result.chargeNow).toBe(result.deposit);
    expect(result.balance).toBe(result.subtotal);
  });

  it('advance dates with paymentMode=full → paymentMode = full, chargeNow = subtotal + deposit', () => {
    const dates = [daysFromNow(14), daysFromNow(15), daysFromNow(16)];
    const result = calculatePrice('rv', 3, [], { dates, paymentMode: 'full' });
    expect(result.paymentMode).toBe('full');
    expect(result.chargeNow).toBe(result.subtotal + result.deposit);
    expect(result.balance).toBe(0);
  });

  it('no dates provided → defaults to full', () => {
    const result = calculatePrice('rv', 3);
    expect(result.paymentMode).toBe('full');
    expect(result.chargeNow).toBe(result.subtotal + result.deposit);
  });

  it('empty dates array → falls to deposit (isSameWeekBooking returns false for empty)', () => {
    // NOTE: This is a potential edge case / bug. When dates=[] is passed,
    // isSameWeekBooking returns false, so the code treats it as an advance booking.
    // In practice dates should never be empty when opts.dates is provided.
    const result = calculatePrice('rv', 3, [], { dates: [] });
    expect(result.paymentMode).toBe('deposit');
  });
});

// ── calculatePrice — Non-RV always full ──────────────────────────────

describe('calculatePrice — non-RV equipment', () => {
  it('carhauler with advance dates → always full', () => {
    const dates = [daysFromNow(14), daysFromNow(15)];
    const result = calculatePrice('carhauler', 2, [], { dates });
    expect(result.paymentMode).toBe('full');
    expect(result.chargeNow).toBe(result.subtotal + result.deposit);
    expect(result.balance).toBe(0);
  });

  it('landscaping trailer with advance dates → always full', () => {
    const dates = [daysFromNow(30)];
    const result = calculatePrice('landscaping', 1, [], { dates });
    expect(result.paymentMode).toBe('full');
    expect(result.chargeNow).toBe(result.subtotal + result.deposit);
  });

  it('carhauler with paymentMode deposit hint → still full (non-RV)', () => {
    const dates = [daysFromNow(14)];
    const result = calculatePrice('carhauler', 1, [], { dates, paymentMode: 'deposit' });
    // Non-RV ignores deposit hint; only opts.paymentMode === 'full' is a special case
    // The logic: paymentMode is not 'full', equipmentKey is not 'rv', so → 'full'
    expect(result.paymentMode).toBe('full');
  });
});

// ── buildSquareLineItems — full mode ─────────────────────────────────

describe('buildSquareLineItems — full mode', () => {
  it('returns all rental line items + deposit line item', () => {
    const pricing = calculatePrice('rv', 3, ['generator']);
    expect(pricing.paymentMode).toBe('full');

    const items = buildSquareLineItems(pricing);
    // 2 rental items (base + generator) + 1 deposit = 3
    expect(items).toHaveLength(3);

    // Base rental line item
    expect(items[0].name).toContain('RV Camper');
    expect(items[0].quantity).toBe('3');
    expect(items[0].base_price_money.amount).toBe(150 * 100); // cents

    // Generator add-on
    expect(items[1].name).toContain('Generator');
    expect(items[1].quantity).toBe('3');
    expect(items[1].base_price_money.amount).toBe(85 * 100);

    // Deposit — equipment default $250 (server layer forces delivery add-on for real bookings)
    expect(items[2].name).toBe('Refundable Security Deposit');
    expect(items[2].quantity).toBe('1');
    expect(items[2].base_price_money.amount).toBe(250 * 100);
  });

  it('all amounts are in cents (USD)', () => {
    const pricing = calculatePrice('carhauler', 2);
    const items = buildSquareLineItems(pricing);
    for (const item of items) {
      expect(item.base_price_money.currency).toBe('USD');
      expect(Number.isInteger(item.base_price_money.amount)).toBe(true);
    }
  });
});

// ── buildSquareLineItems — deposit mode ──────────────────────────────

describe('buildSquareLineItems — deposit mode', () => {
  it('returns single deposit line item with balance note', () => {
    const dates = [daysFromNow(14), daysFromNow(15), daysFromNow(16)];
    const pricing = calculatePrice('rv', 3, [], { dates });
    expect(pricing.paymentMode).toBe('deposit');

    const items = buildSquareLineItems(pricing);
    expect(items).toHaveLength(1);
    expect(items[0].name).toContain('Refundable Security Deposit');
    expect(items[0].name).toContain('balance');
    expect(items[0].quantity).toBe('1');
    // Equipment default $250 (server enforces delivery for real RV bookings)
    expect(items[0].base_price_money.amount).toBe(250 * 100);
  });

  it('deposit line item includes the balance amount in the name', () => {
    const dates = [daysFromNow(14), daysFromNow(15), daysFromNow(16)];
    const pricing = calculatePrice('rv', 3, [], { dates });
    const items = buildSquareLineItems(pricing);
    // Balance = subtotal = 150*3 = 450
    expect(items[0].name).toContain('$450.00');
  });
});

// ── Integration: full booking flow simulation ────────────────────────

describe('Integration — booking flow', () => {
  it('RV with advance dates → deposit mode → correct line items', () => {
    const dates = [daysFromNow(14), daysFromNow(15), daysFromNow(16)];
    const pricing = calculatePrice('rv', 3, ['delivery'], { dates });

    expect(pricing.paymentMode).toBe('deposit');
    expect(pricing.chargeNow).toBe(pricing.deposit); // $250
    expect(pricing.balance).toBe(pricing.subtotal);   // $450 + $250 delivery = $700

    const items = buildSquareLineItems(pricing);
    expect(items).toHaveLength(1);
    expect(items[0].base_price_money.amount).toBe(250 * 100);
  });

  it('RV with same-week dates → full mode → all line items', () => {
    const dates = [daysFromNow(2), daysFromNow(3), daysFromNow(4)];
    const pricing = calculatePrice('rv', 3, ['delivery'], { dates });

    expect(pricing.paymentMode).toBe('full');
    expect(pricing.chargeNow).toBe(pricing.subtotal + pricing.deposit);
    expect(pricing.balance).toBe(0);

    const items = buildSquareLineItems(pricing);
    // Base rental + delivery + deposit = 3
    expect(items).toHaveLength(3);
  });

  it('carhauler with advance dates → always full mode → all line items', () => {
    const dates = [daysFromNow(14), daysFromNow(15)];
    const pricing = calculatePrice('carhauler', 2, [], { dates });

    expect(pricing.paymentMode).toBe('full');
    expect(pricing.chargeNow).toBe(pricing.subtotal + pricing.deposit); // $130 + $50
    expect(pricing.balance).toBe(0);

    const items = buildSquareLineItems(pricing);
    // Base rental + deposit = 2
    expect(items).toHaveLength(2);
    expect(items[0].name).toContain('Car Hauler');
    expect(items[1].name).toBe('Refundable Security Deposit');
  });

  it('RV full mode with add-ons → correct totals', () => {
    const dates = [daysFromNow(2), daysFromNow(3)];
    const pricing = calculatePrice('rv', 2, ['generator', 'delivery'], { dates });

    expect(pricing.paymentMode).toBe('full');
    // Base: 150*2=300, Generator: 85*2=170, Delivery: 250 flat
    expect(pricing.subtotal).toBe(300 + 170 + 250);
    expect(pricing.chargeNow).toBe(300 + 170 + 250 + 250); // subtotal + deposit
    expect(pricing.deposit).toBe(250);

    const items = buildSquareLineItems(pricing);
    expect(items).toHaveLength(4); // base + generator + delivery + deposit
  });
});

// ── Holiday pricing (RV only) ────────────────────────────────────────

describe('calculatePrice — RV holiday pricing', () => {
  it('all-regular dates use base rate', () => {
    // Pick far-future non-holiday dates
    const dates = ['2035-03-10', '2035-03-11', '2035-03-12'];
    const pricing = calculatePrice('rv', 3, [], { dates, paymentMode: 'full' });
    expect(pricing.subtotal).toBe(150 * 3);
    expect(pricing.lineItems[0].unitPrice).toBe(150);
  });

  it('all-holiday dates use $175/night', () => {
    // July 4th weekend 2035
    const dates = ['2035-07-03', '2035-07-04', '2035-07-05'];
    const pricing = calculatePrice('rv', 3, [], { dates, paymentMode: 'full' });
    expect(pricing.subtotal).toBe(175 * 3);
    expect(pricing.lineItems[0].unitPrice).toBe(175);
    expect(pricing.lineItems[0].name).toContain('holiday');
  });

  it('mixed holiday + regular dates split into two line items', () => {
    // Jul 4 (holiday) + Jul 6 (regular). Two line items.
    const dates = ['2035-07-04', '2035-07-06'];
    const pricing = calculatePrice('rv', 2, [], { dates, paymentMode: 'full' });
    // 1 regular @ $150 + 1 holiday @ $175 = $325
    expect(pricing.subtotal).toBe(150 + 175);
    expect(pricing.lineItems).toHaveLength(2);
    expect(pricing.lineItems.some(li => li.unitPrice === 150)).toBe(true);
    expect(pricing.lineItems.some(li => li.unitPrice === 175)).toBe(true);
  });

  it('does not apply holiday pricing to carhauler', () => {
    const dates = ['2035-07-04', '2035-07-05'];
    const pricing = calculatePrice('carhauler', 2, [], { dates });
    expect(pricing.subtotal).toBe(65 * 2);
  });
});

// ── Promo code (RIVER) ───────────────────────────────────────────────

describe('calculatePrice — RIVER promo', () => {
  it('applies $175 flat rate, removes delivery, $500 deposit', () => {
    const dates = ['2035-07-04', '2035-07-05']; // even on holiday
    const pricing = calculatePrice('rv', 2, ['delivery', 'generator'], {
      dates,
      paymentMode: 'full',
      promoCode: 'RIVER',
    });
    expect(pricing.subtotal).toBe(175 * 2 + 85 * 2); // rental + generator (delivery removed)
    expect(pricing.deposit).toBe(500);
    expect(pricing.addOns).not.toContain('delivery');
    expect(pricing.addOns).toContain('generator');
    // Rate is flat $175/night, not split into holiday/regular
    expect(pricing.lineItems[0].unitPrice).toBe(175);
  });

  it('applies $175 on non-holiday dates too (flat rate)', () => {
    const dates = ['2035-03-10', '2035-03-11'];
    const pricing = calculatePrice('rv', 2, [], {
      dates,
      paymentMode: 'full',
      promoCode: 'RIVER',
    });
    expect(pricing.subtotal).toBe(175 * 2);
    expect(pricing.deposit).toBe(500);
  });

  it('is case-insensitive', () => {
    const dates = ['2035-03-10'];
    const pricing = calculatePrice('rv', 1, [], {
      dates,
      paymentMode: 'full',
      promoCode: 'river',
    });
    expect(pricing.subtotal).toBe(175);
  });

  it('does not apply to carhauler', () => {
    const dates = ['2035-03-10'];
    const pricing = calculatePrice('carhauler', 1, [], {
      dates,
      promoCode: 'RIVER',
    });
    expect(pricing.subtotal).toBe(65);
    expect(pricing.deposit).toBe(50);
  });

  it('unknown promo code is silently ignored', () => {
    const dates = ['2035-03-10'];
    const pricing = calculatePrice('rv', 1, [], {
      dates,
      paymentMode: 'full',
      promoCode: 'NOPE',
    });
    expect(pricing.subtotal).toBe(150);
    expect(pricing.deposit).toBe(250); // equipment default; server rejects missing delivery
  });
});
