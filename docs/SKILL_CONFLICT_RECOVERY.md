# Skill Conflict Recovery

When two skills modify the same files, recover the repo deliberately instead of trying to keep both partial states.

## Typical Conflict Sources

- two channel skills both editing channel registration
- a runtime skill and a scheduler skill both editing startup
- skills that rewrite the same package scripts
- skills that both own the same environment variables

## Recovery Process

1. Identify the ownership boundary.
   Decide which skill should be authoritative for each overlapping file.
2. Restore a coherent baseline.
   Keep one version of shared files instead of splicing unrelated fragments together.
3. Reapply the second skill as an integration task.
   Treat it as a merge adaptation, not a blind replay.
4. Re-run validation.
   Use the commands both skills expect, plus `npm run typecheck` and `npm run test`.

## Files That Need Extra Care

- `package.json`
- `src/channels/index.ts`
- `src/channels/registry.ts`
- `src/lifecycle.ts`
- `.env.example`
- setup or deploy scripts

## Safe Default Strategy

- Keep core files minimal.
- Push feature-specific behavior back into the feature skill.
- If two skills both need the same abstraction, extract the abstraction first and then reapply each feature on top of it.

## When To Stop

Stop and reassess when:

- both skills redefine the runtime model
- both skills claim the same channel name
- one skill assumes container isolation and the other assumes host exec
- validation passes only when one skill's behavior is partially removed
