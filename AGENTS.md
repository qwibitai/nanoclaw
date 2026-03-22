# Repository Guidelines

## Project Structure & Module Organization
`src/` contains the core runtime: orchestration, routing, SQLite persistence, scheduling, container control, and channel registration. Key files are `src/index.ts`, `src/router.ts`, `src/db.ts`, `src/group-queue.ts`, and `src/container-runner.ts`; `src/channels/` uses self-registration via `registry.ts` and `index.ts`. `setup/` handles install and service registration. `container/agent-runner/` contains code executed inside the agent container. Runtime state lives under `store/`, `data/`, and per-group folders in `groups/`. Tests are colocated as `*.test.ts` under `src/` and `setup/`. Check `docs/SPEC.md`, `docs/REQUIREMENTS.md`, and `docs/SECURITY.md` before changing architecture or sandbox behavior.

## Build, Test, and Development Commands
Use Node.js 20+.

- `npm run dev` runs the app from source with `tsx`.
- `npm run build` compiles TypeScript to `dist/`; `npm start` runs the compiled app.
- `npm run typecheck` performs a strict TypeScript check without emitting files.
- `npm test` runs the full Vitest suite; `npx vitest run src/db.test.ts` is the standard focused pattern for one file.
- `npm run format:check` verifies formatting; `npm run format:fix` rewrites `src/**/*.ts`.
- `./container/build.sh` rebuilds the agent container after sandbox-side changes.

## Preferred Deployment Path
The default operational path for this repo is: develop and validate on a MacBook, then deploy over SSH to an Apple Silicon Mac mini that runs the long-lived service. Treat the MacBook as the build/staging environment and the Mac mini as the runtime host.

- Prefer `Apple Container` on both machines so the built `nanoclaw-agent:latest` image and runtime assumptions stay aligned.
- Build and test on the MacBook first, including `./container/build.sh` for the agent image.
- Deploy code and runtime state separately. Runtime state worth migrating includes `.env`, `store/messages.db`, `groups/`, `data/sessions/`, `~/.config/nanoclaw/mount-allowlist.json`, and `store/auth/` when WhatsApp is in use.
- Do not migrate `node_modules/`, `dist/`, `logs/`, `data/ipc/`, or a machine-specific `~/Library/LaunchAgents/com.nanoclaw.plist`; rebuild dependencies and regenerate the service on the Mac mini.
- If reusing the tested container image, export and import it as an OCI tar with `container image save` on the MacBook and `container image load` on the Mac mini. The image alone is not sufficient; the target host still needs the repo checkout and runtime state.
- During cutover, do not leave both machines running the same bot/service simultaneously. Stop the source `launchd` service before starting the target one.
- On the Mac mini, finish deployment with `npm ci`, `npm rebuild better-sqlite3` if needed, `npx tsx setup/index.ts --step service`, and `npx tsx setup/index.ts --step verify`.

## Coding Style & Naming Conventions
This repo uses strict TypeScript, ES modules, and NodeNext resolution. Follow the existing style: 2-space indentation, single quotes, semicolons, and relative imports with `.js` suffixes. Use `camelCase` for functions and variables, `PascalCase` for classes and types, and lowercase filenames that match existing patterns such as `group-queue.ts` and `container-runtime.ts`. Let Prettier enforce formatting; keep comments brief and intent-focused.

## Testing Guidelines
Vitest is configured for `src/**/*.test.ts` and `setup/**/*.test.ts`. Add or update colocated tests whenever behavior changes, especially in routing, database state, IPC, scheduling, or container lifecycle code. Prefer deterministic tests around queueing and state transitions. Before opening a PR, run `npm run typecheck` and `npm test`; rebuild the container after `container/agent-runner/` or mount changes.

## Commit & Pull Request Guidelines
Recent history uses short conventional subjects such as `fix:`, `docs:`, `chore:`, `test:`, and `style:`. Keep commits small, scoped, and imperative. PRs should explain the problem, the behavior change, and the verification commands you ran. Core contributions should stay minimal: bug fixes, security fixes, simplifications, and code reduction are the default. New channels and optional capabilities should be skill-oriented; contributors still open a normal PR, and maintainers can extract a `skill/<name>` branch from it.

## Security & Configuration Notes
Do not commit live `.env` values or real credentials. Preserve the security model from `docs/SECURITY.md`: containers should only see explicit mounts, the project root should remain read-only from the sandbox, and real API keys should stay on the host via the credential-proxy flow. Review mount and runtime changes against `config-examples/` before merging.
