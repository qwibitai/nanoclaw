# Skill: add-document-analysis

Adds automatic document analysis to NanoClaw's WhatsApp channel.
When a user sends a document attachment, NanoClaw processes it before passing the content to the agent.

## What this skill adds

- **PDF** → VLM analysis page-by-page via Qwen3-VL (max 10 pages)
- **PPTX / PPT / ODP** → LibreOffice converts to PDF, then VLM analysis (max 10 slides)
- **DOCX / DOC / ODT / XLSX / XLS / ODS / TXT / RTF / CSV** → text extraction via LibreOffice (max ~30 pages, ~50k chars)
- Content is injected into the message as `[PDF-Analyse "file": ...]`, `[Präsentation-Analyse "file": ...]`, or `[Dokument "file": ...]`
- Caption/prompt on the attachment becomes the VLM question
- Truncation warning when documents exceed the character limit

## Prerequisites

```bash
# Debian/Ubuntu
sudo apt-get install -y poppler-utils libreoffice

# macOS
brew install poppler libreoffice
```

A local VLM service compatible with the OpenAI chat completions API must be running (e.g. Qwen3-VL via vLLM or Ollama).
Set `VLM_URL` and `VLM_MODEL` env vars (defaults: `http://localhost:8089`, `qwen3-vl-8b`).

## Implementation

### 1. Add helper functions to `src/channels/whatsapp.ts`

After the `describeImageWithVLM` function, add three new functions:

**`extractOfficeText(docBuffer, mimeType, filename)`**
- Saves buffer to temp file
- Runs `libreoffice --headless --cat "<file>"` to extract text
- Truncates at 50,000 chars and appends a warning if exceeded
- Cleans up temp dir
- Returns extracted text or null

**`analysePresentationWithVLM(docBuffer, filename, userPrompt?)`**
- Saves buffer to temp file
- Runs `libreoffice --headless --convert-to pdf --outdir "<tmpdir>" "<file>"`
- Reads the resulting PDF and passes it to `analysePdfWithVLM()`
- Cleans up temp dir
- Returns VLM analysis or null

**`analysePdfWithVLM(pdfBuffer, userPrompt?)`**
- Saves buffer to temp file
- Runs `pdftoppm -png -r 150 -l 10 "<file>" "<tmpdir>/page"` (max 10 pages, 150 dpi)
- For each generated PNG: calls `describeImageWithVLM()` with the prompt
- Prefixes multi-page results with `[Seite N]`
- Cleans up temp dir
- Returns combined analysis or null

Add constant at top of file:
```typescript
const DOCUMENT_TEXT_LIMIT = 50_000;
```

### 2. Replace the document handler in `src/channels/whatsapp.ts`

In the `messages.upsert` handler, after the image/sticker block, add a document handler block:

```typescript
// Process document attachments (PDF, Office, presentations)
if (!content && normalized.documentMessage) {
  const docMsg = normalized.documentMessage;
  const filename = docMsg?.fileName || 'Dokument';
  const mime = docMsg?.mimetype || '';
  const ext = filename.split('.').pop()?.toLowerCase() || '';
  const caption = docMsg?.caption?.trim() || '';

  const isPdf = mime.includes('pdf') || ext === 'pdf';
  const isPresentation = ['pptx', 'ppt', 'odp'].includes(ext) ||
    mime.includes('presentation') || mime.includes('powerpoint');
  const isOfficeText = ['docx', 'doc', 'odt', 'xlsx', 'xls', 'ods', 'csv', 'txt', 'rtf'].includes(ext) ||
    mime.includes('word') || mime.includes('spreadsheet') || mime.includes('text');

  if (isPdf || isPresentation || isOfficeText) {
    try {
      const docBuffer = (await downloadMediaMessage(msg, 'buffer', {})) as Buffer;

      if (isPdf) {
        const result = await analysePdfWithVLM(docBuffer, caption || undefined);
        if (result) {
          content = caption
            ? `${caption}\n[PDF-Analyse "${filename}": ${result}]`
            : `[PDF-Analyse "${filename}": ${result}]`;
        }
      } else if (isPresentation) {
        const result = await analysePresentationWithVLM(docBuffer, filename, caption || undefined);
        if (result) {
          content = caption
            ? `${caption}\n[Präsentation-Analyse "${filename}": ${result}]`
            : `[Präsentation-Analyse "${filename}": ${result}]`;
        }
      } else if (isOfficeText) {
        const result = await extractOfficeText(docBuffer, mime, filename);
        if (result) {
          content = caption
            ? `${caption}\n[Dokument "${filename}": ${result}]`
            : `[Dokument "${filename}": ${result}]`;
        }
      }
    } catch (err) {
      logger.warn({ err, chatJid, filename }, 'Failed to process document');
    }
  }
}
```

### 3. Update CLAUDE.md files

Add a "Dokument-Anhänge" section to `groups/global/CLAUDE.md` (and any group-specific CLAUDE.md files):

```markdown
## Dokument-Anhänge

NanoClaw processes document attachments automatically. Content is available for the entire session.

| Format | Processing |
|--------|-----------|
| PDF | VLM (page-by-page), max 10 pages |
| PPTX, PPT, ODP | VLM via LibreOffice→PDF, max 10 slides |
| DOCX, DOC, ODT, XLSX, XLS, ODS, TXT, RTF | Text extraction, max ~30 pages |

Injected content format:
- `[PDF-Analyse "file.pdf": <content>]`
- `[Präsentation-Analyse "file.pptx": <content>]`
- `[Dokument "file.docx": <content>]`

Caption/prompt on the attachment becomes the VLM question.
Multi-page docs: `[Seite N]` prefix per page.
If truncated: warn the user and ask which section is relevant.
```

### 4. Build and restart

```bash
npm run build
systemctl --user restart nanoclaw  # Linux
# or: launchctl kickstart -k gui/$(id -u)/com.nanoclaw  # macOS
```

## Customization

- **Page limit**: Change `-l 10` in the `pdftoppm` call to increase/decrease max pages
- **Text limit**: Change `DOCUMENT_TEXT_LIMIT = 50_000` to adjust truncation threshold
- **DPI**: Change `-r 150` in the `pdftoppm` call (higher = better quality, slower)
- **VLM model**: Set `VLM_MODEL` env var
