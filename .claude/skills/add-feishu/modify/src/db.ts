// MODIFY: src/db.ts
// Add deleteRegisteredGroup function

// === ADD EXPORT (after setRegisteredGroup) ===
export function deleteRegisteredGroup(jid: string): void {
  db.prepare('DELETE FROM registered_groups WHERE jid = ?').run(jid);
}
