---
name: run-phase8
description: Launch the Phase 8 Next.js dashboard development orchestrator. Creates claws/dashboard/ with full Next.js implementation using 5 coordinated sub-agents. Run this once when ready to build the dashboard.
---

# Run Phase 8 — Dashboard Orchestrator

Launches a multi-agent development session to implement the Next.js dashboard (Phase 8).

Working directory: `claws/` root.

---

## Pre-flight

Check booking-api is running:

```bash
curl -s -o /dev/null -w "%{http_code}" http://localhost:3002/
```

Expected: `200`. If not, start it: `systemctl --user start booking-api`

Check disk space (dashboard install needs ~500MB):

```bash
df -h /home/florin | tail -1
```

Expected: at least 1GB free.

Check workspace directory:

```bash
mkdir -p /home/florin/WebstormProjects/claws/workspace
```

---

## Confirm with User

Before starting, tell the user:

> "Phase 8 will create `claws/dashboard/` — a full Next.js admin dashboard with per-tenant auth, bookings calendar, staff management, stats, and an operator panel.
>
> This runs 5 sub-agents in sequence (with 2 in parallel). Estimated time: 20–40 minutes.
>
> Proceed?"

Wait for confirmation.

---

## Execution

Once confirmed:

```bash
echo "# Orchestrator Log — $(date)" > /home/florin/WebstormProjects/claws/workspace/ORCHESTRATOR_LOG.md
```

Then read and follow ALL instructions in:
`/home/florin/WebstormProjects/claws/nanoclaw/groups/booking_app_dev/CLAUDE.md`

Execute the full orchestration workflow: Explore → [Design + Backend in parallel] → Frontend → Testing → Synthesize.

---

## Progress Updates

After each stage completes, report to the user:

- After Agent 1: "✅ Explore done — found N endpoints, data model mapped."
- After Agent 2+3: "✅ Design + Backend done — Next.js structure designed, NestJS updated."
- After Agent 4: "✅ Frontend done — dashboard created at claws/dashboard/."
- After Agent 5: "✅ Testing done — N/M checks passed."

If any agent fails, report immediately:

> "❌ [Agent name] failed: [reason]. Attempting fix..."

---

## After Completion

Tell the user:

```
Dashboard is ready. To run it locally:

  cd /home/florin/WebstormProjects/claws/dashboard
  cp .env.local.example .env.local
  # Fill in BOOKING_API_URL, BOOKING_API_KEY, NEXTAUTH_SECRET in .env.local
  npm run dev

Open http://localhost:3000
```

Show the contents of `workspace/test-report.md` so the user can see what passed.
