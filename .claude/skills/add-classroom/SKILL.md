---
name: add-classroom
description: Provision an instructor-owned bot that hosts a class with four role tiers — admin, instructor(s), TA(s), and students. Each role has its own agent group, persona, and permissions. Wiki commits attributed to real members. Role detection is by folder prefix (student_/ta_/instructor_). Layered with /add-classroom-gws (Drive folders) and /add-classroom-auth (per-student ChatGPT subscription).
---

# Add Classroom (base)

Bulk-provision a class with four role tiers against a single bot:

- **Admin** = the existing instance owner. Single global user.
- **Instructor** = global admin role. Multiple supported.
- **TA** = scoped admin on every student/TA agent group (whole-class).
  Each TA gets their own `ta_NN` agent group.
- **Student** = member of their own `student_NN` group only.

The base skill installs:

- `class-skeleton.ts` — bulk provisioner with `--instructors`,
  `--tas`, and student `--names` CLI flags.
- Three pair consumers (one per role, all idempotent) that stamp
  metadata + grant the right roles + send a short greeting.
- Role-aware playground lockdown: students get persona-only edits;
  TAs and instructors can edit non-persona files on student drafts.
- Per-student git identity injection so wiki commits show the real
  member name + email.
- A class-shared markdown file at `data/class-shared-students.md`
  symlinked into every student folder. Default content: Socratic-tutor
  stance + per-user web-hosting instructions (use
  `/var/www/sites/<your-folder>/<sitename>/` to avoid clobbering
  classmates). Instructor edits this one file → propagates to all
  students.

Optional layered skills (run after the base is installed):

- `/add-classroom-gws` — Google Drive folder per student via the
  instructor's existing Google OAuth.
- `/add-classroom-auth` — per-student Codex OAuth so students burn
  their own ChatGPT subscription quota instead of the instructor's.

## Prerequisites

- `/add-agent-playground` should be installed. The classroom feature
  works without it, but the playground lockdown gate has nothing to
  do until the playground is wired in. The skill warns if absent.
- `/add-telegram` (or another DM-capable channel) installed and
  paired. The class feature uses the channel-agnostic pair-consumer
  registry, but you need at least one channel that handles wire-to
  pairings (Telegram is what's documented in the smoke-test runbook).
- **Phase 12.1 main-side change**: the playground gate signature
  was extended to take a `userId` in context for role-aware
  decisions. If your `main` was last synced before May 6 2026,
  pull main first or merge in commit `0441eaf` so the role-aware
  gate actually sees who's editing.

## Install

This skill copies the base classroom files from the
`origin/classroom` sibling branch and appends imports.

### Pre-flight (idempotent — safe to re-run)

Skip to **Provision** if all of these are already in place:

- `src/class-config.ts`, `src/class-pair-greeting.ts`,
  `src/class-pair-instructor.ts`, `src/class-pair-ta.ts`,
  `src/class-playground-gate.ts`, `src/class-container-env.ts`,
  `scripts/class-skeleton.ts`, `scripts/class-skeleton-extensions.ts`
  exist
- `src/index.ts` contains imports for `class-pair-greeting`,
  `class-pair-instructor`, `class-pair-ta`, `class-playground-gate`,
  and `class-container-env`

Otherwise continue. Every step below is safe to re-run.

### 1. Fetch the classroom branch

```bash
git fetch origin classroom
```

### 2. Copy the base classroom files

```bash
git show origin/classroom:src/class-config.ts             > src/class-config.ts
git show origin/classroom:src/class-config.test.ts        > src/class-config.test.ts
git show origin/classroom:src/class-pair-greeting.ts      > src/class-pair-greeting.ts
git show origin/classroom:src/class-pair-instructor.ts    > src/class-pair-instructor.ts
git show origin/classroom:src/class-pair-ta.ts            > src/class-pair-ta.ts
git show origin/classroom:src/class-playground-gate.ts    > src/class-playground-gate.ts
git show origin/classroom:src/class-container-env.ts      > src/class-container-env.ts
git show origin/classroom:src/class-container-env.test.ts > src/class-container-env.test.ts
git show origin/classroom:scripts/class-skeleton.ts       > scripts/class-skeleton.ts
git show origin/classroom:scripts/class-skeleton-extensions.ts > scripts/class-skeleton-extensions.ts
mkdir -p docs
git show origin/classroom:docs/class-setup.md             > docs/class-setup.md
mkdir -p plans
git show origin/classroom:plans/class.md                  > plans/class.md
git show origin/classroom:plans/class-smoke-test.md       > plans/class-smoke-test.md
```

### 3. Append the self-registration imports

Append these five lines to `src/index.ts` (skip lines already
present). They go in the same area as the `import './channels/index.js'`
and `import './modules/index.js'` blocks:

```typescript
import './class-pair-greeting.js';
import './class-pair-instructor.js';
import './class-pair-ta.js';
import './class-playground-gate.js';
import './class-container-env.js';
```

### 4. Edit the skeleton extensions barrel

The base skill ships `scripts/class-skeleton-extensions.ts` as
EMPTY (no extensions). The gws and auth skills append their own
imports. If the file from step 2 has any imports already, leave
them — they're from a previously-installed layer.

If the file you copied has the gws import line, leave it. The
skill is idempotent and the import only takes effect when the
referenced file exists (i.e., gws is installed).

### 5. Build

```bash
pnpm exec tsc --noEmit
pnpm test
```

Both should be green. If `pnpm test` reports failures, diff against
`origin/classroom` to see what's drifted.

## Provision a class

```bash
pnpm exec tsx scripts/class-skeleton.ts \
  --count 16 \
  --names "Alice,Bob,Carol,Dave,Eve,Frank,Grace,Heidi,Ivan,Judy,Kenneth,Leo,Mia,Noor,Oscar,Pat" \
  --tas "Mara,Nikhil" \
  --instructors "Prof.Smith" \
  --kb /srv/class-kb \
  --wiki /srv/class-wiki
```

The `--tas` and `--instructors` flags are optional (default to
none, in which case only students get provisioned). Comma-separated
names; one folder per name (`ta_01`, `ta_02`, `instructor_01`, etc.).

This creates per-role group folders with starter CLAUDE.md +
CLAUDE.local.md + container.json (KB ro mount, wiki rw mount),
agent_groups rows, four-digit pairing codes via the `wire-to`
flow, and a `class-roster.csv` with a role column.

The first run also writes `data/class-shared-students.md` (default:
Socratic-tutor stance + per-user web-hosting instruction). Each
student folder's `.class-shared.md` is symlinked to it, so editing
that one file changes the class-wide stance for every student.

KB and wiki paths must be in
`~/.config/nanoclaw/mount-allowlist.json` or the host will refuse
to spawn containers.

See `docs/class-setup.md` for the full instructor README.

## What members experience after pairing

Each member DMs the bot:

```
<their-pairing-code> <their-email>
```

The bot replies based on the role of the folder the code targeted:

- **Student** (`student_NN`): "Hi Alice! Welcome to class. Send
  /playground any time to customize my personality and style."
- **TA** (`ta_NN`): "Hi Mara! You're set up as a TA for this class.
  You have admin access to every student's agent group..."
- **Instructor** (`instructor_NN`): "Hi Prof.Smith! You're set up
  as an instructor for this class. You have global admin..."

If `/add-classroom-gws` is installed, a Drive folder URL follows.
If `/add-classroom-auth` is installed, an auth-link URL follows.

The role grants happen at pair time:

- Instructor → global `admin` role.
- TA → scoped `admin` on every `student_*` and every other `ta_*`
  in the class (whole-class).
- Student → `agent_group_members` row on their own student folder.

## Customize the personas

Each role's default persona is in `scripts/class-skeleton.ts`
(`STUDENT_PERSONA`, `TA_PERSONA`, `INSTRUCTOR_PERSONA` template
literals). Per-member persona lives in
`groups/<folder>/CLAUDE.local.md` after provisioning — editable via
`/playground` (locked-down to persona-only edits for students;
admin-bypass for TAs and instructors).

The class-wide socratic stance lives in
`data/class-shared-students.md` and only applies to students. Edit
that one file; every student's next session picks it up.
