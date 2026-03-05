#!/usr/bin/env python3
"""Google Drive CLI for NanoClaw agents.

Uses a service account key (GOOGLE_APPLICATION_CREDENTIALS) to authenticate.
All operations are scoped to GOOGLE_DRIVE_FOLDER_ID.

Usage:
    gdrive ls [--type TYPE]
    gdrive upload <local_path> [--name NAME] [--mime MIME]
    gdrive download <file_id> <local_path>
    gdrive search <query>
    gdrive delete <file_id>
    gdrive info <file_id>
"""

import argparse
import json
import os
import sys

from google.oauth2 import service_account
from googleapiclient.discovery import build
from googleapiclient.http import MediaFileUpload, MediaIoBaseDownload


SCOPES = [
    "https://www.googleapis.com/auth/drive",
    "https://www.googleapis.com/auth/spreadsheets",
]


def get_service():
    creds_path = os.environ.get("GOOGLE_APPLICATION_CREDENTIALS")
    if not creds_path or not os.path.exists(creds_path):
        print("Error: GOOGLE_APPLICATION_CREDENTIALS not set or file missing", file=sys.stderr)
        sys.exit(1)
    creds = service_account.Credentials.from_service_account_file(creds_path, scopes=SCOPES)
    return build("drive", "v3", credentials=creds, cache_discovery=False)


def get_sheets_service():
    creds_path = os.environ.get("GOOGLE_APPLICATION_CREDENTIALS")
    if not creds_path or not os.path.exists(creds_path):
        print("Error: GOOGLE_APPLICATION_CREDENTIALS not set or file missing", file=sys.stderr)
        sys.exit(1)
    creds = service_account.Credentials.from_service_account_file(creds_path, scopes=SCOPES)
    return build("sheets", "v4", credentials=creds, cache_discovery=False)


def get_folder_id():
    folder_id = os.environ.get("GOOGLE_DRIVE_FOLDER_ID")
    if not folder_id:
        print("Error: GOOGLE_DRIVE_FOLDER_ID not set", file=sys.stderr)
        sys.exit(1)
    return folder_id


def fmt_size(size_bytes):
    if size_bytes is None:
        return "-"
    size = int(size_bytes)
    for unit in ("B", "KB", "MB", "GB"):
        if size < 1024:
            return f"{size}{unit}"
        size //= 1024
    return f"{size}TB"


def cmd_ls(args):
    service = get_service()
    folder_id = get_folder_id()

    q = f"'{folder_id}' in parents and trashed = false"
    if args.type:
        mime_map = {
            "folder": "application/vnd.google-apps.folder",
            "doc": "application/vnd.google-apps.document",
            "sheet": "application/vnd.google-apps.spreadsheet",
            "slide": "application/vnd.google-apps.presentation",
            "pdf": "application/pdf",
        }
        mime = mime_map.get(args.type, args.type)
        q += f" and mimeType = '{mime}'"

    results = service.files().list(
        q=q,
        fields="files(id, name, mimeType, size, modifiedTime)",
        orderBy="modifiedTime desc",
        pageSize=100,
    ).execute()

    files = results.get("files", [])
    if not files:
        print("No files found.")
        return

    for f in files:
        size = fmt_size(f.get("size"))
        modified = f.get("modifiedTime", "")[:10]
        print(f"{f['id']}  {size:>8}  {modified}  {f['name']}")


def cmd_upload(args):
    service = get_service()
    folder_id = get_folder_id()

    local_path = args.local_path
    if not os.path.exists(local_path):
        print(f"Error: file not found: {local_path}", file=sys.stderr)
        sys.exit(1)

    name = args.name or os.path.basename(local_path)
    metadata = {"name": name, "parents": [folder_id]}

    mime = args.mime
    media = MediaFileUpload(local_path, mimetype=mime, resumable=True)

    created = service.files().create(
        body=metadata,
        media_body=media,
        fields="id, name, webViewLink",
    ).execute()

    print(f"Uploaded: {created['name']}")
    print(f"ID: {created['id']}")
    print(f"Link: {created.get('webViewLink', 'N/A')}")


def cmd_download(args):
    service = get_service()

    # Get file metadata to check type
    meta = service.files().get(fileId=args.file_id, fields="name, mimeType").execute()
    mime = meta.get("mimeType", "")

    # Google Docs types need export
    export_map = {
        "application/vnd.google-apps.document": ("application/pdf", ".pdf"),
        "application/vnd.google-apps.spreadsheet": ("text/csv", ".csv"),
        "application/vnd.google-apps.presentation": ("application/pdf", ".pdf"),
    }

    local_path = args.local_path
    if mime in export_map:
        export_mime, ext = export_map[mime]
        if not local_path.endswith(ext):
            local_path += ext
        request = service.files().export_media(fileId=args.file_id, mimeType=export_mime)
    else:
        request = service.files().get_media(fileId=args.file_id)

    with open(local_path, "wb") as f:
        downloader = MediaIoBaseDownload(f, request)
        done = False
        while not done:
            _, done = downloader.next_chunk()

    print(f"Downloaded: {meta['name']} -> {local_path}")


def cmd_search(args):
    service = get_service()
    folder_id = get_folder_id()

    q = f"'{folder_id}' in parents and trashed = false and fullText contains '{args.query}'"

    results = service.files().list(
        q=q,
        fields="files(id, name, mimeType, size, modifiedTime)",
        orderBy="modifiedTime desc",
        pageSize=50,
    ).execute()

    files = results.get("files", [])
    if not files:
        print(f"No files matching '{args.query}'")
        return

    for f in files:
        size = fmt_size(f.get("size"))
        modified = f.get("modifiedTime", "")[:10]
        print(f"{f['id']}  {size:>8}  {modified}  {f['name']}")


def cmd_delete(args):
    service = get_service()
    # Move to trash (not permanent delete)
    service.files().update(fileId=args.file_id, body={"trashed": True}).execute()
    print(f"Trashed: {args.file_id}")


def cmd_info(args):
    service = get_service()
    meta = service.files().get(
        fileId=args.file_id,
        fields="id, name, mimeType, size, modifiedTime, createdTime, webViewLink, owners, shared",
    ).execute()

    print(f"Name: {meta['name']}")
    print(f"ID: {meta['id']}")
    print(f"Type: {meta['mimeType']}")
    print(f"Size: {fmt_size(meta.get('size'))}")
    print(f"Created: {meta.get('createdTime', 'N/A')}")
    print(f"Modified: {meta.get('modifiedTime', 'N/A')}")
    print(f"Link: {meta.get('webViewLink', 'N/A')}")
    if meta.get("owners"):
        print(f"Owner: {meta['owners'][0].get('emailAddress', 'N/A')}")


def cmd_sheet(args):
    sheet_commands = {
        "read": cmd_sheet_read,
        "write": cmd_sheet_write,
        "append": cmd_sheet_append,
        "tabs": cmd_sheet_tabs,
    }
    sheet_commands[args.sheet_command](args)


def cmd_sheet_read(args):
    service = get_sheets_service()
    range_str = args.range or "A:ZZ"

    result = service.spreadsheets().values().get(
        spreadsheetId=args.file_id,
        range=range_str,
    ).execute()

    rows = result.get("values", [])
    if not rows:
        print("No data found.")
        return

    # Calculate column widths for aligned output
    col_widths = []
    for row in rows:
        for i, cell in enumerate(row):
            while len(col_widths) <= i:
                col_widths.append(0)
            col_widths[i] = max(col_widths[i], len(str(cell)))

    for row in rows:
        cells = [str(cell).ljust(col_widths[i]) for i, cell in enumerate(row)]
        print("  ".join(cells))


def cmd_sheet_write(args):
    service = get_sheets_service()

    # Parse values: split by comma for a single row, or JSON for multiple rows
    raw = args.values
    if raw.startswith("["):
        values = json.loads(raw)
        if values and not isinstance(values[0], list):
            values = [values]
    else:
        values = [raw.split(",")]

    service.spreadsheets().values().update(
        spreadsheetId=args.file_id,
        range=args.range,
        valueInputOption="USER_ENTERED",
        body={"values": values},
    ).execute()

    rows = len(values)
    cols = max(len(r) for r in values)
    print(f"Updated {rows} row(s) x {cols} col(s) at {args.range}")


def cmd_sheet_append(args):
    service = get_sheets_service()

    raw = args.values
    if raw.startswith("["):
        values = json.loads(raw)
        if values and not isinstance(values[0], list):
            values = [values]
    else:
        values = [raw.split(",")]

    range_str = args.range or "A:A"
    result = service.spreadsheets().values().append(
        spreadsheetId=args.file_id,
        range=range_str,
        valueInputOption="USER_ENTERED",
        insertDataOption="INSERT_ROWS",
        body={"values": values},
    ).execute()

    updated = result.get("updates", {})
    print(f"Appended {updated.get('updatedRows', len(values))} row(s) at {updated.get('updatedRange', range_str)}")


def cmd_sheet_tabs(args):
    service = get_sheets_service()
    meta = service.spreadsheets().get(
        spreadsheetId=args.file_id,
        fields="sheets.properties",
    ).execute()

    sheets = meta.get("sheets", [])
    for s in sheets:
        props = s.get("properties", {})
        rows = props.get("gridProperties", {}).get("rowCount", "?")
        cols = props.get("gridProperties", {}).get("columnCount", "?")
        print(f"  {props.get('title', 'Untitled')}  ({rows} rows x {cols} cols)  [id={props.get('sheetId')}]")


def main():
    parser = argparse.ArgumentParser(description="Google Drive CLI for NanoClaw")
    sub = parser.add_subparsers(dest="command", required=True)

    ls_p = sub.add_parser("ls", help="List files in the shared folder")
    ls_p.add_argument("--type", help="Filter by type: folder, doc, sheet, slide, pdf, or MIME type")

    up_p = sub.add_parser("upload", help="Upload a file")
    up_p.add_argument("local_path", help="Local file path")
    up_p.add_argument("--name", help="Name in Drive (default: filename)")
    up_p.add_argument("--mime", help="MIME type (auto-detected if omitted)")

    dl_p = sub.add_parser("download", help="Download a file")
    dl_p.add_argument("file_id", help="Google Drive file ID")
    dl_p.add_argument("local_path", help="Local destination path")

    se_p = sub.add_parser("search", help="Search files by content or name")
    se_p.add_argument("query", help="Search query")

    de_p = sub.add_parser("delete", help="Move a file to trash")
    de_p.add_argument("file_id", help="Google Drive file ID")

    in_p = sub.add_parser("info", help="Get file metadata")
    in_p.add_argument("file_id", help="Google Drive file ID")

    # Sheet subcommands
    sh_p = sub.add_parser("sheet", help="Read/write Google Sheets")
    sh_sub = sh_p.add_subparsers(dest="sheet_command", required=True)

    sh_read = sh_sub.add_parser("read", help="Read cells from a sheet")
    sh_read.add_argument("file_id", help="Spreadsheet ID")
    sh_read.add_argument("--range", help="A1 range (default: entire sheet)", default=None)

    sh_write = sh_sub.add_parser("write", help="Write values to cells")
    sh_write.add_argument("file_id", help="Spreadsheet ID")
    sh_write.add_argument("range", help="A1 range (e.g. A1, B2:D5, Sheet2!A1)")
    sh_write.add_argument("values", help='Comma-separated values or JSON: "a,b,c" or \'[["a","b"],["c","d"]]\'')

    sh_append = sh_sub.add_parser("append", help="Append rows to a sheet")
    sh_append.add_argument("file_id", help="Spreadsheet ID")
    sh_append.add_argument("values", help='Comma-separated values or JSON: "a,b,c" or \'[["a","b"],["c","d"]]\'')
    sh_append.add_argument("--range", help="Target range (default: A:A)", default=None)

    sh_tabs = sh_sub.add_parser("tabs", help="List sheet tabs")
    sh_tabs.add_argument("file_id", help="Spreadsheet ID")

    args = parser.parse_args()
    commands = {
        "ls": cmd_ls,
        "upload": cmd_upload,
        "download": cmd_download,
        "search": cmd_search,
        "delete": cmd_delete,
        "info": cmd_info,
        "sheet": cmd_sheet,
    }
    commands[args.command](args)


if __name__ == "__main__":
    main()
