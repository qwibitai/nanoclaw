// Ported from Mission Control — gate enforcement rules
// Pure TypeScript, zero NanoClaw dependencies

export type GateType = 'Security' | 'RevOps' | 'Claims' | 'Product';

/**
 * Maps gate type to the NanoClaw group folder authorized to approve it.
 * v0: only Security is a separate group. Others delegated to main (Coordinator).
 */
export const GATE_APPROVER: Record<GateType, string> = {
  Security: 'security',
  RevOps: 'main', // v1: separate revops group
  Claims: 'main', // v1: separate research group
  Product: 'main', // v1: separate qa group
};

/**
 * Check that the actor's group folder matches the required approver for the gate.
 * Returns an error message if unauthorized, null if ok.
 */
export function checkApprover(
  gate: GateType,
  actorGroup: string,
  isMain: boolean,
): string | null {
  // Main group can approve any gate (Founder privilege)
  if (isMain) return null;

  const expected = GATE_APPROVER[gate];
  if (actorGroup !== expected) {
    return `FORBIDDEN: group '${actorGroup}' cannot approve '${gate}'. Expected '${expected}'.`;
  }
  return null;
}

/**
 * Check that the approver group is not the same as the task executor group.
 * Returns an error message if conflict, null if ok.
 */
export function checkApproverNotExecutor(
  approverGroup: string,
  executorGroup: string | null,
): string | null {
  if (executorGroup && approverGroup === executorGroup) {
    return `FORBIDDEN: approver '${approverGroup}' cannot be the executor of the task.`;
  }
  return null;
}
