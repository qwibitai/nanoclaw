// Booking domain types for the WhatsApp booking bot
// Tenants = businesses (barbershop, nail salon, gym)
// Staff = employees/chairs/resources that can be booked
// Bookings = confirmed appointments
// Customers = people who book (identified by phone number)

export type BusinessCategory = 'barbershop' | 'nail_salon' | 'gym_pt' | 'other';
export type BookingStatus = 'pending' | 'confirmed' | 'cancelled' | 'completed' | 'no_show';
export type DayOfWeek = 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun';

export interface WorkingHours {
  day: DayOfWeek;
  open: string;   // "09:00"
  close: string;  // "18:00"
}

export interface Service {
  name: string;         // "Tuns + Barba"
  duration_min: number; // 45
  price_ron: number;    // 60
}

export interface TenantConfig {
  faq?: Record<string, string>;       // { "parking": "Strada X nr. 5", "payment": "Cash sau card" }
  rules?: string[];                   // ["Ultima programare cu 30min inainte de inchidere"]
  welcome_message?: string;           // First message sent when a new customer writes
  language?: string;                  // default: "ro"
}

export interface Tenant {
  id: string;
  whatsapp_jid: string;        // JID of the business WhatsApp number/group
  business_name: string;       // "Frizeria Andrei"
  category: BusinessCategory;
  config: TenantConfig;
  active: boolean;
  created_at: string;
}

export interface StaffMember {
  id: string;
  tenant_id: string;
  name: string;
  services: Service[];
  working_hours: WorkingHours[];
  active: boolean;
}

export interface Booking {
  id: string;
  tenant_id: string;
  staff_id: string;
  customer_phone: string;
  customer_name: string;
  service_name: string;
  service_duration_min: number;
  start_time: string;  // ISO 8601: "2025-03-15T10:00:00"
  end_time: string;    // ISO 8601: "2025-03-15T10:45:00"
  status: BookingStatus;
  notes?: string;
  created_at: string;
}

export interface Customer {
  id: string;
  tenant_id: string;
  phone: string;
  name: string;
  last_booking_at: string | null;
}

// Used by the booking tools inside the container
export interface AvailableSlot {
  staff_id: string;
  staff_name: string;
  start_time: string;
  end_time: string;
}

export interface BookingToolResult {
  success: boolean;
  message: string;   // Human-readable message in Romanian
  data?: unknown;
}
