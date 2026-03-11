# Repository Guidelines

## Project Structure & Module Organization

Core runtime code lives in `src/` (orchestrator, routing, container runner, DB, channel adapters).  
Tests are colocated as `*.test.ts` under `src/` and `setup/`.  
Initialization and environment checks live in `setup/`.  
Container-specific code and images live in `container/` (including `container/agent-runner/`).  
Reference docs are in `docs/`, static images in `assets/`, and sample configs in `config-examples/`.

Runtime/local state (`data/`, `store/`, `logs/`, `.nanoclaw/`) is not source code and should not be committed.

## Build, Test, and Development Commands

- `pnpm install`: install dependencies (Node 20+, pnpm 10).
- `pnpm run dev`: run NanoClaw directly from TypeScript (`tsx src/index.ts`).
- `pnpm run build`: compile to `dist/` using `tsgo`.
- `pnpm run start`: run the compiled build (`node dist/index.js`).
- `pnpm run test`: run unit/integration tests with Vitest.
- `pnpm run check`: run full CI-style checks (`format:check`, `lint`, `typecheck`, `test`) through Turbo.
- `pnpm run setup`: execute setup flow (`setup/index.ts`).

## Coding Style & Naming Conventions

Use TypeScript ESM with strict typing (`tsconfig.json` has `strict: true`).  
Formatting is enforced by `oxfmt`; linting by `oxlint`.

- Format: `pnpm run format` or validate with `pnpm run format:check`
- Lint: `pnpm run lint` (or `pnpm run lint:fix`)

Follow existing patterns:

- 2-space indentation and double quotes (as produced by formatter)
- file names in kebab-case (for example, `container-runtime.ts`)
- tests named `*.test.ts`

## Testing Guidelines

Framework: Vitest (`vitest.config.ts`).  
Default test globs: `src/**/*.test.ts` and `setup/**/*.test.ts`.

Run:

- `pnpm run test` for full test pass
- `pnpm run test:watch` during development

Add tests alongside behavioral changes, especially around routing, container isolation, auth, and scheduler logic.

## Commit & Pull Request Guidelines

Recent history follows Conventional Commit style (`fix:`, `feat:`, `chore:`, `docs:`, `style:`). Keep commits scoped and imperative.

Before opening a PR:

1. Run `pnpm run check`.
2. Summarize behavior changes and impacted areas.
3. Link related issues when applicable.
4. Include logs/screenshots only when UI or operational output changes.

For this fork, keep source changes minimal and sync-friendly; route broad features/refactors upstream (`qwibitai/nanoclaw`) per `CONTRIBUTING.md`.

## Documentation Workflow

Use this source-of-truth order when making docs changes:

- `docs/SPEC.md`: runtime behavior, commands, interfaces
- `docs/SECURITY.md`: trust model, boundaries, credential/mount controls
- `docs/ARCHITECTURE.md`: operating patterns (coordinator, worker-manager, group model)
- `docs/INSTALLATION_MODEL.md`: installation and private config layout
- `ROADMAP.md`: future-state items only
- `README.md`: short summaries + links to canonical docs

When migrating or deleting a major doc, maintain `docs/HLD_MIGRATION_MAP.md` so removed content remains traceable.
