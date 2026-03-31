# scaffold_project: Automated Project Lifecycle via IPC

**Date:** 2026-03-31
**Status:** Design
**Scope:** New `scaffold_project` IPC action + revised `idea-triage` container skill

## Problem

Upgrading an idea to a full project requires host-level operations (GitHub repo creation, git clone into `~/projects/`, Discord channel creation) that containers cannot perform. Today this requires an SSH session with Claude Code. The container `idea-triage` skill's upgrade path was aspirational — it called `gh` directly, which doesn't exist in the container and wouldn't have write access to `~/projects/` anyway.

## Design Principles

1. **Preserve the security model.** Containers never get write access to `~/projects/` root or the NanoClaw codebase. All privileged operations go through validated IPC.
2. **One IPC action, not many.** A single `scaffold_project` action handles the full host-side lifecycle. The host manages sequencing and partial-failure recovery. This avoids the container orchestrating rollback across multiple IPC round-trips and keeps the IPC vocabulary small.
3. **Container does what it can.** Obsidian vault operations (PROJECT.md, ORIGIN.md, writing rubric, `_registry.md`) happen in the container, which already has vault access. The IPC request only covers what the container *cannot* do.
4. **Idempotent.** Re-running `scaffold_project` with the same name is safe. Each step checks whether its work is already done before acting.

## Host Side: `scaffold_project` IPC Action

### Request Schema

```typescript
interface ScaffoldProjectRequest {
  type: 'scaffold_project';
  projectName: string;       // e.g. "gravity-misinfo" — used as repo name, folder name, channel name
  requestedBy: string;       // JID of requesting channel
  templateRepo?: string;     // GitHub template — defaults to "cmhenry/research-project-template"
  skipGithub?: boolean;      // Skip repo creation + clone (for projects that don't need a repo)
  skipDiscord?: boolean;     // Skip channel creation (for projects that don't need a channel yet)
}
```

### Response Schema

```typescript
interface ScaffoldProjectResult {
  success: boolean;
  error?: string;
  github?: {
    repoUrl: string;         // e.g. "https://github.com/cmhenry/gravity-misinfo"
    clonedTo: string;        // e.g. "/home/square/projects/gravity-misinfo"
    alreadyExisted: boolean; // true if repo/folder were already present
  };
  discord?: {
    channelId: string;       // e.g. "dc:1488607209733623828"
    channelName: string;     // e.g. "gravity-misinfo"
    folder: string;          // e.g. "project_gravity-misinfo"
    alreadyExisted: boolean;
  };
}
```

### Input Validation (Security Boundary)

All validation happens on the host before any action is taken.

1. **Authorization:** Only main groups (`isMain === true`) can invoke this action.

2. **Project name sanitization:**
   - Must match `/^[a-z0-9][a-z0-9-]{0,62}$/` — lowercase alphanumeric + hyphens, 1-63 chars. This is the intersection of valid GitHub repo names, filesystem folder names, and Discord channel names.
   - Reject names containing path separators, dots, spaces, or uppercase.
   - Reject reserved names: `main`, `global`, `test`, `node_modules`, `.git`.

3. **Path confinement:**
   - The clone target is always `path.join(PROJECTS_ROOT, projectName)` where `PROJECTS_ROOT = path.join(os.homedir(), 'projects')`.
   - Resolve the path and verify it is strictly under `PROJECTS_ROOT` (defense against edge cases in `path.join` with crafted names, though the regex already prevents this).

4. **GitHub owner hardcoded:**
   - The repo owner is always `cmhenry`. Never derived from container input. The container can specify a template repo but the owner prefix is stripped and replaced.

5. **Template repo validation:**
   - If `templateRepo` is provided, extract only the repo name portion and prefix with `cmhenry/`. So `evil-org/backdoor-template` becomes `cmhenry/backdoor-template`, which will simply fail if it doesn't exist. Default: `cmhenry/research-project-template`.

### Execution Sequence

Each step is idempotent — checks before acting.

```
1. Validate inputs (above)
2. If !skipGithub:
   a. Check if repo exists: gh repo view cmhenry/{name} (suppress errors)
   b. If not: gh repo create cmhenry/{name} --private --template {template}
   c. Check if ~/projects/{name} exists and is a git repo
   d. If not: git clone https://github.com/cmhenry/{name} ~/projects/{name}
   e. If dir exists but not a git repo: fail with error (don't remove — may contain user content)
3. If !skipDiscord:
   a. Check if a registered group already has projectPath === ~/projects/{name}
   b. If not: call existing createProjectChannel() internally
4. Return combined result
```

### Partial Failure Handling

- If GitHub repo creation succeeds but clone fails: report partial success with the error. The repo exists and can be cloned manually or by re-running.
- If GitHub + clone succeed but Discord fails: report partial success. The repo and folder are usable; Discord can be added by re-running or via `create_project_channel`.
- On re-run: steps that already completed are skipped (idempotent), and only the failed step retries.

### Implementation Location

- **New function:** `scaffoldProject()` in `src/index.ts` alongside `createProjectChannel()`.
- **New interface:** `ScaffoldProjectRequest` and `ScaffoldProjectResult` in `src/ipc.ts`.
- **IPC handler:** New `case 'scaffold_project':` in `processTaskIpc()` in `src/ipc.ts`.
- **Shell commands:** Use `child_process.execFile` (not `exec`) to avoid shell injection. Pass arguments as arrays, never string interpolation.
  ```typescript
  execFileSync('gh', ['repo', 'create', `cmhenry/${name}`, '--private', '--template', template]);
  execFileSync('git', ['clone', repoUrl, targetPath]);
  ```
- **Config constant:** `PROJECTS_ROOT` added to `src/config.ts`.

### Deprecation of `create_project_channel`

`create_project_channel` remains as-is for backward compatibility. `scaffold_project` calls `createProjectChannel()` internally for its Discord step. No breaking changes.

## Container Side: Revised `idea-triage` Skill

The `idea-triage` skill's upgrade path changes from aspirational `gh` calls to IPC-based scaffolding. The Obsidian vault work stays in the container; the host work goes through IPC.

### Revised Upgrade Sequence

```
Container (vault operations):
  1. Read the idea note
  2. Create projects/{slug}/PROJECT.md (seeded from idea findings)
  3. Move idea note to projects/{slug}/ORIGIN.md, set status: upgraded
  4. Generate projects/{slug}/{slug}-writing-rubric.md
  5. Update projects/_registry.md with new project entry
  6. Remove idea from scratch.md

Container (IPC request):
  7. Write scaffold_project IPC task:
     {
       type: "scaffold_project",
       projectName: "{slug}",
       requestedBy: "{chat-jid}"
     }
  8. Poll for result file (up to 30s)
  9. Read result and report to user

     Success: "Upgraded {slug} to project.
       Vault: projects/{slug}/
       Repo: github.com/cmhenry/{slug}
       Discord: #{slug}"

     Partial: Report what succeeded and what failed.
     Failure: Report error, note that vault operations completed.
```

### Writing Rubric Generation

The container creates `projects/{slug}/{slug}-writing-rubric.md` with a minimal template. The structure follows the existing `platform-abm-writing-rubric.md` pattern:

```markdown
# Writing Rubric: {Project Title}

Project-specific evaluation criteria. Supplements `_meta/writing-rubric.md`
(global rules always apply). This file encodes the venue requirements,
framing decisions, and project-specific standards.

---

## Venue

- **Target:** TBD
- **Format:** TBD
- **Review criteria:** TBD

## Audience

- **Primary reader:** TBD
- **Assumed knowledge:** TBD

## Framing Constraints

- **Core argument in one sentence:** TBD
- **This paper is NOT about:** TBD

## Citation Norms

- **Must-cite papers:** [Seed from ORIGIN.md papers-to-read if available]

## Section-Specific Notes

[To be filled as the project develops]

## Project-Specific Anti-Patterns

[To be filled as writing begins]

---

_Last updated: {date}_ _Update this file when the venue, framing, or argument changes._
```

If the idea's ORIGIN.md contains venue targets, must-cite papers, or framing decisions, those are populated rather than left as TBD.

### Registry Update

Append a row to the Active Projects table in `projects/_registry.md`:

```markdown
| [{slug}]({slug}/PROJECT.md) | research | medium | {date} | New project; [one-line status from PROJECT.md] |
```

### `create-project-channel` Container Skill

This existing skill becomes a thin wrapper: for cases where the repo and folder already exist but the user just wants a Discord channel, it continues to use the `create_project_channel` IPC action directly. No changes needed.

## Testing

### Host-side unit tests (`src/ipc.test.ts` / `src/index.test.ts`):

1. **Validation tests:**
   - Valid project names accepted
   - Path traversal names rejected (`../etc`, `foo/bar`)
   - Reserved names rejected
   - Uppercase/special chars rejected
   - Empty/too-long names rejected

2. **Idempotency tests:**
   - Re-running with existing repo skips creation
   - Re-running with existing folder skips clone
   - Re-running with existing Discord channel skips registration

3. **Partial failure tests:**
   - GitHub fails → returns error, no clone or Discord attempted
   - Clone fails → returns partial with github success
   - Discord fails → returns partial with github success

4. **Security tests:**
   - Non-main group request rejected
   - Template repo owner always resolves to `cmhenry`
   - Clone target always under `PROJECTS_ROOT`

### Container-side manual testing:

- Trigger idea upgrade from main Discord channel
- Verify all vault artifacts created (PROJECT.md, ORIGIN.md, rubric, registry)
- Verify IPC result read correctly
- Verify re-run is safe (idempotent)

## Files Changed

| File | Change |
|------|--------|
| `src/config.ts` | Add `PROJECTS_ROOT` constant |
| `src/ipc.ts` | Add `ScaffoldProjectRequest/Result` interfaces, add `scaffold_project` case |
| `src/index.ts` | Add `scaffoldProject()` function, wire into IPC deps |
| `container/skills/idea-triage/SKILL.md` | Replace `gh` calls with IPC-based scaffold sequence |
| `container/skills/create-project-channel/SKILL.md` | No changes (still works for channel-only cases) |

## Not In Scope

- Modifying the NanoClaw codebase from containers (use idea capture + Claude Code sessions)
- General-purpose shell execution via IPC
- Obsidian vault operations on the host (container handles these directly)
- Automated writing rubric population beyond seeding from ORIGIN.md
