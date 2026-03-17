---
name: add-booking-api
description: Create the NestJS + PostgreSQL booking API service in claws/booking-api/. This is Phase 2 of the WhatsApp booking bot — the HTTP service that container agents call to check availability and manage bookings.
---

# Add Booking API (Phase 2)

This skill creates `claws/booking-api/` — a standalone NestJS service backed by PostgreSQL.
Container agents call it via HTTP on port 3001.
The nanoclaw SQLite DB is NOT used for booking data after this phase.

## Pre-flight

Check that Phase 1 (booking engine) is already applied:

```bash
test -f ../nanoclaw/src/booking-db.ts && echo "Phase 1 done — proceeding" || echo "ERROR: run add-booking-engine first"
```

Check that the booking-api project does not already exist:

```bash
test -d ../../booking-api && echo "ALREADY EXISTS — skill may already be applied" || echo "Clean — proceeding"
```

Check Docker is available (needed for PostgreSQL):

```bash
docker --version && docker compose version
```

Working directory for this skill: `claws/` (parent of `nanoclaw/`).
All paths below are relative to `claws/`.

---

## Phase 1: Scaffold NestJS Project

```bash
cd /home/florin/WebstormProjects/claws
npx @nestjs/cli new booking-api --package-manager npm --skip-git --strict
cd booking-api
```

Install required dependencies:

```bash
npm install @prisma/client prisma
npm install class-validator class-transformer
npm install @nestjs/config
npm install -D @types/node
npx prisma init
```

---

## Phase 2: Docker Compose for PostgreSQL

Create `booking-api/docker-compose.yml`:

```yaml
services:
  postgres:
    image: postgres:16-alpine
    restart: unless-stopped
    environment:
      POSTGRES_DB: bookingbot
      POSTGRES_USER: bookingbot
      POSTGRES_PASSWORD: bookingbot_dev
    ports:
      - "5432:5432"
    volumes:
      - postgres_data:/var/lib/postgresql/data

volumes:
  postgres_data:
```

Create `booking-api/.env`:

```
DATABASE_URL="postgresql://bookingbot:bookingbot_dev@localhost:5432/bookingbot"
PORT=3001
API_KEY=dev_secret_change_in_prod
```

Create `booking-api/.env.example`:

```
DATABASE_URL="postgresql://user:password@localhost:5432/bookingbot"
PORT=3001
API_KEY=your_secret_api_key_here
```

---

## Phase 3: Prisma Schema

Replace `booking-api/prisma/schema.prisma` with:

```prisma
generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

model Tenant {
  id            String    @id @default(uuid())
  whatsappJid   String    @unique @map("whatsapp_jid")
  businessName  String    @map("business_name")
  category      String    @default("other")
  config        Json      @default("{}")
  active        Boolean   @default(true)
  createdAt     DateTime  @default(now()) @map("created_at")

  staff         StaffMember[]
  bookings      Booking[]
  customers     Customer[]

  @@map("tenants")
}

model StaffMember {
  id           String    @id @default(uuid())
  tenantId     String    @map("tenant_id")
  name         String
  services     Json      @default("[]")
  workingHours Json      @default("[]") @map("working_hours")
  active       Boolean   @default(true)

  tenant       Tenant    @relation(fields: [tenantId], references: [id])
  bookings     Booking[]

  @@index([tenantId])
  @@map("staff")
}

model Booking {
  id                  String    @id @default(uuid())
  tenantId            String    @map("tenant_id")
  staffId             String    @map("staff_id")
  customerPhone       String    @map("customer_phone")
  customerName        String    @map("customer_name")
  serviceName         String    @map("service_name")
  serviceDurationMin  Int       @map("service_duration_min")
  startTime           DateTime  @map("start_time")
  endTime             DateTime  @map("end_time")
  status              String    @default("confirmed")
  notes               String?
  createdAt           DateTime  @default(now()) @map("created_at")

  tenant  Tenant      @relation(fields: [tenantId], references: [id])
  staff   StaffMember @relation(fields: [staffId], references: [id])

  @@index([tenantId])
  @@index([staffId, startTime])
  @@index([customerPhone, tenantId])
  @@map("bookings")
}

model Customer {
  id            String    @id @default(uuid())
  tenantId      String    @map("tenant_id")
  phone         String
  name          String
  lastBookingAt DateTime? @map("last_booking_at")

  tenant        Tenant    @relation(fields: [tenantId], references: [id])

  @@unique([tenantId, phone])
  @@index([tenantId, phone])
  @@map("customers")
}
```

Run migration:

```bash
npx prisma migrate dev --name init
npx prisma generate
```

---

## Phase 4: NestJS Modules Structure

Create the following module structure. Each entity gets its own folder.

### `src/prisma/prisma.service.ts`

```typescript
import { Injectable, OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit {
  async onModuleInit() {
    await this.$connect();
  }
}
```

### `src/prisma/prisma.module.ts`

```typescript
import { Global, Module } from '@nestjs/common';
import { PrismaService } from './prisma.service';

@Global()
@Module({
  providers: [PrismaService],
  exports: [PrismaService],
})
export class PrismaModule {}
```

### Tools module — `src/tools/tools.controller.ts`

This is the most important module. Containers call these endpoints.

```typescript
import { Controller, Post, Body, Headers, UnauthorizedException } from '@nestjs/common';
import { ToolsService } from './tools.service';
import { ConfigService } from '@nestjs/config';

@Controller('api/tools')
export class ToolsController {
  constructor(
    private readonly toolsService: ToolsService,
    private readonly config: ConfigService,
  ) {}

  private checkApiKey(apiKey: string) {
    if (apiKey !== this.config.get('API_KEY')) {
      throw new UnauthorizedException('Invalid API key');
    }
  }

  @Post('check_availability')
  checkAvailability(
    @Headers('x-api-key') apiKey: string,
    @Body() body: { tenant_id: string; date: string; service: string; staff_id?: string },
  ) {
    this.checkApiKey(apiKey);
    return this.toolsService.checkAvailability(body);
  }

  @Post('create_booking')
  createBooking(
    @Headers('x-api-key') apiKey: string,
    @Body() body: {
      tenant_id: string;
      staff_id: string;
      customer_phone: string;
      customer_name: string;
      service: string;
      start_time: string;
    },
  ) {
    this.checkApiKey(apiKey);
    return this.toolsService.createBooking(body);
  }

  @Post('cancel_booking')
  cancelBooking(
    @Headers('x-api-key') apiKey: string,
    @Body() body: { booking_id: string; customer_phone: string },
  ) {
    this.checkApiKey(apiKey);
    return this.toolsService.cancelBooking(body);
  }

  @Post('get_my_bookings')
  getMyBookings(
    @Headers('x-api-key') apiKey: string,
    @Body() body: { tenant_id: string; customer_phone: string },
  ) {
    this.checkApiKey(apiKey);
    return this.toolsService.getMyBookings(body);
  }
}
```

### `src/tools/tools.service.ts`

Implement each method:

- `checkAvailability`: fetch staff for tenant, get their working hours for the requested date's day-of-week, generate 30-min slots, query bookings table for overlaps, return free slots. Port logic from `nanoclaw/src/booking-db.ts` → `getAvailableSlots`.
- `createBooking`: validate slot is still free, insert booking, upsert customer, return confirmation.
- `cancelBooking`: find booking by id, verify `customer_phone` matches, set `status = 'cancelled'`.
- `getMyBookings`: query bookings where `customerPhone = phone AND tenantId = tenantId AND startTime > now()`, ordered by start_time.

All methods return `{ success: boolean, message: string, data?: unknown }`.

---

## Phase 5: App Module

Update `src/app.module.ts`:

```typescript
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from './prisma/prisma.module';
import { ToolsModule } from './tools/tools.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    PrismaModule,
    ToolsModule,
  ],
})
export class AppModule {}
```

Update `src/main.ts`:

```typescript
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  const port = process.env.PORT ?? 3001;
  await app.listen(port);
  console.log(`Booking API running on port ${port}`);
}
bootstrap();
```

---

## Phase 6: Prisma Seed

Create `prisma/seed.ts` — port the test data from `nanoclaw/scripts/seed-tenant.ts`:

```typescript
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  // Create Frizeria Test tenant
  const tenant = await prisma.tenant.upsert({
    where: { whatsappJid: 'TEST_JID' },
    update: {},
    create: {
      whatsappJid: 'TEST_JID',
      businessName: 'Frizeria Test',
      category: 'barbershop',
      config: {
        language: 'ro',
        welcome_message: 'Bună ziua! Cu ce vă pot ajuta?',
      },
    },
  });

  // Create Andrei
  await prisma.staffMember.upsert({
    where: { id: 'andrei-test-id' },
    update: {},
    create: {
      id: 'andrei-test-id',
      tenantId: tenant.id,
      name: 'Andrei',
      services: [
        { name: 'Tuns', duration_min: 30, price_ron: 40 },
        { name: 'Barba', duration_min: 20, price_ron: 30 },
        { name: 'Tuns + Barba', duration_min: 45, price_ron: 60 },
      ],
      workingHours: [
        { day: 'mon', open: '09:00', close: '18:00' },
        { day: 'tue', open: '09:00', close: '18:00' },
        { day: 'wed', open: '09:00', close: '18:00' },
        { day: 'thu', open: '09:00', close: '18:00' },
        { day: 'fri', open: '09:00', close: '18:00' },
        { day: 'sat', open: '09:00', close: '18:00' },
      ],
    },
  });

  // Create Mihai (similar pattern, Tue-Sun, 10-19)
  console.log('Seed complete — Frizeria Test with Andrei and Mihai');
}

main().catch(console.error).finally(() => prisma.$disconnect());
```

Add to `package.json`:
```json
"prisma": { "seed": "ts-node prisma/seed.ts" }
```

Run: `npx prisma db seed`

---

## Phase 7: Update nanoclaw to inject tenant_id

In `nanoclaw/src/container-runner.ts`, when building container env vars, look up the tenant by JID and inject `TENANT_ID`:

```typescript
// In the env block passed to the container:
TENANT_ID: getTenantByJid(groupJid)?.id ?? '',
BOOKING_API_URL: 'http://host.docker.internal:3001',
BOOKING_API_KEY: process.env.BOOKING_API_KEY ?? '',
```

Add `BOOKING_API_KEY` to nanoclaw `.env` (same value as `booking-api/.env` `API_KEY`).

---

## Phase 8: Update booking-tools.md

Update `nanoclaw/container/skills/booking/booking-tools.md`:
- Remove the TODO note about `add-admin-panel`
- Add header auth: `x-api-key: {BOOKING_API_KEY}` to all requests
- Note that `tenant_id` comes from the `TENANT_ID` env var injected by nanoclaw

---

## Phase 9: Verify End-to-End

```bash
# Start PostgreSQL
cd claws/booking-api && docker compose up -d

# Run migrations and seed
npx prisma migrate dev
npx prisma db seed

# Start API
npm run start:dev

# From another terminal — test tool endpoints
curl -X POST http://localhost:3001/api/tools/check_availability \
  -H "Content-Type: application/json" \
  -H "x-api-key: dev_secret_change_in_prod" \
  -d '{"tenant_id":"...","date":"2026-03-20","service":"Tuns"}'
```

Expected: `{ "success": true, "message": "...", "data": [...slots] }`

Then restart nanoclaw, send a booking request via WhatsApp, verify the booking lands in PostgreSQL.

---

## Troubleshooting

### Prisma can't connect
Make sure PostgreSQL is running: `docker compose ps`. Check `DATABASE_URL` in `.env`.

### Container can't reach :3001
The container uses `host.docker.internal` to reach the host. On Linux this may need:
```yaml
# in nanoclaw's docker run / container config
extra_hosts:
  - "host.docker.internal:host-gateway"
```
Or set `BOOKING_API_URL=http://172.17.0.1:3001` (Docker bridge IP).

### TypeScript errors in tools.service.ts
The working hours logic (day-of-week, slot generation) can be ported directly from
`nanoclaw/src/booking-db.ts` → `getAvailableSlots`. Same algorithm, just replace
better-sqlite3 queries with Prisma calls.
