import { randomUUID } from 'crypto';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { DAVObject } from 'tsdav';
import { getCarddavClient } from '../auth.js';
import { ok, err } from '../types.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ParsedContact {
  id: string;
  name: string;
  structuredName: string | null;
  phones: string[];
  emails: string[];
  organization: string | null;
  notes: string | null;
}

// ---------------------------------------------------------------------------
// vCard Parsing (regex-based, no extra dependency)
// ---------------------------------------------------------------------------

/** Extract a single-value field from a vCard string. */
function extractField(data: string, field: string): string | null {
  const regex = new RegExp(`^${field}:(.+)$`, 'm');
  const match = data.match(regex);
  return match ? match[1].trim() : null;
}

/** Extract all values for a multi-value field (TEL, EMAIL) from a vCard string. */
function extractMultiField(data: string, field: string): string[] {
  const regex = new RegExp(`^${field}(?:;[^:]*)?:(.+)$`, 'gm');
  const values: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = regex.exec(data)) !== null) {
    values.push(match[1].trim());
  }
  return values;
}

/** Parse a vCard string into a structured contact object. */
function parseVCard(obj: DAVObject): ParsedContact | null {
  try {
    if (!obj.data) return null;
    const data = obj.data as string;

    const uid = extractField(data, 'UID');
    const fn = extractField(data, 'FN');
    if (!uid || !fn) return null;

    const structuredName = extractField(data, 'N');
    const phones = extractMultiField(data, 'TEL');
    const emails = extractMultiField(data, 'EMAIL');
    const organization = extractField(data, 'ORG');
    const notes = extractField(data, 'NOTE');

    return {
      id: uid,
      name: fn,
      structuredName,
      phones,
      emails,
      organization,
      notes,
    };
  } catch {
    return null;
  }
}

/** Build a vCard 3.0 string from fields. */
function buildVCard(fields: {
  uid: string;
  firstName: string;
  lastName?: string;
  phone?: string;
  email?: string;
  organization?: string;
  notes?: string;
}): string {
  const fn = fields.lastName
    ? `${fields.firstName} ${fields.lastName}`
    : fields.firstName;
  const n = `${fields.lastName ?? ''};${fields.firstName};;;`;

  const lines: string[] = [
    'BEGIN:VCARD',
    'VERSION:3.0',
    `UID:${fields.uid}`,
    `FN:${fn}`,
    `N:${n}`,
  ];

  if (fields.phone) {
    lines.push(`TEL;type=CELL:${fields.phone}`);
  }

  if (fields.email) {
    lines.push(`EMAIL:${fields.email}`);
  }

  if (fields.organization) {
    lines.push(`ORG:${fields.organization}`);
  }

  if (fields.notes) {
    lines.push(`NOTE:${fields.notes}`);
  }

  lines.push('END:VCARD');
  return lines.join('\r\n');
}

/**
 * Rebuild a vCard string preserving existing fields and applying updates.
 * This keeps the original FN, N, UID and replaces/adds only the specified fields.
 */
function rebuildVCard(
  original: ParsedContact,
  updates: {
    phone?: string;
    email?: string;
    organization?: string;
    notes?: string;
  },
): string {
  const lines: string[] = [
    'BEGIN:VCARD',
    'VERSION:3.0',
    `UID:${original.id}`,
    `FN:${original.name}`,
  ];

  // N: field is required by iCloud CardDAV
  if (original.structuredName) {
    lines.push(`N:${original.structuredName}`);
  } else {
    // Derive from FN: "First Last" -> "Last;First;;;"
    const parts = original.name.split(' ');
    const last = parts.length > 1 ? parts.slice(-1)[0] : '';
    const first = parts.length > 1 ? parts.slice(0, -1).join(' ') : parts[0];
    lines.push(`N:${last};${first};;;`);
  }

  // Add phone: use updated if provided, else keep existing
  if (updates.phone) {
    lines.push(`TEL;type=CELL:${updates.phone}`);
  } else {
    for (const phone of original.phones) {
      lines.push(`TEL;type=CELL:${phone}`);
    }
  }

  // Add email: use updated if provided, else keep existing
  if (updates.email) {
    lines.push(`EMAIL:${updates.email}`);
  } else {
    for (const email of original.emails) {
      lines.push(`EMAIL:${email}`);
    }
  }

  // Organization
  const org = updates.organization ?? original.organization;
  if (org) {
    lines.push(`ORG:${org}`);
  }

  // Notes
  const note = updates.notes ?? original.notes;
  if (note) {
    lines.push(`NOTE:${note}`);
  }

  lines.push('END:VCARD');
  return lines.join('\r\n');
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Fetch all address books. */
async function getAddressBooks() {
  const client = await getCarddavClient();
  return client.fetchAddressBooks();
}

/**
 * Search all address books for a contact with the given UID.
 * Returns the raw DAVObject or null.
 */
async function findContactById(
  id: string,
): Promise<DAVObject | null> {
  const client = await getCarddavClient();
  const books = await getAddressBooks();
  for (const book of books) {
    const vcards = await client.fetchVCards({ addressBook: book });
    for (const vc of vcards) {
      const parsed = parseVCard(vc);
      if (parsed && parsed.id === id) {
        return vc;
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Handler functions
// ---------------------------------------------------------------------------

export async function handleSearch(params: { query: string }) {
  try {
    const client = await getCarddavClient();
    const books = await getAddressBooks();
    const query = params.query.toLowerCase();

    const results: Array<{
      id: string;
      name: string;
      phones: string[];
      emails: string[];
      organization: string | null;
    }> = [];

    for (const book of books) {
      const vcards = await client.fetchVCards({ addressBook: book });
      for (const vc of vcards) {
        const parsed = parseVCard(vc);
        if (!parsed) continue;

        const searchable = [
          parsed.name,
          ...parsed.phones,
          ...parsed.emails,
          parsed.organization ?? '',
        ]
          .join(' ')
          .toLowerCase();

        if (searchable.includes(query)) {
          results.push({
            id: parsed.id,
            name: parsed.name,
            phones: parsed.phones,
            emails: parsed.emails,
            organization: parsed.organization,
          });
        }
      }
    }

    return ok(results);
  } catch (e) {
    return err(`Failed to search contacts: ${e instanceof Error ? e.message : String(e)}`);
  }
}

export async function handleListGroups() {
  try {
    const client = await getCarddavClient();
    const books = await getAddressBooks();

    const results = await Promise.all(
      books.map(async (book) => {
        const vcards = await client.fetchVCards({ addressBook: book });
        return {
          name: book.displayName as string,
          memberCount: vcards.filter((vc) => parseVCard(vc) !== null).length,
        };
      }),
    );

    return ok(results);
  } catch (e) {
    return err(`Failed to list contact groups: ${e instanceof Error ? e.message : String(e)}`);
  }
}

export async function handleCreate(params: {
  first_name: string;
  last_name?: string;
  phone?: string;
  email?: string;
  organization?: string;
}) {
  try {
    const client = await getCarddavClient();
    const books = await getAddressBooks();

    if (books.length === 0) {
      return err('No address books found');
    }

    const uid = randomUUID();
    const vCardString = buildVCard({
      uid,
      firstName: params.first_name,
      lastName: params.last_name,
      phone: params.phone,
      email: params.email,
      organization: params.organization,
    });

    await client.createVCard({
      addressBook: books[0],
      vCardString,
      filename: `${uid}.vcf`,
    });

    return ok({ success: true, id: uid });
  } catch (e) {
    return err(`Failed to create contact: ${e instanceof Error ? e.message : String(e)}`);
  }
}

export async function handleUpdate(params: {
  id: string;
  phone?: string;
  email?: string;
  organization?: string;
  notes?: string;
}) {
  try {
    const contact = await findContactById(params.id);
    if (!contact) {
      return err(`Contact "${params.id}" not found`);
    }

    const parsed = parseVCard(contact)!;
    const updatedData = rebuildVCard(parsed, {
      phone: params.phone,
      email: params.email,
      organization: params.organization,
      notes: params.notes,
    });

    const client = await getCarddavClient();
    await client.updateVCard({
      vCard: {
        url: contact.url,
        etag: contact.etag,
        data: updatedData,
      },
    });

    return ok({ success: true });
  } catch (e) {
    return err(`Failed to update contact: ${e instanceof Error ? e.message : String(e)}`);
  }
}

// ---------------------------------------------------------------------------
// MCP Registration
// ---------------------------------------------------------------------------

export function registerContacts(server: McpServer): void {
  server.tool(
    'icloud_contacts_search',
    'Search iCloud contacts by name, phone, email, or organization',
    {
      query: z.string().describe('Search query (matches name, phone, email, or organization)'),
    },
    async (params) => handleSearch(params),
  );

  server.tool(
    'icloud_contacts_list_groups',
    'List all iCloud contact groups (address books) with member counts',
    {},
    async () => handleListGroups(),
  );

  server.tool(
    'icloud_contacts_create',
    'Create a new iCloud contact',
    {
      first_name: z.string().describe('First name of the contact'),
      last_name: z.string().optional().describe('Last name of the contact'),
      phone: z.string().optional().describe('Phone number'),
      email: z.string().optional().describe('Email address'),
      organization: z.string().optional().describe('Organization/company name'),
    },
    async (params) => handleCreate(params),
  );

  server.tool(
    'icloud_contacts_update',
    'Update an existing iCloud contact',
    {
      id: z.string().describe('UID of the contact to update'),
      phone: z.string().optional().describe('New phone number (replaces existing)'),
      email: z.string().optional().describe('New email address (replaces existing)'),
      organization: z.string().optional().describe('New organization/company name'),
      notes: z.string().optional().describe('Notes about the contact'),
    },
    async (params) => handleUpdate(params),
  );
}
