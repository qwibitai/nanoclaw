---
name: add-telegram-attachments
description: Add photo and PDF/document attachment handling to the Telegram channel. Downloads files to the group's sources/ or attachments/ directory and delivers path references the agent can read. Includes Anthropic's official pdf skill for long-PDF extraction.
---

# Add Telegram Attachments

By default the Telegram channel stores photos and documents as placeholder text (`[Photo]`, `[Document: filename]`) — the actual files never reach the agent. This skill replaces those handlers with download-to-disk logic, adds an image-resize helper for token efficiency, and ships Anthropic's official `pdf` container skill for extracting text from long PDFs.

After installation:

- Photos are resized to 1024×1024 JPEG and saved under the group's `sources/` (wiki groups) or `attachments/` (regular groups) directory.
- Documents (PDFs, Office files, text, etc.) are saved verbatim under the same directory, preserving the original filename.
- The agent receives `[Photo: sources/tg-photo-42-….jpg]` / `[Document: sources/paper.pdf]` references and can `Read` or invoke the `pdf` skill on them.
- Files larger than Telegram's Bot API cap (20 MB) trigger a clear reply to the sender instead of silently failing.

## Phase 1: Pre-flight

### Confirm Telegram is installed

This skill modifies `src/channels/telegram.ts`. The Telegram channel must be installed first.

```bash
test -f src/channels/telegram.ts && echo "telegram installed" || echo "MISSING: run /add-telegram first"
```

### Check if already applied

```bash
test -d src/attachments && echo "already applied — skip to Phase 3" || echo "not applied"
```

## Phase 2: Apply Code Changes

### Ensure upstream remote

```bash
git remote -v
```

If `upstream` is missing, add it:

```bash
git remote add upstream https://github.com/qwibitai/nanoclaw.git
```

### Merge the skill branch

```bash
git fetch upstream skill/telegram-attachments
git merge upstream/skill/telegram-attachments || {
  git checkout --theirs package-lock.json
  git add package-lock.json
  git merge --continue
}
```

This merges in:

- `src/attachments/dir.ts` — resolves the target directory (prefers `sources/` for wiki groups, falls back to `attachments/`)
- `src/attachments/image.ts` — sharp-backed image resize + save
- `src/attachments/telegram-download.ts` — Telegram Bot API file download with size cap
- `src/attachments/*.test.ts` — unit tests
- Updated `src/channels/telegram.ts` photo + document handlers
- Updated `src/channels/telegram.test.ts` coverage
- `sharp` added to `package.json`
- `container/Dockerfile` — installs `poppler-utils`, `qpdf`, `python3`, and a venv with `pypdf`, `pdfplumber`, `reportlab`
- `container/skills/pdf/` — Anthropic's official pdf skill (vendored from [anthropics/skills](https://github.com/anthropics/skills))

If the merge reports conflicts, resolve them by reading the conflicted files and understanding the intent of both sides.

### Validate

```bash
npm install
npm run build
npx vitest run src/attachments/ src/channels/telegram.test.ts
```

All tests must pass before proceeding.

## Phase 3: Rebuild container and restart

Because this changes the container image (new system packages, Python venv, and the vendored pdf skill), a full rebuild is required. Cached layers do NOT pick up the new apt packages.

```bash
./container/build.sh
```

Restart the service:

```bash
# macOS (launchd)
launchctl kickstart -k gui/$(id -u)/com.nanoclaw

# Linux (systemd)
systemctl --user restart nanoclaw
```

## Phase 4: Verify

### Send a photo

Send a photo to your Telegram wiki (or any registered Telegram group). The agent's response should reference the file path, not the `[Photo]` placeholder. Check the group folder:

```bash
ls groups/<folder>/sources/ 2>/dev/null || ls groups/<folder>/attachments/
```

Expect a file like `tg-photo-<msgid>-<timestamp>.jpg`.

### Send a PDF

Send a PDF (≤20 MB) as a document. The agent should:
1. See the `[Document: sources/<name>.pdf]` reference in the incoming message
2. Read the file directly with its `Read` tool for short PDFs (≤10 pages)
3. Invoke the `pdf` skill for longer PDFs — that skill uses `pypdf` / `pdfplumber` / `pdftotext` to extract full text

### Check logs

```bash
tail -50 logs/nanoclaw.log | grep -i 'Telegram attachment'
```

Look for:
- `Telegram attachment downloaded` — happy path
- `Telegram attachment exceeds size cap` — oversize rejected with user reply
- `Telegram attachment download failed` — unexpected error, placeholder delivered

## Troubleshooting

### "Photo too large" reply for normal phone photos

Telegram's Bot API caps file downloads at 20 MB. Photos sent via `message:photo` are already compressed (~1–5 MB typically). If you're hitting this, check whether the user sent the file as a **document** (uncompressed) instead of as a photo.

Workaround for large files: drop them into `groups/<folder>/sources/` directly via the filesystem.

### Agent doesn't "see" the photo

The agent now has to `Read` the file explicitly. For interactive chat, remind it: "There's a photo at `sources/tg-photo-…jpg` — take a look."

For wiki-style groups, the group's CLAUDE.md should tell the agent to Read any `[Photo: …]` or `[Document: …]` reference it sees.

### pdf skill not invoked for long PDFs

The agent picks skills via description. If the agent is using `Read` and hitting the 10-page cap, point it at the `pdf` skill: "Use the pdf skill to extract the full text."

### Container build fails on apt-get

The Dockerfile adds `poppler-utils`, `qpdf`, and Python. If your base image mirror is stale, run:

```bash
docker buildx prune -f
./container/build.sh
```

### Sharp install fails

`sharp` ships prebuilt binaries for most platforms. If it fails:

```bash
npm rebuild sharp --platform=linux --arch=x64
```

## Removal

1. Revert the merged commits:
   ```bash
   git revert --no-edit <merge-commit-sha>
   ```
2. Rebuild container: `./container/build.sh`
3. Restart the service

## Design Notes

- **No agent-runner or `src/index.ts` changes.** The feature is confined to the Telegram channel plus two new helper modules and one vendored container skill. No plumbing touches core message dispatch.
- **No base64 content-block pipeline.** Photos are saved to disk and referenced by path. The agent uses `Read` to view them — matches the Claude Code norm and keeps the container surface small. For chat UX where images should be "always visible," a separate skill can add the content-block pipeline later.
- **Voice and video stay as placeholders.** Handling those requires Whisper (voice) or ffmpeg (video frames) — intentionally out of scope. A follow-up `add-telegram-voice` skill can extend this pattern.
- **Why `sources/` first, `attachments/` fallback.** Wiki groups use `sources/` as a durable artifact store per the Karpathy LLM-Wiki pattern. Non-wiki groups don't have that directory, so `attachments/` serves as a generic drop zone.
