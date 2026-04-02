---
name: doc-reader
description: Read Office documents and common file types sent as Telegram attachments. When a message contains [Document: filename → /workspace/group/attachments/filename], use this skill to extract the text content. Supports Word (docx), Excel (xlsx), PowerPoint (pptx), CSV, plain text, and more.
allowed-tools: Bash(doc-reader:*)
---

# Reading Document Attachments

When a user sends a document via Telegram, it is automatically downloaded and the message contains a reference like:

```
[Document: report.docx → /workspace/group/attachments/report.docx]
```

Use the `doc-reader` command to extract the text:

```bash
doc-reader /workspace/group/attachments/report.docx
```

## Supported formats

| Extension | Format |
|-----------|--------|
| `.docx`, `.doc`, `.odt`, `.rtf` | Word-compatible documents |
| `.xlsx`, `.xls`, `.ods` | Spreadsheets (outputs CSV per sheet) |
| `.pptx`, `.ppt`, `.odp` | Presentations (slide text + speaker notes) |
| `.csv`, `.txt`, `.md` | Plain text (returned as-is) |

## Workflow

1. Spot the attachment reference in the message: `[Document: name → path]`
2. Run `doc-reader <path>` to get the text
3. Read, summarize, answer questions, or act on the content

## Error handling

- **Unsupported type** — exit code 1 with a list of supported formats. Tell the user which types are supported.
- **File not found** — the download may have failed. Check the original message for a "download failed" notice.
- **Spreadsheet with no text** — the file may contain only numbers or be empty. Report what you find.
