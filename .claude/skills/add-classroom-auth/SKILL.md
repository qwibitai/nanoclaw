---
name: add-classroom-auth
description: Layer per-student Codex OAuth onto /add-classroom — students upload their own ChatGPT auth.json via a magic-link form so the agent burns their subscription quota instead of the instructor's. Adds /login command, request_reauth nudge, magic-link HTTP server.
---

# Add Classroom — Per-Student Auth

Layered on top of `/add-classroom`. Adds:

- A magic-link HTTP server that lets students upload the
  `auth.json` produced by `codex login` on their laptop.
- A pair-time consumer that issues a fresh magic link and DMs the
  URL right after pairing.
- A `/login` Telegram command for re-issuing auth links any time.
- A codex provider auth resolver that picks the per-student
  `auth.json` over the instructor's host one.
- A container-side helper for detecting refresh failures and
  triggering a re-auth nudge to the student.
- The `request_reauth` delivery action that turns container-side
  refresh failures into a fresh magic link sent to the student.

## Prerequisites

- `/add-classroom` must be installed first. The skill aborts otherwise.
- A reachable public URL for the magic-link server. Students click
  the link from their phone; localhost won't work for class
  deployments. Set `NANOCLAW_PUBLIC_URL` in `.env` before
  provisioning a real class. (The skill installs fine without it;
  pair-time auth links just render with a fallback message.)

## Install

### Pre-flight (idempotent)

Skip to **Configure** if all of these are in place:

- `src/student-auth.ts`, `src/student-auth-server.ts`,
  `src/student-auth-handlers.ts`, `src/class-codex-auth.ts`,
  `src/class-telegram-commands.ts`, `src/class-pair-auth.ts`,
  `container/agent-runner/src/auth-nudge.ts` exist
- `src/index.ts` includes the four auth-related imports
- `STUDENT_AUTH_PORT`, `STUDENT_AUTH_BIND_HOST`, `NANOCLAW_PUBLIC_URL`
  exist in `src/config.ts`

### 1. Verify base skill is installed

```bash
[ -f src/class-pair-greeting.ts ] || { echo "Run /add-classroom first."; exit 1; }
```

### 2. Fetch the classroom branch

```bash
git fetch origin classroom
```

### 3. Copy the auth-specific files

```bash
git show origin/classroom:src/student-auth.ts            > src/student-auth.ts
git show origin/classroom:src/student-auth.test.ts       > src/student-auth.test.ts
git show origin/classroom:src/student-auth-server.ts     > src/student-auth-server.ts
git show origin/classroom:src/student-auth-server.test.ts > src/student-auth-server.test.ts
git show origin/classroom:src/student-auth-handlers.ts   > src/student-auth-handlers.ts
git show origin/classroom:src/class-codex-auth.ts        > src/class-codex-auth.ts
git show origin/classroom:src/class-telegram-commands.ts > src/class-telegram-commands.ts
git show origin/classroom:src/class-pair-auth.ts         > src/class-pair-auth.ts
mkdir -p container/agent-runner/src
git show origin/classroom:container/agent-runner/src/auth-nudge.ts      > container/agent-runner/src/auth-nudge.ts
git show origin/classroom:container/agent-runner/src/auth-nudge.test.ts > container/agent-runner/src/auth-nudge.test.ts
```

### 4. Append the self-registration imports

Append these lines to `src/index.ts` (skip if present):

```typescript
import './class-codex-auth.js';
import './class-pair-auth.js';
import './class-telegram-commands.js';
import './student-auth-handlers.js';
```

### 5. Add the auth-related config exports

Append to `src/config.ts` (skip if present):

```typescript
const studentAuthEnv = readEnvFile(['NANOCLAW_PUBLIC_URL', 'STUDENT_AUTH_BIND_HOST']);
export const STUDENT_AUTH_PORT = parseInt(process.env.STUDENT_AUTH_PORT || '3003', 10);
export const STUDENT_AUTH_BIND_HOST: string =
  process.env.STUDENT_AUTH_BIND_HOST || studentAuthEnv.STUDENT_AUTH_BIND_HOST || '0.0.0.0';
export const NANOCLAW_PUBLIC_URL: string =
  process.env.NANOCLAW_PUBLIC_URL || studentAuthEnv.NANOCLAW_PUBLIC_URL || '';
```

### 6. Build

```bash
pnpm exec tsc --noEmit
pnpm test
```

## Configure (instructor-side)

1. **Set `NANOCLAW_PUBLIC_URL` in `.env`**:
   ```
   NANOCLAW_PUBLIC_URL=https://your-host.example.com
   ```
   This is the public-facing URL the student-auth server is
   reachable at. If your install runs behind a tunnel (cloudflared,
   ngrok, tailscale funnel), use the tunnel hostname.

2. **Open `STUDENT_AUTH_PORT` (default 3003)** if it's not behind
   a reverse proxy that forwards `/student-auth/*` to it.

3. **Restart the host** so the new exports get picked up:
   ```bash
   systemctl --user restart nanoclaw   # or the macOS launchd equivalent
   ```

## What students experience

After pairing, the auth consumer adds a third short message:

> Hi Alice! Welcome to class. Send /playground any time to customize…  ← greeting
> Your Google Drive folder is shared with you here: …                  ← gws (if installed)
> Connect your ChatGPT account so I run on your subscription instead   ← auth
> of your instructor's: https://your-host.example.com/student-auth?t=…
> (Send /login any time to get a fresh link…)

The student runs `codex login` on their laptop, opens the link, and
drags `~/.codex/auth.json` onto the page (or pastes its contents).
After upload, future agent activity for that student burns their
ChatGPT subscription quota; the codex provider's resolver chain
picks up `data/student-auth/<user_id>/auth.json` over the
instructor's host auth.

If the refresh token later expires (rare — they last weeks), the
container detects it and the host auto-DMs a fresh magic link.

## Refresh-failure detection caveat

The detection regex in `container/agent-runner/src/auth-nudge.ts`
is best-effort — calibrated against likely error patterns but not
yet against a real Codex refresh failure. If you observe the agent
appearing broken after a token expires AND no nudge fires, check
`logs/nanoclaw.log` for the actual error string and update the
regex in auth-nudge.ts.
