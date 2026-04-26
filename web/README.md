# web/

Paraclaw's web UI — the management surface for vault attachments per agent group.

## Two pieces

- **`server/`** — a small Node http server. Reads NanoClaw's central `data/v2.db` (agent_groups table) read-only, exposes `/api/groups` + attach/detach endpoints, shells out to the `parachute` CLI to mint scoped vault tokens. Static-serves the built UI bundle from `../ui/dist`.
- **`ui/`** — Vite + React + TypeScript. Lists agent groups, drills into one to see its current vault attachment, has a form to attach a vault (mints a fresh scoped token via the server, or accepts a pasted one). Detach button and confirmation flow.

## Run (dev)

You need a Parachute Vault running on `127.0.0.1:1940` and NanoClaw initialized at least once (so `data/v2.db` exists).

```sh
# Terminal 1 — server
cd web/server
pnpm install --ignore-workspace
PARACLAW_WEB_PORT=4944 pnpm dev
# → http://127.0.0.1:4944

# Terminal 2 — UI dev server (hot reload)
cd web/ui
pnpm install --ignore-workspace
pnpm dev
# → http://localhost:5173
# (Vite proxies /api/* to the server on 4944)
```

Open `http://localhost:5173/` to use the UI in dev mode.

## Run (built)

```sh
cd web/ui && pnpm build       # → dist/
cd ../server && pnpm start    # serves dist/ at the server's root
# → http://127.0.0.1:4944
```

## Auth model

**v1 (today):** server runs locally, binds `127.0.0.1`, no auth. The minted vault tokens never round-trip to the browser — the server runs `parachute vault tokens create` and writes the result straight into `groups/<folder>/container.json`.

If the user opts to paste an existing token instead of minting, that token *does* land in the browser briefly; the `paraclaw-web-server` doesn't persist it anywhere except where it would already go (the per-group container.json that the agent runner reads at startup).

**Phase B:** server registers as an OAuth client of the user's vault (RFC 7591 DCR), the user approves once via the vault's consent page, the server holds the resulting admin token. Per-claw scoped tokens are minted from there. Users never see `pvt_…` tokens.

## Why the bootstrap.ts dance

NanoClaw's `src/config.ts` resolves `DATA_DIR` and `GROUPS_DIR` via `process.cwd()`. The web server is invoked from `web/server/`, which would resolve those to the wrong paths. `web/server/src/bootstrap.ts` is imported FIRST in `server.ts` and chdirs to the project root before any NanoClaw module loads.

A more upstream-friendly fix would be to make NanoClaw's config compute paths from `import.meta.url` instead of `process.cwd()`. That'd be a one-line change worth proposing upstream eventually; for now bootstrap chdir is the smallest patch.

## Pinned to canonical port?

Not yet. `4944` is a placeholder while paraclaw is exploratory. If the project earns its keep, we file an issue against `parachute-cli` to claim a slot in `PORT_RESERVATIONS` (1944–1949 range was unassigned at last check). Per `parachute-patterns/patterns/canonical-ports.md`: claim a slot when you ship, not before.

## What's next

See [`../docs/parachute-integration.md`](../docs/parachute-integration.md) for the full trajectory. Near-term:

- **OAuth handshake** — replace the admin-token-as-env path in the server with vault OAuth. Phase B's biggest single add.
- **New-agent wizard** — currently the UI manages vault attachment for *existing* agent groups (created via NanoClaw's setup flow). Adding a wizard for "spin up a new agent group + attach vault in one flow" is the next natural step, requires wrapping NanoClaw's `init-first-agent` / `create-agent` paths.
- **Live status** — show whether a group's container is currently running, recent activity. Reads from NanoClaw's session tables.
