#!/usr/bin/env npx tsx
/**
 * Google Maps Lead Finder for NanoClaw
 *
 * Uses Google Places API (New) Text Search to find businesses by category and location.
 *
 * Usage:
 *   npx tsx tools/leads/google-maps.ts search --query "convenience stores Houston TX" [--limit 60] [--import] [--tags "maps,houston"]
 *   npx tsx tools/leads/google-maps.ts enrich --contact-id <id>
 *
 * Environment variables:
 *   GOOGLE_MAPS_API_KEY — API key with Places API enabled
 */

import Database from 'better-sqlite3';
import { getDbPath } from '../shared/db-path.js';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

const API_KEY = process.env.GOOGLE_MAPS_API_KEY;

interface PlaceResult {
  name: string;
  formattedAddress: string;
  phone?: string;
  website?: string;
  rating?: number;
  userRatingCount?: number;
  placeId: string;
  types: string[];
  location?: { lat: number; lng: number };
}

interface Args {
  action: string;
  query?: string;
  limit: number;
  import: boolean;
  tags?: string;
  contactId?: string;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const action = argv[0];

  if (!['search', 'enrich'].includes(action)) {
    console.error(JSON.stringify({
      status: 'error',
      error: `Unknown action "${action}". Use: search, enrich`,
      usage: [
        'npx tsx tools/leads/google-maps.ts search --query "convenience stores Houston TX" [--limit 60] [--import] [--tags "maps,houston"]',
        'npx tsx tools/leads/google-maps.ts enrich --contact-id <id>',
      ],
    }));
    process.exit(1);
  }

  const flags: Record<string, string> = {};
  const boolFlags = new Set<string>();
  for (let i = 1; i < argv.length; i++) {
    if (argv[i] === '--import') {
      boolFlags.add('import');
    } else if (argv[i].startsWith('--') && i + 1 < argv.length) {
      flags[argv[i].slice(2)] = argv[++i];
    }
  }

  return {
    action,
    query: flags.query,
    limit: parseInt(flags.limit || '60', 10),
    import: boolFlags.has('import'),
    tags: flags.tags,
    contactId: flags['contact-id'],
  };
}

function getDb(): Database.Database {
  const dbPath = getDbPath();
  if (!fs.existsSync(dbPath)) {
    console.error(JSON.stringify({ status: 'error', error: 'Database not found. Run NanoClaw first.' }));
    process.exit(1);
  }
  return new Database(dbPath);
}

function inferIndustry(types: string[]): string | null {
  const typeMap: Record<string, string> = {
    convenience_store: 'retail',
    store: 'retail',
    shopping_mall: 'retail',
    supermarket: 'retail',
    gym: 'fitness',
    health: 'healthcare',
    hospital: 'healthcare',
    doctor: 'healthcare',
    dentist: 'healthcare',
    school: 'education',
    university: 'education',
    lodging: 'hospitality',
    hotel: 'hospitality',
    restaurant: 'food_service',
    cafe: 'food_service',
    car_dealer: 'automotive',
    car_repair: 'automotive',
    trucking_company: 'logistics',
    moving_company: 'logistics',
    storage: 'logistics',
    apartment_building: 'residential',
    apartment_complex: 'residential',
    warehouse: 'manufacturing',
    factory: 'manufacturing',
    office: 'office',
    real_estate_agency: 'office',
    bank: 'finance',
    church: 'religious',
    place_of_worship: 'religious',
  };

  for (const t of types) {
    const normalized = t.toLowerCase().replace(/\s+/g, '_');
    if (typeMap[normalized]) return typeMap[normalized];
  }
  return null;
}

function parseAddressParts(address: string): { city: string | null; state: string | null } {
  // Typical format: "123 Main St, Houston, TX 77001, USA"
  const parts = address.split(',').map((p) => p.trim());
  if (parts.length >= 3) {
    const city = parts[parts.length - 3] || null;
    const stateZip = parts[parts.length - 2] || '';
    const state = stateZip.split(/\s+/)[0] || null;
    return { city, state };
  }
  return { city: null, state: null };
}

async function searchPlaces(query: string, limit: number): Promise<PlaceResult[]> {
  const results: PlaceResult[] = [];
  let pageToken: string | undefined;

  while (results.length < limit) {
    const body: Record<string, unknown> = {
      textQuery: query,
      pageSize: Math.min(20, limit - results.length),
    };
    if (pageToken) {
      body.pageToken = pageToken;
    }

    const res = await fetch('https://places.googleapis.com/v1/places:searchText', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': API_KEY!,
        'X-Goog-FieldMask': 'places.displayName,places.formattedAddress,places.nationalPhoneNumber,places.internationalPhoneNumber,places.websiteUri,places.rating,places.userRatingCount,places.id,places.types,places.location,nextPageToken',
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Places API error ${res.status}: ${errText}`);
    }

    const data = await res.json() as {
      places?: Array<{
        displayName?: { text: string };
        formattedAddress?: string;
        nationalPhoneNumber?: string;
        internationalPhoneNumber?: string;
        websiteUri?: string;
        rating?: number;
        userRatingCount?: number;
        id?: string;
        types?: string[];
        location?: { latitude: number; longitude: number };
      }>;
      nextPageToken?: string;
    };

    for (const p of data.places || []) {
      results.push({
        name: p.displayName?.text || '',
        formattedAddress: p.formattedAddress || '',
        phone: p.nationalPhoneNumber || p.internationalPhoneNumber || undefined,
        website: p.websiteUri || undefined,
        rating: p.rating,
        userRatingCount: p.userRatingCount,
        placeId: p.id || '',
        types: p.types || [],
        location: p.location ? { lat: p.location.latitude, lng: p.location.longitude } : undefined,
      });
    }

    pageToken = data.nextPageToken;
    if (!pageToken) break;
  }

  return results.slice(0, limit);
}

function importToDb(places: PlaceResult[], tags: string | null): { imported: number; skipped: number } {
  const db = getDb();
  const now = new Date().toISOString();
  const tagList = tags ? JSON.stringify(tags.split(',').map((t) => t.trim())) : null;

  const stmt = db.prepare(
    `INSERT INTO contacts (id, email, first_name, last_name, company, title, phone, source, tags, notes, website, address, city, state, google_place_id, industry, created_at, updated_at)
     VALUES (?, ?, ?, '', ?, NULL, ?, 'google_maps', ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(email) DO UPDATE SET
       company = COALESCE(excluded.company, company),
       phone = COALESCE(excluded.phone, phone),
       website = COALESCE(excluded.website, website),
       address = COALESCE(excluded.address, address),
       city = COALESCE(excluded.city, city),
       state = COALESCE(excluded.state, state),
       google_place_id = COALESCE(excluded.google_place_id, google_place_id),
       industry = COALESCE(excluded.industry, industry),
       tags = COALESCE(excluded.tags, tags),
       updated_at = excluded.updated_at`,
  );

  // Also try to insert by place_id (dedup)
  const checkPlaceId = db.prepare(
    `SELECT id FROM contacts WHERE google_place_id = ?`,
  );

  let imported = 0;
  let skipped = 0;

  const insertMany = db.transaction((places: PlaceResult[]) => {
    for (const place of places) {
      // Skip if we already have this place
      if (place.placeId) {
        const existing = checkPlaceId.get(place.placeId);
        if (existing) {
          skipped++;
          continue;
        }
      }

      const id = crypto.randomUUID();
      const { city, state } = parseAddressParts(place.formattedAddress);
      const industry = inferIndustry(place.types);

      // Generate placeholder email from place ID or business name
      const emailBase = place.placeId || place.name.toLowerCase().replace(/[^a-z0-9]/g, '-');
      const email = `${emailBase}@maps.nanoclaw`;

      stmt.run(
        id,
        email,
        'Manager', // placeholder first_name
        place.name, // company
        place.phone || null,
        tagList,
        place.website || null,
        place.formattedAddress,
        city,
        state,
        place.placeId || null,
        industry,
        now,
        now,
      );
      imported++;
    }
  });

  insertMany(places);
  db.close();

  return { imported, skipped };
}

async function enrichContact(contactId: string) {
  const db = getDb();
  const contact = db.prepare('SELECT * FROM contacts WHERE id = ?').get(contactId) as Record<string, unknown> | undefined;

  if (!contact) {
    db.close();
    console.error(JSON.stringify({ status: 'error', error: `Contact ${contactId} not found` }));
    process.exit(1);
  }

  const query = `${contact.company || ''} ${contact.address || contact.city || ''}`.trim();
  if (!query) {
    db.close();
    console.error(JSON.stringify({ status: 'error', error: 'Contact has no company or address to search' }));
    process.exit(1);
  }

  const places = await searchPlaces(query, 1);
  if (places.length === 0) {
    db.close();
    console.log(JSON.stringify({ status: 'success', enriched: false, message: 'No matching place found' }));
    return;
  }

  const place = places[0];
  const { city, state } = parseAddressParts(place.formattedAddress);
  const industry = inferIndustry(place.types);
  const now = new Date().toISOString();

  db.prepare(
    `UPDATE contacts SET
       phone = COALESCE(?, phone),
       website = COALESCE(?, website),
       address = COALESCE(?, address),
       city = COALESCE(?, city),
       state = COALESCE(?, state),
       google_place_id = COALESCE(?, google_place_id),
       industry = COALESCE(?, industry),
       updated_at = ?
     WHERE id = ?`,
  ).run(
    place.phone || null,
    place.website || null,
    place.formattedAddress,
    city,
    state,
    place.placeId || null,
    industry,
    now,
    contactId,
  );

  db.close();

  console.log(JSON.stringify({
    status: 'success',
    enriched: true,
    contact_id: contactId,
    place: {
      name: place.name,
      phone: place.phone,
      website: place.website,
      address: place.formattedAddress,
      rating: place.rating,
      reviewCount: place.userRatingCount,
      industry,
    },
  }));
}

async function main() {
  if (!API_KEY) {
    console.error(JSON.stringify({
      status: 'error',
      error: 'Missing GOOGLE_MAPS_API_KEY environment variable. Enable Places API in Google Cloud Console and generate an API key.',
    }));
    process.exit(1);
  }

  const args = parseArgs();

  try {
    switch (args.action) {
      case 'search': {
        if (!args.query) {
          console.error(JSON.stringify({ status: 'error', error: 'search requires --query' }));
          process.exit(1);
        }

        const places = await searchPlaces(args.query, args.limit);

        if (args.import) {
          const result = importToDb(places, args.tags || null);
          console.log(JSON.stringify({
            status: 'success',
            action: 'search+import',
            query: args.query,
            found: places.length,
            imported: result.imported,
            skipped: result.skipped,
            tags: args.tags || null,
          }));
        } else {
          console.log(JSON.stringify({
            status: 'success',
            action: 'search',
            query: args.query,
            count: places.length,
            places: places.map((p) => ({
              name: p.name,
              address: p.formattedAddress,
              phone: p.phone,
              website: p.website,
              rating: p.rating,
              reviews: p.userRatingCount,
              placeId: p.placeId,
              types: p.types.slice(0, 5),
            })),
          }));
        }
        break;
      }

      case 'enrich': {
        if (!args.contactId) {
          console.error(JSON.stringify({ status: 'error', error: 'enrich requires --contact-id' }));
          process.exit(1);
        }
        await enrichContact(args.contactId);
        break;
      }
    }
  } catch (err) {
    console.error(JSON.stringify({
      status: 'error',
      error: err instanceof Error ? err.message : String(err),
    }));
    process.exit(1);
  }
}

main();
