# NanoClaw — Development Guide

## Prerequisites

| Tool | Version | Notes |
|------|---------|-------|
| Node.js | ≥ 20 (22 recommended) | Required by `engines` field |
| npm | Bundled with Node.js | Used for package management |
| Docker | Latest stable | Required for container agent testing |
| TypeScript | ^5.9.3 (devDep) | Installed via npm |

---

## Local Setup

### 1. Install dependencies

```bash
npm install
```

This installs both orchestrator deps and all devDeps (TypeScript, vitest, prettier, tsx).

> **Note:** `better-sqlite3` is a native module and requires build tools (`xcode-select --install` on macOS, `build-essential` on Linux).

### 2. Configure environment

```bash
cp .env.example .env
```

Edit `.env` and add one of:
```
ANTHROPIC_API_KEY=sk-ant-...
# or
CLAUDE_CODE_OAUTH_TOKEN=...
```

### 3. WhatsApp authentication

```bash
npm run auth
```

Scan the QR code with WhatsApp. Auth files are saved to `store/auth/`.

### 4. Register a group

```bash
npm run setup
```

Or use the `/setup` skill in Claude Code for interactive guided setup.

### 5. Build the container image

```bash
./container/build.sh
```

This builds the Docker image `nanoclaw-agent:latest` with Chromium, Claude Code, and the agent runner compiled inside.

> **Important:** If you modify `container/agent-runner/src/`, rebuild the container. The Dockerfile compiles TypeScript on startup, but only from files baked into the image.

---

## Development Workflow

### Run with hot reload (orchestrator only)

```bash
npm run dev
```

Uses `tsx` for on-the-fly TypeScript execution. No compilation step needed. Container image is separate and must be rebuilt independently.

### Type checking

```bash
npm run typecheck
```

Runs `tsc --noEmit` — no output files, just type validation.

### Build for production

```bash
npm run build
```

Compiles `src/` → `dist/`. Entrypoint: `dist/index.js`.

### Code formatting

```bash
npm run format          # Format all src/**/*.ts in place
npm run format:check    # Check formatting (used in CI)
```

NanoClaw uses Prettier with default settings.

---

## Testing

### Run tests

```bash
npm test
# or
npm run test:watch     # Watch mode for development
```

Tests use Vitest. Coverage is available via `@vitest/coverage-v8`.

### Test file locations

- Test files follow the pattern `**/*.test.ts` or `**/*.spec.ts`
- Located alongside source files or in `__tests__/` directories

### CI

GitHub Actions runs on every PR to `main`:
1. `npm ci` — clean install
2. `npx tsc --noEmit` — typecheck
3. `npx vitest run` — full test suite

---

## Container Development

### Rebuild after agent-runner changes

```bash
./container/build.sh
```

> **Cache note:** The Docker BuildKit cache is aggressive. `--no-cache` alone does NOT invalidate COPY steps. To force a completely clean rebuild:
> ```bash
> docker builder prune -f
> ./container/build.sh
> ```

### Container runtime selection

The default runtime is Docker. To switch to Apple Container (macOS only):
```bash
# Run the /convert-to-apple-container skill
```

### Inspect a running container

```bash
docker ps                              # Find container name
docker logs <container_name>           # View stdout/stderr
docker exec -it <container_name> bash  # Interactive shell
```

### Container run logs

Per-run logs are written to `groups/{name}/logs/container-{timestamp}.log`.

---

## Database

NanoClaw uses a single SQLite database at `store/messages.db`. Schema is applied on startup via `src/db.ts` using `CREATE TABLE IF NOT EXISTS`.

### Inspect the database

```bash
npx tsx -e "
import Database from 'better-sqlite3';
const db = new Database('store/messages.db');
console.log(db.prepare('SELECT * FROM registered_groups').all());
"
```

Or use any SQLite client (e.g., TablePlus, DB Browser for SQLite).

### Schema migrations

Additive migrations use `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` wrapped in try/catch. Columns are never dropped. See `src/db.ts` for migration details.

---

## Project Structure for Contributors

NanoClaw only accepts bug fixes and security patches as code contributions. Features are added via the skills system (`.claude/skills/*.md`) rather than core code changes. See `CONTRIBUTING.md`.

### Adding a new channel

Use the `/customize` skill rather than modifying `src/` directly. This ensures changes stay in a customization layer that can be safely updated when pulling upstream changes.

### Key configuration constants (`src/config.ts`)

| Constant | Default | Description |
|----------|---------|-------------|
| `ASSISTANT_NAME` | `"Andy"` | Bot trigger name (from `ASSISTANT_NAME` env var) |
| `POLL_INTERVAL` | `2000ms` | Message polling frequency |
| `SCHEDULER_POLL_INTERVAL` | `60000ms` | Task scheduler check frequency |
| `CONTAINER_TIMEOUT` | `1800000ms` (30 min) | Max time a container can run |
| `IDLE_TIMEOUT` | `1800000ms` (30 min) | Idle container termination |
| `MAX_CONCURRENT_CONTAINERS` | `5` | Max simultaneous running containers |

---

## Common Development Tasks

### Add a new MCP tool

1. Define the tool in `container/agent-runner/src/ipc-mcp-stdio.ts`
2. Add the corresponding IPC handler in `src/ipc.ts`
3. Define the IPC payload type in `src/types.ts`
4. Rebuild the container: `./container/build.sh`

### Add a new database table

1. Add `CREATE TABLE IF NOT EXISTS` statement in `src/db.ts` `initializeDatabase()`
2. Add helper functions in `src/db.ts`
3. Export types from `src/types.ts`

### Change the trigger pattern

Edit the group's registration via `/setup` or directly in the DB:
```sql
UPDATE registered_groups SET trigger_pattern = '@NewName' WHERE folder = 'main';
```

### Clear a group's session (force fresh context)

```sql
DELETE FROM sessions WHERE group_folder = 'main';
```

### View scheduled tasks

```bash
npx tsx -e "
import Database from 'better-sqlite3';
const db = new Database('store/messages.db');
console.log(db.prepare('SELECT * FROM scheduled_tasks WHERE status = ?').all('active'));
"
```
