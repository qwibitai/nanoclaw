/**
 * Playground draft-mutation gate registry.
 *
 * Playground exposes three mutate endpoints (PUT files/:path, PUT
 * skills, PUT provider) where extensions may want to deny operations
 * on certain drafts — e.g. the class feature locks down student
 * drafts so they can only edit their persona.
 *
 * Gates are checked in registration order. The first gate that
 * returns `{ allow: false }` wins; its `reason` becomes the 403
 * error body. If every gate allows, the operation proceeds.
 *
 * Default install registers no gates; all mutations are allowed.
 */

export type DraftMutationAction = 'file_put' | 'skills_put' | 'provider_put';

export interface DraftMutationDecision {
  allow: boolean;
  reason?: string;
}

/**
 * Context passed to each gate. `draftFolder` and `action` are always
 * present. `userId` is the user who authed the playground session
 * (set by playground.ts at magic-link consumption time); gates use it
 * to make role-aware decisions — e.g. the class lockdown lets
 * scoped-admin users (TAs, instructors) bypass restrictions that
 * apply to plain members (students). Optional so legacy gates
 * written before the field existed still type-check.
 */
export interface DraftMutationContext {
  draftFolder: string;
  action: DraftMutationAction;
  userId?: string | null;
}

export type DraftMutationGate = (ctx: DraftMutationContext) => DraftMutationDecision;

const gates: DraftMutationGate[] = [];

/**
 * Append a gate to the chain. Gates run in registration order; first
 * deny wins. Multiple gates can stack — a future "rate-limit gate"
 * could coexist with the class lockdown without either knowing about
 * the other.
 */
export function registerDraftMutationGate(gate: DraftMutationGate): void {
  gates.push(gate);
}

/**
 * Walk the gate chain, return the first denial or `{ allow: true }`
 * when every gate passed. Pure-ish: depends only on what the gates
 * read (typically class-config + the draft folder name + the
 * authenticated user_id when role-aware decisions are needed).
 *
 * Two call shapes for backward compatibility:
 *   checkDraftMutation(draftFolder, action)
 *   checkDraftMutation(draftFolder, action, userId)
 *   checkDraftMutation(ctx)  // future explicit-context callers
 */
export function checkDraftMutation(
  draftFolderOrCtx: string | DraftMutationContext,
  action?: DraftMutationAction,
  userId?: string | null,
): DraftMutationDecision {
  const ctx: DraftMutationContext =
    typeof draftFolderOrCtx === 'string'
      ? { draftFolder: draftFolderOrCtx, action: action!, userId: userId ?? null }
      : draftFolderOrCtx;
  for (const gate of gates) {
    const decision = gate(ctx);
    if (!decision.allow) return decision;
  }
  return { allow: true };
}

/** Test hook — clear the gate chain. */
export function _resetGatesForTest(): void {
  gates.length = 0;
}
