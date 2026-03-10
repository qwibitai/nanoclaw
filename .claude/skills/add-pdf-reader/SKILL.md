---
name: add-pdf-reader
description: Add PDF reading to NanoClaw agents. Extracts text from PDFs via pdftotext CLI. Handles WhatsApp attachments, URLs, and local files.
---

# Add PDF Reader

Adds PDF reading capability to all container agents using poppler-utils (pdftotext/pdfinfo). PDFs sent as WhatsApp attachments are auto-downloaded to the group workspace.

## Phase 1: Pre-flight

1. Check if `container/skills/pdf-reader/pdf-reader` exists — skip to Phase 3 if already applied
2. Confirm WhatsApp is installed first (`skill/whatsapp` merged). This skill modifies WhatsApp channel files.

## Phase 2: Apply Code Changes

### Ensure WhatsApp fork remote

```bash
git remote -v
```

If `whatsapp` is missing, add it:

```bash
git remote add whatsapp https://github.com/qwibitai/nanoclaw-whatsapp.git
```

### Merge the skill branch

```bash
git fetch whatsapp skill/pdf-reader
git merge whatsapp/skill/pdf-reader
```

This merges in:

- `container/skills/pdf-reader/SKILL.md` (agent-facing documentation)
- `container/skills/pdf-reader/pdf-reader` (CLI script)
- `poppler-utils` in `container/Dockerfile`
- PDF attachment download in `src/channels/whatsapp.ts`
- PDF tests in `src/channels/whatsapp.test.ts`

If the merge reports conflicts, resolve them by reading the conflicted files and understanding the intent of both sides.

### Validate

```bash
npm run build
npx vitest run src/channels/whatsapp.test.ts
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
