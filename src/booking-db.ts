import Database from 'better-sqlite3';

import {
  AvailableSlot,
  Booking,
  BookingStatus,
  Customer,
  StaffMember,
  Tenant,
  TenantConfig,
  WorkingHours,
} from './booking-types.js';

let bookingDb: Database.Database;

export function initBookingDb(database: Database.Database): void {
  bookingDb = database;
}

// --- Helpers ---

const DAY_MAP: Record<string, string> = {
  '0': 'sun',
  '1': 'mon',
  '2': 'tue',
  '3': 'wed',
  '4': 'thu',
  '5': 'fri',
  '6': 'sat',
};

function rowToTenant(row: {
  id: string;
  whatsapp_jid: string;
  business_name: string;
  category: string;
  config_json: string;
  active: number;
  created_at: string;
}): Tenant {
  return {
    id: row.id,
    whatsapp_jid: row.whatsapp_jid,
    business_name: row.business_name,
    category: row.category as Tenant['category'],
    config: JSON.parse(row.config_json) as TenantConfig,
    active: row.active === 1,
    created_at: row.created_at,
  };
}

function rowToStaff(row: {
  id: string;
  tenant_id: string;
  name: string;
  services_json: string;
  working_hours_json: string;
  active: number;
}): StaffMember {
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    name: row.name,
    services: JSON.parse(row.services_json),
    working_hours: JSON.parse(row.working_hours_json),
    active: row.active === 1,
  };
}

function rowToBooking(row: {
  id: string;
  tenant_id: string;
  staff_id: string;
  customer_phone: string;
  customer_name: string;
  service_name: string;
  service_duration_min: number;
  start_time: string;
  end_time: string;
  status: string;
  notes: string | null;
  created_at: string;
}): Booking {
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    staff_id: row.staff_id,
    customer_phone: row.customer_phone,
    customer_name: row.customer_name,
    service_name: row.service_name,
    service_duration_min: row.service_duration_min,
    start_time: row.start_time,
    end_time: row.end_time,
    status: row.status as BookingStatus,
    notes: row.notes ?? undefined,
    created_at: row.created_at,
  };
}

// --- Tenant ---

export function createTenant(tenant: Tenant): void {
  bookingDb
    .prepare(
      `INSERT INTO tenants (id, whatsapp_jid, business_name, category, config_json, active, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      tenant.id,
      tenant.whatsapp_jid,
      tenant.business_name,
      tenant.category,
      JSON.stringify(tenant.config),
      tenant.active ? 1 : 0,
      tenant.created_at,
    );
}

export function getTenantByJid(jid: string): Tenant | undefined {
  const row = bookingDb
    .prepare('SELECT * FROM tenants WHERE whatsapp_jid = ?')
    .get(jid) as Parameters<typeof rowToTenant>[0] | undefined;
  return row ? rowToTenant(row) : undefined;
}

export function getTenantById(id: string): Tenant | undefined {
  const row = bookingDb
    .prepare('SELECT * FROM tenants WHERE id = ?')
    .get(id) as Parameters<typeof rowToTenant>[0] | undefined;
  return row ? rowToTenant(row) : undefined;
}

export function getAllActiveTenants(): Tenant[] {
  const rows = bookingDb
    .prepare('SELECT * FROM tenants WHERE active = 1')
    .all() as Parameters<typeof rowToTenant>[0][];
  return rows.map(rowToTenant);
}

export function updateTenantConfig(id: string, config: TenantConfig): void {
  bookingDb
    .prepare('UPDATE tenants SET config_json = ? WHERE id = ?')
    .run(JSON.stringify(config), id);
}

export function setTenantActive(id: string, active: boolean): void {
  bookingDb
    .prepare('UPDATE tenants SET active = ? WHERE id = ?')
    .run(active ? 1 : 0, id);
}

// --- Staff ---

export function createStaffMember(staff: StaffMember): void {
  bookingDb
    .prepare(
      `INSERT INTO staff (id, tenant_id, name, services_json, working_hours_json, active)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      staff.id,
      staff.tenant_id,
      staff.name,
      JSON.stringify(staff.services),
      JSON.stringify(staff.working_hours),
      staff.active ? 1 : 0,
    );
}

export function getStaffByTenant(tenantId: string): StaffMember[] {
  const rows = bookingDb
    .prepare('SELECT * FROM staff WHERE tenant_id = ? AND active = 1')
    .all(tenantId) as Parameters<typeof rowToStaff>[0][];
  return rows.map(rowToStaff);
}

export function getStaffById(id: string): StaffMember | undefined {
  const row = bookingDb
    .prepare('SELECT * FROM staff WHERE id = ?')
    .get(id) as Parameters<typeof rowToStaff>[0] | undefined;
  return row ? rowToStaff(row) : undefined;
}

export function updateStaffMember(
  id: string,
  updates: Partial<
    Pick<StaffMember, 'name' | 'services' | 'working_hours' | 'active'>
  >,
): void {
  const fields: string[] = [];
  const values: unknown[] = [];

  if (updates.name !== undefined) {
    fields.push('name = ?');
    values.push(updates.name);
  }
  if (updates.services !== undefined) {
    fields.push('services_json = ?');
    values.push(JSON.stringify(updates.services));
  }
  if (updates.working_hours !== undefined) {
    fields.push('working_hours_json = ?');
    values.push(JSON.stringify(updates.working_hours));
  }
  if (updates.active !== undefined) {
    fields.push('active = ?');
    values.push(updates.active ? 1 : 0);
  }

  if (fields.length === 0) return;
  values.push(id);
  bookingDb
    .prepare(`UPDATE staff SET ${fields.join(', ')} WHERE id = ?`)
    .run(...values);
}

// --- Bookings ---

export function createBooking(booking: Booking): void {
  bookingDb
    .prepare(
      `INSERT INTO bookings (id, tenant_id, staff_id, customer_phone, customer_name,
        service_name, service_duration_min, start_time, end_time, status, notes, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      booking.id,
      booking.tenant_id,
      booking.staff_id,
      booking.customer_phone,
      booking.customer_name,
      booking.service_name,
      booking.service_duration_min,
      booking.start_time,
      booking.end_time,
      booking.status,
      booking.notes ?? null,
      booking.created_at,
    );
}

export function getBookingById(id: string): Booking | undefined {
  const row = bookingDb
    .prepare('SELECT * FROM bookings WHERE id = ?')
    .get(id) as Parameters<typeof rowToBooking>[0] | undefined;
  return row ? rowToBooking(row) : undefined;
}

export function getBookingsByStaffAndDate(
  staffId: string,
  date: string,
): Booking[] {
  const rows = bookingDb
    .prepare(
      `SELECT * FROM bookings
       WHERE staff_id = ? AND start_time LIKE ? AND status != 'cancelled'
       ORDER BY start_time`,
    )
    .all(staffId, `${date}%`) as Parameters<typeof rowToBooking>[0][];
  return rows.map(rowToBooking);
}

export function getBookingsByCustomer(
  phone: string,
  tenantId: string,
): Booking[] {
  const rows = bookingDb
    .prepare(
      `SELECT * FROM bookings
       WHERE customer_phone = ? AND tenant_id = ?
       ORDER BY start_time DESC`,
    )
    .all(phone, tenantId) as Parameters<typeof rowToBooking>[0][];
  return rows.map(rowToBooking);
}

export function getUpcomingBookings(
  tenantId: string,
  fromTime: string,
): Booking[] {
  const rows = bookingDb
    .prepare(
      `SELECT * FROM bookings
       WHERE tenant_id = ? AND start_time >= ? AND status != 'cancelled'
       ORDER BY start_time`,
    )
    .all(tenantId, fromTime) as Parameters<typeof rowToBooking>[0][];
  return rows.map(rowToBooking);
}

export function updateBookingStatus(id: string, status: BookingStatus): void {
  bookingDb
    .prepare('UPDATE bookings SET status = ? WHERE id = ?')
    .run(status, id);
}

export function cancelBooking(id: string, phone: string): boolean {
  const result = bookingDb
    .prepare(
      `UPDATE bookings SET status = 'cancelled'
       WHERE id = ? AND customer_phone = ? AND status != 'cancelled'`,
    )
    .run(id, phone);
  return result.changes > 0;
}

// --- Customers ---

export function upsertCustomer(
  customer: Omit<Customer, 'id'>,
): Customer {
  const id = `cust_${customer.tenant_id}_${customer.phone}`;
  bookingDb
    .prepare(
      `INSERT INTO customers (id, tenant_id, phone, name, last_booking_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(tenant_id, phone) DO UPDATE SET
         name = excluded.name,
         last_booking_at = COALESCE(excluded.last_booking_at, last_booking_at)`,
    )
    .run(
      id,
      customer.tenant_id,
      customer.phone,
      customer.name,
      customer.last_booking_at,
    );
  return { id, ...customer };
}

export function getCustomerByPhone(
  phone: string,
  tenantId: string,
): Customer | undefined {
  const row = bookingDb
    .prepare('SELECT * FROM customers WHERE phone = ? AND tenant_id = ?')
    .get(phone, tenantId) as Customer | undefined;
  return row;
}

// --- Availability ---

export function getAvailableSlots(
  tenantId: string,
  date: string,
  serviceDurationMin: number,
  staffId?: string,
): AvailableSlot[] {
  const allStaff = staffId
    ? [getStaffById(staffId)].filter(Boolean) as StaffMember[]
    : getStaffByTenant(tenantId);

  const now = new Date();
  const slots: AvailableSlot[] = [];

  // day of week for the requested date
  const dateObj = new Date(`${date}T00:00:00`);
  const dayKey = String(dateObj.getDay());
  const dayOfWeek = DAY_MAP[dayKey];

  for (const staff of allStaff) {
    const wh: WorkingHours | undefined = staff.working_hours.find(
      (h) => h.day === dayOfWeek,
    );
    if (!wh) continue;

    // existing bookings for this staff on this date
    const existingBookings = getBookingsByStaffAndDate(staff.id, date);

    // generate candidate slots every 30 min
    const [openH, openM] = wh.open.split(':').map(Number);
    const [closeH, closeM] = wh.close.split(':').map(Number);
    const openMin = openH * 60 + openM;
    const closeMin = closeH * 60 + closeM;

    for (
      let startMin = openMin;
      startMin + serviceDurationMin <= closeMin;
      startMin += 30
    ) {
      const endMin = startMin + serviceDurationMin;

      const startTime = `${date}T${String(Math.floor(startMin / 60)).padStart(2, '0')}:${String(startMin % 60).padStart(2, '0')}:00`;
      const endTime = `${date}T${String(Math.floor(endMin / 60)).padStart(2, '0')}:${String(endMin % 60).padStart(2, '0')}:00`;

      // skip past slots
      if (new Date(startTime) <= now) continue;

      // check overlap with existing bookings
      const overlaps = existingBookings.some((b) => {
        return b.start_time < endTime && b.end_time > startTime;
      });
      if (overlaps) continue;

      slots.push({
        staff_id: staff.id,
        staff_name: staff.name,
        start_time: startTime,
        end_time: endTime,
      });
    }
  }

  return slots;
}
