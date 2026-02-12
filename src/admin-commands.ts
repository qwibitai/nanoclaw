/**
 * admin-commands.ts — Parse and execute karyakarta/area management commands.
 *
 * Dispatched from AdminService for #add-karyakarta, #remove-karyakarta,
 * #assign-area, #unassign-area, #add-area, #rename-area, #remove-area,
 * #list-karyakartas, #list-areas, and #override-reject commands.
 */
import type Database from 'better-sqlite3';

import {
  addKaryakarta,
  assignKaryakartaToArea,
  createArea,
  createValidation,
  deactivateArea,
  getArea,
  getKaryakartasForArea,
  listAreas,
  listKaryakartas,
  removeKaryakarta,
  slugify,
  unassignKaryakartaFromArea,
  updateArea,
} from './area-db.js';
import { eventBus } from './event-bus.js';
import { normalizePhone, nowISO } from './utils.js';

export interface CommandResult {
  response: string;
}

const KARYAKARTA_COMMANDS = [
  'add-karyakarta',
  'remove-karyakarta',
  'assign-area',
  'unassign-area',
  'add-area',
  'rename-area',
  'remove-area',
  'list-karyakartas',
  'list-areas',
  'override-reject',
];

export function isKaryakartaCommand(command: string): boolean {
  return KARYAKARTA_COMMANDS.includes(command);
}

export function executeAdminCommand(
  db: Database.Database,
  command: string,
  args: string,
  senderPhone: string,
): CommandResult {
  switch (command) {
    case 'add-karyakarta':
      return handleAddKaryakarta(db, args, senderPhone);
    case 'remove-karyakarta':
      return handleRemoveKaryakarta(db, args);
    case 'assign-area':
      return handleAssignArea(db, args, senderPhone);
    case 'unassign-area':
      return handleUnassignArea(db, args);
    case 'add-area':
      return handleAddArea(db, args);
    case 'rename-area':
      return handleRenameArea(db, args);
    case 'remove-area':
      return handleRemoveArea(db, args);
    case 'list-karyakartas':
      return handleListKaryakartas(db);
    case 'list-areas':
      return handleListAreas(db);
    case 'override-reject':
      return handleOverrideReject(db, args, senderPhone);
    default:
      return { response: `Unknown command: #${command}` };
  }
}

// --- Command handlers ---

function handleAddKaryakarta(
  db: Database.Database,
  args: string,
  senderPhone: string,
): CommandResult {
  const match = args.match(/^(\S+)\s+(\S+)$/);
  if (!match) {
    return { response: 'Usage: #add-karyakarta <phone> <area-slug>' };
  }

  let phone: string;
  try {
    phone = normalizePhone(match[1]);
  } catch {
    return { response: 'Usage: #add-karyakarta <phone> <area-slug>' };
  }
  const areaSlug = match[2];

  // Verify area exists
  const area = getArea(db, areaSlug);
  if (!area) {
    return { response: `Area '${areaSlug}' not found.` };
  }

  // Add karyakarta
  addKaryakarta(db, phone, senderPhone);

  // Assign to area
  const assignResult = assignKaryakartaToArea(db, phone, areaSlug, senderPhone);
  if (assignResult !== 'OK') {
    return { response: assignResult };
  }

  return {
    response: `Karyakarta ${phone} added and assigned to ${area.name}.`,
  };
}

function handleRemoveKaryakarta(
  db: Database.Database,
  args: string,
): CommandResult {
  let phone: string;
  try {
    phone = normalizePhone(args.trim());
  } catch {
    return { response: 'Usage: #remove-karyakarta <phone>' };
  }

  const result = removeKaryakarta(db, phone);
  if (result !== 'OK') {
    return { response: result };
  }

  return { response: `Karyakarta ${phone} removed.` };
}

function handleAssignArea(
  db: Database.Database,
  args: string,
  senderPhone: string,
): CommandResult {
  const match = args.match(/^(\S+)\s+(\S+)$/);
  if (!match) {
    return { response: 'Usage: #assign-area <phone> <area-slug>' };
  }

  let phone: string;
  try {
    phone = normalizePhone(match[1]);
  } catch {
    return { response: 'Usage: #assign-area <phone> <area-slug>' };
  }
  const areaSlug = match[2];

  const area = getArea(db, areaSlug);
  if (!area) {
    return { response: `Area '${areaSlug}' not found.` };
  }

  const result = assignKaryakartaToArea(db, phone, areaSlug, senderPhone);
  if (result !== 'OK') {
    return { response: result };
  }

  return { response: `Karyakarta ${phone} assigned to ${area.name}.` };
}

function handleUnassignArea(
  db: Database.Database,
  args: string,
): CommandResult {
  const match = args.match(/^(\S+)\s+(\S+)$/);
  if (!match) {
    return { response: 'Usage: #unassign-area <phone> <area-slug>' };
  }

  let phone: string;
  try {
    phone = normalizePhone(match[1]);
  } catch {
    return { response: 'Usage: #unassign-area <phone> <area-slug>' };
  }
  const areaSlug = match[2];

  unassignKaryakartaFromArea(db, phone, areaSlug);

  return { response: `Karyakarta ${phone} unassigned from ${areaSlug}.` };
}

function handleAddArea(db: Database.Database, args: string): CommandResult {
  // Format: #add-area <English Name> | <Marathi Name> | <Hindi Name>
  // Only English name is required. Pipe-separated Marathi/Hindi names enable
  // cross-script matching (Latin ↔ Devanagari) when complaints use Marathi text.
  const parts = args.split('|').map((s) => s.trim());
  const name = parts[0];
  const nameMr = parts[1] || undefined;
  const nameHi = parts[2] || nameMr; // Default Hindi to Marathi (both Devanagari)

  if (!name) {
    return {
      response:
        'Usage: #add-area <English Name> | <मराठी नाव> | <हिंदी नाम>\nExample: #add-area Shivaji Nagar | शिवाजी नगर',
    };
  }

  const slug = slugify(name);
  const existing = getArea(db, slug);
  if (existing) {
    return { response: `Area '${name}' (${slug}) already exists.` };
  }

  const created = createArea(db, { name, name_mr: nameMr, name_hi: nameHi });
  const extra = nameMr ? ` (mr: ${nameMr})` : '';
  return {
    response: `Area '${created.name}' created with slug '${slug}'.${extra}`,
  };
}

function handleRenameArea(db: Database.Database, args: string): CommandResult {
  const match = args.match(/^(\S+)\s+(.+)$/);
  if (!match) {
    return { response: 'Usage: #rename-area <old-slug> <New Name>' };
  }

  const oldSlug = match[1];
  const newName = match[2].trim();

  const result = updateArea(db, oldSlug, { name: newName });
  if (result !== 'OK') {
    return { response: result };
  }

  return { response: `Area '${oldSlug}' renamed to '${newName}'.` };
}

function handleRemoveArea(db: Database.Database, args: string): CommandResult {
  const slug = args.trim();
  if (!slug) {
    return { response: 'Usage: #remove-area <area-slug>' };
  }

  const result = deactivateArea(db, slug);
  if (result !== 'OK') {
    return { response: result };
  }

  return { response: `Area '${slug}' deactivated.` };
}

function handleListKaryakartas(db: Database.Database): CommandResult {
  const karyakartas = listKaryakartas(db, { activeOnly: true });

  if (karyakartas.length === 0) {
    return { response: 'No active karyakartas found.' };
  }

  const lines = [`\u{1F4CB} Active Karyakartas (${karyakartas.length})`, ''];

  karyakartas.forEach((k, i) => {
    lines.push(`${i + 1}. ${k.phone}`);
    if (k.areas.length > 0) {
      lines.push(`   Areas: ${k.areas.map((a) => a.name).join(', ')}`);
    } else {
      lines.push('   Areas: (none assigned)');
    }
    if (i < karyakartas.length - 1) lines.push('');
  });

  return { response: lines.join('\n') };
}

function handleListAreas(db: Database.Database): CommandResult {
  const areas = listAreas(db, { activeOnly: true });

  if (areas.length === 0) {
    return { response: 'No active areas found.' };
  }

  const lines = [`\u{1F4CB} Active Areas (${areas.length})`, ''];

  for (const area of areas) {
    const karyakartas = getKaryakartasForArea(db, area.id);
    const count = karyakartas.length;
    const suffix = count === 1 ? 'karyakarta' : 'karyakartas';
    lines.push(
      `${areas.indexOf(area) + 1}. ${area.name} (${area.id}) \u{2014} ${count} ${suffix}`,
    );
  }

  return { response: lines.join('\n') };
}

function handleOverrideReject(
  db: Database.Database,
  args: string,
  senderPhone: string,
): CommandResult {
  // Format: <ID>: <reason>  OR  <ID>
  const match = args.match(/^(\S+)(?:\s*:\s*(.+))?$/s);
  if (!match || !match[1]) {
    return { response: 'Usage: #override-reject <ID>: <reason>' };
  }

  const complaintId = match[1];
  const reason = match[2]?.trim();

  // Find complaint
  const complaint = db
    .prepare('SELECT id, status, phone FROM complaints WHERE id = ?')
    .get(complaintId) as
    | { id: string; status: string; phone: string }
    | undefined;

  if (!complaint) {
    return { response: `Complaint '${complaintId}' not found.` };
  }

  if (complaint.status !== 'rejected') {
    return {
      response: `Complaint '${complaintId}' is not in rejected status (current: ${complaint.status}).`,
    };
  }

  // Update status to validated
  const now = nowISO();
  db.prepare(
    'UPDATE complaints SET status = ?, updated_at = ? WHERE id = ?',
  ).run('validated', now, complaintId);

  // Create validation record
  createValidation(db, {
    complaint_id: complaintId,
    validated_by: senderPhone,
    action: 'admin_override',
    comment: reason,
  });

  // Emit status change event
  eventBus.emit('complaint:status-changed', {
    complaintId,
    phone: complaint.phone,
    oldStatus: 'rejected',
    newStatus: 'validated',
    note: reason,
    updatedBy: senderPhone,
  });

  return { response: `Complaint ${complaintId} overridden to validated.` };
}
