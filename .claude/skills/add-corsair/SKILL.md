---
name: add-corsair
description: Skill
---

# Add Corsair Integration

This skill wires the `corsair` npm package (already in `package.json`) into NanoClaw by creating a singleton client, adding a `setup/corsair.ts` step that calls `setupCorsair()`, and configuring plugin credentials.

## Phase 1: Pre-flight

### Check if already applied

Check if `src/corsair.ts` exists. If it does, skip to Phase 3 (Credentials). The code is already in place.

### Ask the user which plugins to enable

Use `AskUserQuestion` (multiSelect):

> Which Corsair plugins do you want to enable?
>
> - **github** — Issues, PRs, repos, workflows (needs personal access token)
> - **slack** — Send/read messages (needs bot + app token)
> - **discord** — Send/read messages (needs bot token)
> - **gmail** — Send/read email (needs OAuth)
> - **googlecalendar** — Events and scheduling (needs OAuth)
> - **googledrive** — File access (needs OAuth)
> - **googlesheets** — Spreadsheet read/write (needs OAuth)
> - **notion** — Pages and databases (needs integration token)
> - **linear** — Issues and projects (needs API key)
> - **todoist** — Tasks (needs API token)
> - **resend** — Transactional email (needs API key)
> - **posthog** — Analytics (needs API key)
> - **hubspot** — CRM (needs API key)
> - **airtable** — Bases and tables (needs API key)
> - **cal** — Scheduling (needs API key)
> - **spotify** — Playback and library (needs OAuth)

Record the user's selection. The plugins list determines imports and credentials.

## Phase 2: Code Changes

### Create `src/corsair.ts`

Create this file with the plugins the user selected. Each plugin is imported from `corsair` and included in the `plugins` array.

Example for a user who selected `github` and `linear`:

```typescript
import Database from 'better-sqlite3';
import { createCorsair, createCorsairDatabase } from 'corsair';
import { github } from 'corsair/plugins';
import { linear } from 'corsair/plugins';

import { STORE_DIR } from './config.js';
import { logger } from './logger.js';
import path from 'path';

const rawDb = new Database(path.join(STORE_DIR, 'messages.db'));
const database = createCorsairDatabase(rawDb);

export const corsair = createCorsair({
  plugins: [github(), linear()],
  database,
  kek: process.env.CORSAIR_KEK ?? '',
});

export type AppCorsair = typeof corsair;
```

Substitute the actual selected plugins. Import each one from `corsair/plugins` (e.g. `import { github } from 'corsair/plugins'`), call it as a function in the `plugins` array.

### Create `setup/corsair.ts`

```typescript
/**
 * Step: corsair — initialise corsair integration (tables, DEKs, auth check).
 */
import { setupCorsair } from 'corsair';

import { corsair } from '../src/corsair.js';
import { emitStatus } from './status.js';

export async function run(_args: string[]): Promise<void> {
  await setupCorsair(corsair);

  emitStatus('CORSAIR', {
    STATUS: 'success',
  });
}
```

### Register the step in `setup/index.ts`

Add `corsair` to the `STEPS` map:

```typescript
corsair: () => import('./corsair.js'),
```

### Validate

```bash
npm run build
```

Fix any TypeScript errors before proceeding.

## Phase 3: Credentials

### Generate the Key Encryption Key (KEK)

The KEK protects all plugin credentials at rest. Generate one:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Add to `.env`:

```
CORSAIR_KEK=<generated-hex>
```

### Collect plugin credentials

For each selected plugin, collect credentials and add them to `.env`. Corsair stores them encrypted in the database during setup — `.env` is only needed for the bootstrap call. After first run, credentials live in the DB.

**github** — Personal access token (Settings → Developer settings → Tokens):

```
GITHUB_TOKEN=ghp_...
```

**linear** — API key (Linear → Settings → API → Personal API keys):

```
LINEAR_API_KEY=lin_api_...
```

**slack** — Bot token and app token (same as `/add-slack`):

```
SLACK_BOT_TOKEN=xoxb-...
SLACK_APP_TOKEN=xapp-...
```

**discord** — Bot token:

```
DISCORD_BOT_TOKEN=...
```

**gmail / googlecalendar / googledrive / googlesheets** — OAuth client ID + secret:

```
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
```

**notion** — Integration token (Notion → My integrations):

```
NOTION_TOKEN=secret_...
```

**todoist** — API token (Todoist → Settings → Integrations → Developer):

```
TODOIST_API_TOKEN=...
```

**resend** — API key:

```
RESEND_API_KEY=re_...
```

**posthog** — Project API key:

```
POSTHOG_API_KEY=phc_...
```

**hubspot** — Private app access token:

```
HUBSPOT_ACCESS_TOKEN=...
```

**airtable** — Personal access token:

```
AIRTABLE_TOKEN=...
```

**cal** — API key:

```
CAL_API_KEY=...
```

**spotify** — Client ID and secret:

```
SPOTIFY_CLIENT_ID=...
SPOTIFY_CLIENT_SECRET=...
```

Wait for the user to add their credentials.

Sync to container environment:

```bash
mkdir -p data/env && cp .env data/env/env
```

## Phase 4: Run Setup

```bash
npx tsx setup/index.ts --step corsair
```

Parse the status block:

- `STATUS=success` → Corsair is initialised. Tables exist, DEKs are issued, auth checked.
- `STATUS=failed` → Read the error. Common causes:
  - `CORSAIR_KEK` is empty or missing — re-check `.env`
  - Missing plugin credentials — add them and re-run
  - TypeScript error from bad plugin import — re-check `src/corsair.ts`

### Optional: backfill initial data

Once credentials are stored and auth passes, seed the local cache:

```bash
npx tsx -e "
import { setupCorsair } from 'corsair';
import { corsair } from './src/corsair.js';
await setupCorsair(corsair, { backfill: true });
console.log('Backfill done');
"
```

## Phase 5: Verify

Tell the user:

> Corsair is initialised. The database now has `corsair_integrations` and `corsair_accounts` rows for each plugin, DEKs are issued, and credentials are stored encrypted.
>
> Restart the service to pick up the new `CORSAIR_KEK` env var:

```bash
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
```

Then verify the tables were created:

```bash
sqlite3 store/messages.db ".tables" | tr ' ' '\n' | grep corsair
```

You should see: `corsair_integrations`, `corsair_accounts`, `corsair_entities`, `corsair_events`, `corsair_permissions`.

## Troubleshooting

**`CORSAIR_KEK` must not be empty** — Generate a key and add it to `.env`, then sync to `data/env/env`.

**Plugin auth warnings in setup output** — Normal on first run if credentials haven't been stored yet. Add the credential to `.env`, sync, and re-run the corsair step.

**`createCorsairDatabase` type error** — Ensure `better-sqlite3` types are installed (`npm install`). The raw `Database` instance from `better-sqlite3` is passed directly; do not wrap it yourself.

**Table already exists errors** — Corsair uses `CREATE TABLE IF NOT EXISTS` internally — safe to re-run setup at any time.
