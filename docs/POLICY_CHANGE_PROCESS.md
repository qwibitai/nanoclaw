# Policy Change Process

Every change to the governance policy (state transitions, gate mappings, scoping rules, access levels) must follow this process.

## What Constitutes a Policy Change

- Adding/removing valid state transitions in `policy.ts`
- Modifying gate→group mappings in `gates.ts`
- Changing access level requirements for provider actions
- Adding/removing GateTypes or TaskStates
- Changing scope enforcement rules (PRODUCT vs COMPANY)
- Modifying the two-man rule or separation-of-powers checks

## Process

1. **Create a COMPANY-scoped governance task** (task_type: OPS or SECURITY)
2. **Implement the change** with corresponding tests
3. **Bump `POLICY_VERSION`** in `src/governance/policy-version.ts` (semver)
4. **All existing tests must pass** — no breaking changes without migration
5. **Submit for REVIEW** with execution summary describing the policy delta
6. **Gate APPROVAL required** (Security gate for security-related changes)
7. **Record in OS_CHANGE_LOG.md** with version, date, and description
8. **Commit** with message referencing the governance task ID

## Version Tracking

- `POLICY_VERSION` is stored in `gov_tasks.metadata.policy_version` at creation time
- `POLICY_VERSION` is stored in `ext_calls.policy_version` at call time
- This allows forensic audit: which policy was in effect when a task/call was created

## Rollback

If a policy change causes issues:

1. Revert the code change (git revert)
2. Bump `POLICY_VERSION` (patch increment)
3. Follow the same process above (task, review, approval)
4. Record the rollback in OS_CHANGE_LOG.md
