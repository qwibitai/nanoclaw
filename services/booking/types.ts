// Shared types for the Sheridan Rentals Booking API

export type EquipmentKey = 'rv' | 'carhauler' | 'landscaping';

export interface EquipmentConfig {
  key: EquipmentKey;
  label: string;
  rate: number;
  unit: 'night' | 'day';
  deposit: number;
  calendarId: string;
}

export interface AddOn {
  key: string;
  label: string;
  rate: number;
  unit: 'night' | 'day' | 'flat';
  appliesTo: EquipmentKey[];
}

export interface LineItem {
  name: string;
  quantity: number;
  unitPrice: number;
  total: number;
}

/** 'full' = charge everything now, 'deposit' = charge deposit only (balance due before rental) */
export type PaymentMode = 'full' | 'deposit';

export interface PriceBreakdown {
  equipment: EquipmentConfig;
  numDays: number;
  lineItems: LineItem[];
  subtotal: number;
  deposit: number;
  balance: number;
  addOns: string[];
  /** What the customer pays at checkout — full amount or deposit only */
  paymentMode: PaymentMode;
  /** Amount charged to Square right now */
  chargeNow: number;
}

export interface Customer {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
}

export interface CheckoutRequest {
  equipment: EquipmentKey;
  dates: string[];       // YYYY-MM-DD sorted
  customer: Customer;
  addOns?: string[];     // ['generator', 'delivery']
  details?: string;
  timeSlot?: string;
  paymentMode?: PaymentMode;
  /** Owner-distributed promo code (e.g. "RIVER" for RV self-tow). */
  promoCode?: string;
  /** File ID of a previously-uploaded license photo from /api/upload. */
  licenseFileId?: string;
  /** Session ID used during the license upload (must match /api/upload response). */
  sessionId?: string;
  /** Destination / delivery address for the camper. Required for RV unless RIVER promo is active. */
  deliveryAddress?: string;
}

export interface CheckoutResponse {
  bookingId: string;
  paymentUrl: string;
  orderId: string;
  pricing: PriceBreakdown;
}

export type BookingStatus = 'pending' | 'paid' | 'confirmed' | 'cancelled' | 'refunded';

export interface Booking {
  id: string;
  equipment: EquipmentKey;
  equipmentLabel: string;
  dates: string[];       // JSON-stored array of YYYY-MM-DD
  numDays: number;
  customer: Customer;
  subtotal: number;
  deposit: number;
  balance: number;
  addOns: string[];      // JSON-stored array
  details: string;
  status: BookingStatus;
  squareOrderId: string;
  squarePaymentLinkId: string;
  paymentUrl: string;
  calendarEventId: string;
  refundId: string;
  followupSent: boolean;
  followupSentAt: string | null;
  /** File ID of the license photo on disk (empty string if none uploaded). */
  licenseFileId: string;
  /** Destination address for the camper (empty string if pickup via RIVER promo). */
  deliveryAddress: string;
  createdAt: string;
  updatedAt: string;
}

export interface AvailabilityRequest {
  equipment: EquipmentKey;
  startDate: string;     // YYYY-MM-DD
  endDate: string;       // YYYY-MM-DD
}

export interface BusySlot {
  start: string;
  end: string;
}

export interface AvailabilityResponse {
  equipment: EquipmentKey;
  busySlots: BusySlot[];
  startDate: string;
  endDate: string;
}
