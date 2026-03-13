---
name: add-booking-engine
description: Add the multi-tenant booking engine to NanoClaw for a WhatsApp appointment booking bot.
---

# Add Booking Engine

This skill transforms NanoClaw into a WhatsApp booking bot backend. It adds:
- Multi-tenant DB schema (tenants, staff, bookings, customers)
- TypeScript types for the booking domain
- CRUD functions in a new `src/booking-db.ts` module
- Booking tools available inside the container agent
- A seed script to create a test barbershop tenant
- Tenant group registration with `requiresTrigger: false` (no trigger word needed)

## Phase 1: Pre-flight

### Check current state

Verify NanoClaw is installed and the DB module exists:

```bash
test -f src/db.ts && echo "db.ts present" || echo "ERROR: run /setup first"
test -f package.json && node -e "require('./package.json')" && echo "package.json OK"
```

Check that the booking engine is not already applied:

```bash
test -f src/booking-db.ts && echo "ALREADY APPLIED — booking-db.ts exists" || echo "Clean — proceeding"
```

If already applied, stop and tell the user the skill has already been applied.

## Phase 2: Add TypeScript Types

Create `src/booking-types.ts` with all booking domain interfaces:

```typescript
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
```

## Phase 3: Extend DB Schema

Open `src/db.ts` and add the booking tables inside the `createSchema` function, after the existing table definitions and before the first `ALTER TABLE` migration block.

Add these tables:

```sql
CREATE TABLE IF NOT EXISTS tenants (
  id TEXT PRIMARY KEY,
  whatsapp_jid TEXT NOT NULL UNIQUE,
  business_name TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'other',
  config_json TEXT NOT NULL DEFAULT '{}',
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tenants_jid ON tenants(whatsapp_jid);

CREATE TABLE IF NOT EXISTS staff (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  name TEXT NOT NULL,
  services_json TEXT NOT NULL DEFAULT '[]',
  working_hours_json TEXT NOT NULL DEFAULT '[]',
  active INTEGER NOT NULL DEFAULT 1,
  FOREIGN KEY (tenant_id) REFERENCES tenants(id)
);
CREATE INDEX IF NOT EXISTS idx_staff_tenant ON staff(tenant_id);

CREATE TABLE IF NOT EXISTS bookings (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  staff_id TEXT NOT NULL,
  customer_phone TEXT NOT NULL,
  customer_name TEXT NOT NULL,
  service_name TEXT NOT NULL,
  service_duration_min INTEGER NOT NULL,
  start_time TEXT NOT NULL,
  end_time TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'confirmed',
  notes TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (tenant_id) REFERENCES tenants(id),
  FOREIGN KEY (staff_id) REFERENCES staff(id)
);
CREATE INDEX IF NOT EXISTS idx_bookings_tenant ON bookings(tenant_id);
CREATE INDEX IF NOT EXISTS idx_bookings_staff_time ON bookings(staff_id, start_time);
CREATE INDEX IF NOT EXISTS idx_bookings_customer ON bookings(customer_phone, tenant_id);

CREATE TABLE IF NOT EXISTS customers (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  phone TEXT NOT NULL,
  name TEXT NOT NULL,
  last_booking_at TEXT,
  UNIQUE(tenant_id, phone),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id)
);
CREATE INDEX IF NOT EXISTS idx_customers_phone ON customers(tenant_id, phone);
```

## Phase 4: Create `src/booking-db.ts`

Create a new file `src/booking-db.ts` with all CRUD functions for the booking domain.

The file must:
- Import `Database` from `better-sqlite3` and types from `./booking-types.js`
- Import the existing `db` instance — BUT `db` is module-private in `src/db.ts`.
  **Instead**: export a `initBookingDb(database: Database.Database): void` function
  that stores the reference, and call it from `src/db.ts` inside `initDatabase()`.
- Use the same pattern as `src/db.ts`: prepared statements, synchronous calls.

Functions to implement:

```typescript
// --- Tenant ---
createTenant(tenant: Tenant): void
getTenantByJid(jid: string): Tenant | undefined
getTenantById(id: string): Tenant | undefined
getAllActiveTenants(): Tenant[]
updateTenantConfig(id: string, config: TenantConfig): void
setTenantActive(id: string, active: boolean): void

// --- Staff ---
createStaffMember(staff: StaffMember): void
getStaffByTenant(tenantId: string): StaffMember[]
getStaffById(id: string): StaffMember | undefined
updateStaffMember(id: string, updates: Partial<Pick<StaffMember, 'name' | 'services' | 'working_hours' | 'active'>>): void

// --- Bookings ---
createBooking(booking: Booking): void
getBookingById(id: string): Booking | undefined
getBookingsByStaffAndDate(staffId: string, date: string): Booking[]      // date = "YYYY-MM-DD"
getBookingsByCustomer(phone: string, tenantId: string): Booking[]
getUpcomingBookings(tenantId: string, fromTime: string): Booking[]
updateBookingStatus(id: string, status: BookingStatus): void
cancelBooking(id: string, phone: string): boolean   // returns false if phone doesn't match

// --- Customers ---
upsertCustomer(customer: Omit<Customer, 'id'>): Customer
getCustomerByPhone(phone: string, tenantId: string): Customer | undefined

// --- Availability ---
getAvailableSlots(
  tenantId: string,
  date: string,           // "YYYY-MM-DD"
  serviceDurationMin: number,
  staffId?: string        // optional: filter to one staff member
): AvailableSlot[]
```

The `getAvailableSlots` function is the most important. It must:
1. Get all staff for the tenant (or just the requested staff member)
2. For each staff member, check their `working_hours` for the given day of week
3. Generate candidate slots every 30 minutes within working hours
4. Filter out slots where a booking already exists that overlaps (query `bookings` table)
5. Filter out slots in the past
6. Return the remaining free slots as `AvailableSlot[]`

After creating `src/booking-db.ts`, update `src/db.ts`:
- Add `import { initBookingDb } from './booking-db.js';` at the top
- Add `initBookingDb(db);` at the end of the `initDatabase()` function
- Add `initBookingDb(db);` at the end of the `_initTestDatabase()` function

## Phase 5: Add Container Booking Tools

Create `container/skills/booking/booking-tools.md`. This file is available to the container agent as a skill. It teaches the agent the booking tools and how to use them via the IPC/API.

The file should explain:
1. **What tools are available**: `check_availability`, `create_booking`, `cancel_booking`, `get_my_bookings`
2. **How to call them**: via HTTP to the admin API at `http://host.docker.internal:3001/api/tools/`
3. **Response format**: JSON `{ success, message, data }`
4. **Romanian response guidelines**: always respond in Romanian, use natural conversational language

Example tool descriptions for the agent:

```markdown
## check_availability
POST http://host.docker.internal:3001/api/tools/check_availability
Body: { "tenant_id": "...", "date": "YYYY-MM-DD", "service": "Tuns", "staff_id": "..." (optional) }
Returns: list of available slots with staff names and times

## create_booking
POST http://host.docker.internal:3001/api/tools/create_booking
Body: { "tenant_id": "...", "staff_id": "...", "customer_phone": "...", "customer_name": "...", "service": "Tuns", "start_time": "2025-03-15T10:00:00" }
Returns: booking confirmation with id and details

## cancel_booking
POST http://host.docker.internal:3001/api/tools/cancel_booking
Body: { "booking_id": "...", "customer_phone": "..." }
Returns: confirmation or error if phone doesn't match

## get_my_bookings
POST http://host.docker.internal:3001/api/tools/get_my_bookings
Body: { "tenant_id": "...", "customer_phone": "..." }
Returns: list of upcoming bookings for this customer
```

Note: The HTTP endpoint at port 3001 is added by the `add-admin-panel` skill. For now, leave a TODO comment in the file noting this dependency.

## Phase 6: Create Seed Script

Create `scripts/seed-tenant.ts`. This script creates a realistic test barbershop tenant for local development.

The script must:
1. Call `initDatabase()` then `initBookingDb()`
2. Create a tenant: `{ business_name: "Frizeria Test", category: "barbershop", whatsapp_jid: "TEST_JID" }`
3. Create 2 staff members:
   - Andrei: services=[{name:"Tuns",duration_min:30,price_ron:40},{name:"Barba",duration_min:20,price_ron:30},{name:"Tuns+Barba",duration_min:45,price_ron:60}], working_hours Mon-Sat 09:00-18:00
   - Mihai: services=[{name:"Tuns",duration_min:30,price_ron:40},{name:"Vopsit",duration_min:90,price_ron:150}], working_hours Tue-Sun 10:00-19:00
4. Create 2 sample bookings for tomorrow to verify the availability logic works
5. Print a summary of what was created
6. Exit cleanly

Add to `package.json` scripts: `"seed": "tsx scripts/seed-tenant.ts"`

## Phase 7: Build and Verify

```bash
npm run build
```

Build must be clean. If there are TypeScript errors, fix them before proceeding.

Run the seed script to verify the DB works:

```bash
npm run seed
```

Expected output: tenant created, 2 staff created, 2 sample bookings created.

Verify the data in SQLite:

```bash
sqlite3 store/messages.db "SELECT business_name, category FROM tenants;"
sqlite3 store/messages.db "SELECT name FROM staff;"
sqlite3 store/messages.db "SELECT service_name, start_time, status FROM bookings;"
```

Run the test suite to make sure nothing is broken:

```bash
npm test
```

All existing tests must still pass.

## Phase 8: Per-Tenant CLAUDE.md Template

For each tenant created via the seed script or `add-tenant` skill, a `CLAUDE.md` must exist in their group folder. Create a template generator function in `scripts/seed-tenant.ts` that writes a `CLAUDE.md` to `groups/{tenant-folder}/CLAUDE.md`:

```markdown
# Booking Assistant — {business_name}

You are the booking assistant for **{business_name}**, a {category_label} in Romania.
Always respond in Romanian. Be friendly, concise, and helpful.

## Your Role
- Help customers book, cancel, or reschedule appointments via WhatsApp
- Answer questions about services, prices, and availability
- Never make up availability — always check via tools

## Staff & Services
{staff_list_with_services_and_prices}

## Working Hours
{working_hours_per_staff}

## Business Rules
{rules_list}

## FAQ
{faq_pairs}

## Tools Available
Use check_availability before suggesting slots.
Use create_booking only after the customer confirms a specific slot.
Use cancel_booking only when the customer explicitly requests cancellation.
Always confirm the booking details back to the customer after creation.

## Response Style
- Language: Romanian
- Tone: friendly, professional
- Confirmations: always repeat back: name, service, staff, date and time
- If no slots available: suggest the next available day
```

## Troubleshooting

### TypeScript errors in booking-db.ts

The `db` variable in `src/db.ts` is module-private (`let db: Database.Database`). Do NOT import it directly. Use the `initBookingDb(database)` pattern described in Phase 4.

### Seed script fails with "no such table"

The `initDatabase()` call in the seed script creates the schema. Make sure it runs before any booking-db calls.

### Build fails on booking-types.ts imports

Use `.js` extension in all imports (ESM requirement): `import { Tenant } from './booking-types.js'`
