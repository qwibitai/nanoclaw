---
name: add-pdf-reader
description: Add PDF reading to NanoClaw agents. Extracts text from PDFs via pdftotext CLI. Handles WhatsApp attachments, URLs, and local files.
---

# Add PDF Reader

Adds PDF reading capability to all container agents using poppler-utils (pdftotext/pdfinfo). PDFs sent as WhatsApp attachments are auto-downloaded to the group workspace.

## Phase 1: Pre-flight

### Check if already applied

Read `.nanoclaw/state.yaml`. If `add-pdf-reader` is in `applied_skills`, skip to Phase 3 (Verify).

## Phase 2: Apply Code Changes

### Initialize skills system (if needed)

If `.nanoclaw/` directory doesn't exist:

```bash
npx tsx scripts/apply-skill.ts --init
```

### Apply the skill

```bash
npx tsx scripts/apply-skill.ts .claude/skills/add-pdf-reader
```

This deterministically:
- Adds `container/skills/pdf-reader/SKILL.md` (agent-facing documentation)
- Adds `container/skills/pdf-reader/pdf-reader` (CLI script)
- Three-way merges `poppler-utils` + COPY into `container/Dockerfile`
- Three-way merges PDF attachment download into `src/channels/whatsapp.ts`
- Three-way merges PDF tests into `src/channels/whatsapp.test.ts`
- Records application in `.nanoclaw/state.yaml`

If merge conflicts occur, read the intent files:
- `modify/container/Dockerfile.intent.md`
- `modify/src/channels/whatsapp.ts.intent.md`
- `modify/src/channels/whatsapp.test.ts.intent.md`

### Validate

```bash
npm test
npm run build
```

### Rebuild container

```bash
./container/build.sh
```

### Restart service

```bash
launchctl kickstart -k gui/$(id -u)/com.nanoclaw  # macOS
# Linux: systemctl --user restart nanoclaw
```

## Phase 3: Verify

### Test PDF extraction

Send a PDF file in any registered WhatsApp chat. The agent should:
1. Download the PDF to `attachments/`
2. Respond acknowledging the PDF
3. Be able to extract text when asked

### Test URL fetching

Ask the agent to read a PDF from a URL. It should use `pdf-reader fetch <url>`.

### Check logs if needed

```bash
tail -f logs/nanoclaw.log | grep -i pdf
```

Look for:
- `Downloaded PDF attachment` — successful download
- `Failed to download PDF attachment` — media download issue

## Troubleshooting

### Agent says pdf-reader command not found

Container needs rebuilding. Run `./container/build.sh` and restart the service.

### PDF text extraction is empty

The PDF may be scanned (image-based). pdftotext only handles text-based PDFs. Consider using the agent-browser to open the PDF visually instead.

### WhatsApp PDF not detected

Verify the message has `documentMessage` with `mimetype: application/pdf`. Some file-sharing apps send PDFs as generic files without the correct mimetype.
