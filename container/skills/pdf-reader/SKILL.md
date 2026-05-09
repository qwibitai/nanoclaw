# PDF Reader

Extract text from PDF files using `pdftotext` and get PDF metadata using `pdfinfo`.

## Usage

```bash
# Extract text from a local PDF
pdf-reader extract <path>

# Get PDF metadata (pages, title, author, etc.)
pdf-reader info <path>

# Download a PDF from a URL and extract text
pdf-reader fetch <url>
```

## Examples

```bash
# Read a PDF that was sent as an attachment
pdf-reader extract attachments/report.pdf

# Get page count and metadata
pdf-reader info attachments/report.pdf

# Fetch and read a PDF from the web
pdf-reader fetch https://example.com/document.pdf
```

## Notes

- Works with text-based PDFs. Scanned/image-based PDFs will return empty text.
- For image-based PDFs, use the agent-browser to open the file visually instead.
- Downloaded attachments from Telegram are saved in `attachments/` in the group workspace.
