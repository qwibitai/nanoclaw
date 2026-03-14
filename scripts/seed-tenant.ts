/**
 * Seed script: creates a test barbershop tenant for local development.
 * Usage: npm run seed
 */
import { randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';

import { initDatabase } from '../src/db.js';
import {
  createBooking,
  createStaffMember,
  createTenant,
  getStaffByTenant,
  getTenantByJid,
} from '../src/booking-db.js';
import { Booking, StaffMember, Tenant } from '../src/booking-types.js';

// --- Init DB ---
initDatabase();

const TEST_JID = 'TEST_JID@s.whatsapp.net';

// --- Check if already seeded ---
const existing = getTenantByJid(TEST_JID);
if (existing) {
  console.log(`Tenant already exists: ${existing.business_name} (${existing.id})`);
  console.log('To re-seed, delete store/messages.db and run again.');
  process.exit(0);
}

// --- Create tenant ---
const tenantId = randomUUID();
const tenant: Tenant = {
  id: tenantId,
  whatsapp_jid: TEST_JID,
  business_name: 'Frizeria Test',
  category: 'barbershop',
  config: {
    language: 'ro',
    welcome_message: 'Bună! Sunt asistentul virtual al Frizeiei Test. Cu ce te pot ajuta?',
    rules: [
      'Ultima programare se poate face cu 30 de minute înainte de închidere.',
      'Programările se pot anula cu cel puțin 2 ore înainte.',
    ],
    faq: {
      parcare: 'Există parcare gratuită în fața salonului.',
      plata: 'Acceptăm cash și card.',
      adresa: 'Strada Exemplu nr. 1, București.',
    },
  },
  active: true,
  created_at: new Date().toISOString(),
};

createTenant(tenant);
console.log(`✅ Tenant created: ${tenant.business_name} (${tenant.id})`);

// --- Create staff ---
const andreiId = randomUUID();
const andrei: StaffMember = {
  id: andreiId,
  tenant_id: tenantId,
  name: 'Andrei',
  services: [
    { name: 'Tuns', duration_min: 30, price_ron: 40 },
    { name: 'Barba', duration_min: 20, price_ron: 30 },
    { name: 'Tuns + Barba', duration_min: 45, price_ron: 60 },
  ],
  working_hours: [
    { day: 'mon', open: '09:00', close: '18:00' },
    { day: 'tue', open: '09:00', close: '18:00' },
    { day: 'wed', open: '09:00', close: '18:00' },
    { day: 'thu', open: '09:00', close: '18:00' },
    { day: 'fri', open: '09:00', close: '18:00' },
    { day: 'sat', open: '09:00', close: '15:00' },
  ],
  active: true,
};
createStaffMember(andrei);
console.log(`✅ Staff created: ${andrei.name} (${andrei.id})`);

const mihaiId = randomUUID();
const mihai: StaffMember = {
  id: mihaiId,
  tenant_id: tenantId,
  name: 'Mihai',
  services: [
    { name: 'Tuns', duration_min: 30, price_ron: 40 },
    { name: 'Vopsit', duration_min: 90, price_ron: 150 },
  ],
  working_hours: [
    { day: 'tue', open: '10:00', close: '19:00' },
    { day: 'wed', open: '10:00', close: '19:00' },
    { day: 'thu', open: '10:00', close: '19:00' },
    { day: 'fri', open: '10:00', close: '19:00' },
    { day: 'sat', open: '10:00', close: '17:00' },
    { day: 'sun', open: '10:00', close: '15:00' },
  ],
  active: true,
};
createStaffMember(mihai);
console.log(`✅ Staff created: ${mihai.name} (${mihai.id})`);

// --- Create sample bookings for tomorrow ---
const tomorrow = new Date();
tomorrow.setDate(tomorrow.getDate() + 1);
const tomorrowStr = tomorrow.toISOString().split('T')[0];

const booking1: Booking = {
  id: randomUUID(),
  tenant_id: tenantId,
  staff_id: andreiId,
  customer_phone: '40712000001',
  customer_name: 'Ion Popescu',
  service_name: 'Tuns',
  service_duration_min: 30,
  start_time: `${tomorrowStr}T10:00:00`,
  end_time: `${tomorrowStr}T10:30:00`,
  status: 'confirmed',
  created_at: new Date().toISOString(),
};
createBooking(booking1);
console.log(`✅ Booking created: ${booking1.customer_name} @ ${booking1.start_time}`);

const booking2: Booking = {
  id: randomUUID(),
  tenant_id: tenantId,
  staff_id: andreiId,
  customer_phone: '40712000002',
  customer_name: 'Maria Ionescu',
  service_name: 'Tuns + Barba',
  service_duration_min: 45,
  start_time: `${tomorrowStr}T11:00:00`,
  end_time: `${tomorrowStr}T11:45:00`,
  status: 'confirmed',
  created_at: new Date().toISOString(),
};
createBooking(booking2);
console.log(`✅ Booking created: ${booking2.customer_name} @ ${booking2.start_time}`);

// --- Generate per-tenant CLAUDE.md ---
generateTenantClaudeMd(tenant, [andrei, mihai]);

console.log('\n📊 Summary:');
console.log(`  Tenant: ${tenant.business_name}`);
console.log(`  Staff: ${getStaffByTenant(tenantId).map(s => s.name).join(', ')}`);
console.log(`  Sample bookings: 2 (tomorrow: ${tomorrowStr})`);
console.log(`  CLAUDE.md: groups/frizeria_test/CLAUDE.md`);
console.log('\nDone! ✅');

// --- CLAUDE.md generator ---
function generateTenantClaudeMd(t: Tenant, staffList: StaffMember[]): void {
  const categoryLabel: Record<string, string> = {
    barbershop: 'frizerie/barber shop',
    nail_salon: 'salon de unghii',
    gym_pt: 'sală de fitness / antrenor personal',
    other: 'afacere',
  };

  const staffLines = staffList.map(s => {
    const services = s.services.map(sv => `  - ${sv.name}: ${sv.duration_min} min, ${sv.price_ron} RON`).join('\n');
    const hours = s.working_hours.map(h => `  - ${h.day}: ${h.open}–${h.close}`).join('\n');
    return `### ${s.name}\n**Servicii:**\n${services}\n**Program:**\n${hours}`;
  }).join('\n\n');

  const rules = (t.config.rules ?? []).map(r => `- ${r}`).join('\n') || '- Nicio regulă specifică.';

  const faq = Object.entries(t.config.faq ?? {})
    .map(([k, v]) => `**${k}:** ${v}`)
    .join('\n') || 'Niciun FAQ disponibil.';

  const content = `# Asistent Programări — ${t.business_name}

Ești asistentul virtual pentru **${t.business_name}**, o ${categoryLabel[t.category] ?? 'afacere'} din România.
Răspunde întotdeauna în română. Fii prietenos, concis și util.

## Rolul Tău
- Ajuți clienții să facă, anuleze sau reprogrameze programări prin WhatsApp
- Răspunzi la întrebări despre servicii, prețuri și disponibilitate
- **Nu inventa disponibilitate** — verifică întotdeauna prin tools

## Personal & Servicii

${staffLines}

## Reguli
${rules}

## Întrebări Frecvente
${faq}

## Tools Disponibile
- Folosește \`check_availability\` înainte de a sugera ore
- Folosește \`create_booking\` doar după ce clientul confirmă explicit un slot
- Folosește \`cancel_booking\` doar când clientul solicită explicit anularea
- Confirmă întotdeauna detaliile programării după creare

## Stil de Răspuns
- Limbă: română
- Ton: prietenos, profesional
- Confirmări: repetă întotdeauna: nume, serviciu, frizier, dată și oră
- Dacă nu sunt locuri: sugerează următoarea zi disponibilă
- Mesaje scurte — utilizatorii WhatsApp nu citesc texte lungi
`;

  const folder = `frizeria_test`;
  const dir = path.join(process.cwd(), 'groups', folder);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'CLAUDE.md'), content);
  console.log(`✅ CLAUDE.md written: groups/${folder}/CLAUDE.md`);
}
