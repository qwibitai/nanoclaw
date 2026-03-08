# Contributing

## Source Code Changes

**Accepted:** Bug fixes, security fixes, simplifications, reducing code.

**Not accepted:** Features, capabilities, compatibility, enhancements. These should be skills.

## Skills

A skill is a self-contained package in `.claude/skills/` that deterministically transforms a NanoClaw installation. The skills engine applies changes via three-way merges, tracks state in `.nanoclaw/state.yaml`, and supports uninstall/replay.

A PR that contributes a skill should not modify any source files outside `.claude/skills/`.

### Why skills instead of source changes?

Every user should have clean and minimal code that does exactly what they need. Skills let users selectively add features to their fork without inheriting code for features they don't want.

---

## Skill structure

```
.claude/skills/add-telegram/
├── manifest.yaml          # Declares what the skill adds/modifies
├── SKILL.md               # Claude Code instructions for the setup flow
├── add/                   # New files to copy into the project
│   └── src/channels/
│       ├── telegram.ts
│       └── telegram.test.ts
├── modify/                # Patches to existing project files
│   └── src/channels/
│       ├── index.ts           # Full intended state of the file after patching
│       └── index.ts.intent.md # Human-readable description of the change
└── tests/                 # Skill-level integration tests
    └── telegram.test.ts
```

### `manifest.yaml`

Declares the skill's identity and what it touches:

```yaml
skill: telegram              # Must be unique across all skills
version: 1.0.0
description: "Telegram Bot API integration via Grammy"
core_version: 1.2.8          # Minimum NanoClaw core version required
adds:
  - src/channels/telegram.ts
  - src/channels/telegram.test.ts
modifies:
  - src/channels/index.ts
structured:
  npm_dependencies:
    grammy: "^1.39.3"
  env_additions:
    - TELEGRAM_BOT_TOKEN
conflicts: []               # Skill names this cannot coexist with
depends: []                 # Skill names that must be applied first
test: "npx vitest run src/channels/telegram.test.ts"
```

### `add/` — new files

Files listed under `adds` in the manifest are copied **verbatim** from `add/` into the project, preserving the directory structure. If the destination already exists it is overwritten.

Use `add/` for files the skill owns entirely — new channel implementations, new utilities, new tests.

### `modify/` — patches to existing files

Files listed under `modifies` are **three-way merged** into the existing project file:

```
current (on disk)  ←  base (.nanoclaw/base/)  →  skill (modify/)
```

- `base/` is a snapshot of the file captured the first time the skill was applied — it serves as the common ancestor.
- The merge algorithm is `git merge-file`. If both sides changed the same lines, conflict markers are written and the apply fails.
- Each modified file should have a companion `<filename>.intent.md` describing exactly what changed and any invariants (e.g. "append-only — preserve existing imports").

The file in `modify/` is the **full intended final state** of that file after the skill is applied, not a diff.

### `SKILL.md`

Claude Code reads this file when the user invokes the skill (e.g. `/add-telegram`). It contains the interactive setup instructions: collecting credentials, running `apply-skill.ts`, installing dependencies, registering chats, and verifying the result.

---

## Creating a new skill

1. **Create the skill directory:**
   ```
   .claude/skills/add-<name>/
   ```

2. **Write `manifest.yaml`** — declare `adds`, `modifies`, `structured` dependencies, `depends`, and `conflicts`.

3. **Populate `add/`** — copy the full source for each new file into the correct path under `add/`.

4. **Populate `modify/`** — for each file you need to patch:
   - Write the full file as it should look after applying the skill.
   - Write a companion `.intent.md` explaining the change and invariants.

5. **Write `SKILL.md`** — the interactive instructions Claude follows. See `/add-telegram` as a reference.

6. **Add tests** — place skill-level tests in `tests/`. These should verify the feature works after `apply-skill.ts` runs, not just that files were copied.

7. **Test on a fresh clone** before submitting:
   ```bash
   git clone https://github.com/qwibitai/nanoclaw.git test-install
   cd test-install
   npm install
   npx tsx scripts/apply-skill.ts .claude/skills/add-<name>
   npm test
   ```

---

## Improving an existing skill

If you've applied a skill and then made further changes to the project (e.g. adding Telegram image support after running `/add-telegram`), those changes should be incorporated back into the skill so future users get them automatically.

1. **Update the skill files** — edit `add/<file>` or `modify/<file>` to reflect your improvements. If you're adding support for a file not currently in the manifest, add it to `adds` or `modifies`.

2. **Bump the version** in `manifest.yaml` (semver).

3. **Update `.intent.md`** files if the intent of a patch changed.

4. **Test by uninstalling and re-applying:**
   ```bash
   npx tsx scripts/uninstall-skill.ts <skill-name>
   npx tsx scripts/apply-skill.ts .claude/skills/add-<name>
   npm test
   ```
   Uninstalling first gives you a clean baseline — it restores the pre-skill state of all modified files using the base snapshots.

5. If the skill has a `test` command in the manifest, run it:
   ```bash
   npx vitest run src/channels/<name>.test.ts
   ```

---

## Submitting a PR

1. Fork the repo and create a branch.
2. Make your changes inside `.claude/skills/` only (no source file changes for skill PRs).
3. Test on a fresh clone (see above).
4. Open a PR against `main`. Describe what the skill does and how you tested it.
