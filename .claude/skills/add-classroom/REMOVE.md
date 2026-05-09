# Remove Classroom (base)

Reverses `/add-classroom`. If `/add-classroom-gws` or
`/add-classroom-auth` are installed, run their REMOVE first — they
depend on the base.

## Steps

### 1. Check for layered skills

```bash
[ -f src/class-pair-drive.ts ] && echo "WARN: /add-classroom-gws still installed — run /remove-classroom-gws first"
[ -f src/class-pair-auth.ts ] && echo "WARN: /add-classroom-auth still installed — run /remove-classroom-auth first"
```

If either warned, abort and remove the layered skill first.

### 2. Remove the import block from `src/index.ts`

Delete (or comment out) these three lines:

```typescript
import './class-pair-greeting.js';
import './class-playground-gate.js';
import './class-container-env.js';
```

### 3. Delete the base classroom files

```bash
rm -f src/class-config.ts \
      src/class-config.test.ts \
      src/class-pair-greeting.ts \
      src/class-playground-gate.ts \
      src/class-container-env.ts \
      src/class-container-env.test.ts \
      scripts/class-skeleton.ts \
      scripts/class-skeleton-extensions.ts \
      docs/class-setup.md \
      plans/class.md \
      plans/class-smoke-test.md
```

### 4. Decide what to do with class data

The skill doesn't touch:

- `data/class-config.json`
- `data/class-roster.csv` (if generated; usually written to repo root)
- `groups/student_*/`
- `agent_groups` DB rows for `student_*` folders
- `messaging_group_agents` rows wiring student chats to those groups

These are **your provisioned class state**. Removing the skill code
without cleaning the data leaves orphan agent groups visible to the
host but with no class-aware code paths. Two options:

**Keep the data** if you might re-install the skill later — provisioned
students stay paired; they just won't get the class-specific welcome
or playground lockdown until you re-install.

**Wipe the data** with:

```bash
rm -f data/class-config.json class-roster.csv
sqlite3 data/v2.db "DELETE FROM messaging_group_agents WHERE agent_group_id IN
  (SELECT id FROM agent_groups WHERE folder LIKE 'student_%');
DELETE FROM agent_groups WHERE folder LIKE 'student_%';"
rm -rf groups/student_*
```

### 5. Rebuild

```bash
pnpm exec tsc --noEmit
pnpm test
```
