---
name: gdrive
description: Read, write, search, and manage files in a shared Google Drive folder. Edit Google Sheets cells directly. Use for any file collaboration — uploading reports, downloading shared documents, editing spreadsheets, searching drive contents.
allowed-tools: Bash(gdrive:*)
---

# Google Drive with gdrive

## Quick start

```bash
gdrive ls                                  # List files in shared folder
gdrive upload report.pdf                   # Upload a file
gdrive download <file_id> out.pdf          # Download a file
gdrive search "quarterly report"           # Search by name or content
gdrive sheet read <spreadsheet_id>         # Read a Google Sheet
gdrive sheet write <id> A1 "hello,world"   # Write to cells
gdrive sheet append <id> "new,row,data"    # Append a row
```

## Commands

### List files

```bash
gdrive ls                   # All files in shared folder
gdrive ls --type folder     # Only folders
gdrive ls --type doc        # Google Docs
gdrive ls --type sheet      # Google Sheets
gdrive ls --type pdf        # PDFs
```

### Upload

```bash
gdrive upload report.pdf                  # Upload with original name
gdrive upload data.csv --name "Q1 Data"   # Upload with custom name
gdrive upload chart.png --mime image/png  # Explicit MIME type
```

### Download

```bash
gdrive download <file_id> report.pdf    # Download binary file
gdrive download <file_id> doc.pdf       # Google Doc → PDF
gdrive download <file_id> data.csv      # Google Sheet → CSV
```

### Search

```bash
gdrive search "meeting notes"   # Full-text search in shared folder
```

### File info

```bash
gdrive info <file_id>   # Name, type, size, dates, link
```

### Delete (trash)

```bash
gdrive delete <file_id>   # Move to trash (recoverable)
```

## Google Sheets editing

### Read a sheet

```bash
gdrive sheet read <spreadsheet_id>              # Read entire sheet
gdrive sheet read <id> --range "A1:D10"         # Read specific range
gdrive sheet read <id> --range "Sheet2!A:C"     # Read from a specific tab
```

### Write to cells

```bash
gdrive sheet write <id> A1 "hello"                          # Single cell
gdrive sheet write <id> A1 "col1,col2,col3"                 # Single row (comma-separated)
gdrive sheet write <id> A1:B2 '[["a","b"],["c","d"]]'       # Multiple rows (JSON)
gdrive sheet write <id> "Sheet2!A1" "value"                  # Write to specific tab
```

Values use `USER_ENTERED` mode — formulas (e.g. `=SUM(A1:A10)`) and number formats are interpreted.

### Append rows

```bash
gdrive sheet append <id> "name,email,status"                 # Append one row
gdrive sheet append <id> '[["a","b"],["c","d"]]'             # Append multiple rows
gdrive sheet append <id> "data" --range "Sheet2!A:A"         # Append to specific tab
```

### List tabs

```bash
gdrive sheet tabs <spreadsheet_id>   # Show all tabs with dimensions
```

## Notes

- All operations are scoped to the shared Google Drive folder
- Google Docs/Sheets/Slides are automatically exported when downloading (Docs → PDF, Sheets → CSV)
- File IDs are shown in `ls` and `search` output — use them for download/delete/info
- Upload creates files in the shared folder root
- Sheet write uses `USER_ENTERED` mode — formulas and number formats work
- Use `gdrive sheet tabs <id>` to discover tab names, then `"TabName!A1:D10"` for ranges
