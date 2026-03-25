#!/usr/bin/env python3
"""
notion skill — Notion API client
Read/write pages, query databases, search workspace.

Usage:
  python3 notion.py search "my notes"
  python3 notion.py get-page <page_id>
  python3 notion.py get-db <db_id>
  python3 notion.py query-db <db_id> [--filter '{"property":"Status","select":{"equals":"Done"}}']
  python3 notion.py create-page <parent_page_id> --title "Title" --content "Body text"
  python3 notion.py append <page_id> --content "New paragraph"
  python3 notion.py update-title <page_id> --title "New Title"
  python3 notion.py list-dbs
"""

import os
import sys
import json
import argparse
import urllib.request
import urllib.error
from datetime import datetime

API_BASE = "https://api.notion.com/v1"
NOTION_VERSION = "2022-06-28"


def get_token():
    token = os.environ.get("NOTION_TOKEN", "")
    if not token:
        print("Error: NOTION_TOKEN env var not set", file=sys.stderr)
        sys.exit(1)
    return token


def headers():
    return {
        "Authorization": f"Bearer {get_token()}",
        "Notion-Version": NOTION_VERSION,
        "Content-Type": "application/json",
    }


def api(method, path, body=None):
    url = f"{API_BASE}{path}"
    data = json.dumps(body).encode() if body else None
    req = urllib.request.Request(url, data=data, headers=headers(), method=method)
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            return json.loads(r.read())
    except urllib.error.HTTPError as e:
        err = json.loads(e.read())
        print(f"Notion API error {e.code}: {err.get('message', e.reason)}", file=sys.stderr)
        sys.exit(1)


def extract_text(rich_text_arr):
    """Flatten a rich_text array to a plain string."""
    return "".join(t.get("plain_text", "") for t in (rich_text_arr or []))


def page_title(page):
    """Extract title from a page object."""
    props = page.get("properties", {})
    for prop in props.values():
        if prop.get("type") == "title":
            return extract_text(prop.get("title", []))
    return "(untitled)"


def blocks_to_text(blocks, indent=0):
    """Convert block list to readable plain text."""
    lines = []
    prefix = "  " * indent
    for b in blocks:
        btype = b.get("type", "")
        content = b.get(btype, {})
        text = extract_text(content.get("rich_text", []))
        if btype in ("paragraph", "quote"):
            if text:
                lines.append(f"{prefix}{text}")
        elif btype.startswith("heading_"):
            level = int(btype[-1])
            lines.append(f"\n{prefix}{'#' * level} {text}")
        elif btype in ("bulleted_list_item", "numbered_list_item", "to_do"):
            checked = "✅" if content.get("checked") else "☐"
            marker = checked if btype == "to_do" else "•"
            lines.append(f"{prefix}{marker} {text}")
        elif btype == "code":
            lang = content.get("language", "")
            lines.append(f"{prefix}```{lang}\n{prefix}{text}\n{prefix}```")
        elif btype == "divider":
            lines.append(f"{prefix}---")
        elif btype == "callout":
            emoji = content.get("icon", {}).get("emoji", "")
            lines.append(f"{prefix}{emoji} {text}")
        elif btype == "child_page":
            lines.append(f"{prefix}📄 {content.get('title', '(child page)')}")
        elif btype == "child_database":
            lines.append(f"{prefix}🗄️ {content.get('title', '(database)')}")
        # Recurse into children if present
        if b.get("has_children"):
            children = api("GET", f"/blocks/{b['id']}/children")
            lines.extend(blocks_to_text(children.get("results", []), indent + 1))
    return lines


def cmd_search(args):
    body = {"query": args.query, "page_size": args.limit}
    if args.type:
        body["filter"] = {"value": args.type, "property": "object"}
    data = api("POST", "/search", body)
    results = data.get("results", [])
    if not results:
        print("No results found.")
        return
    for r in results:
        obj = r.get("object")
        rid = r["id"]
        if obj == "page":
            title = page_title(r)
            url = r.get("url", "")
            print(f"📄 {title}\n   id: {rid}\n   {url}\n")
        elif obj == "database":
            title = extract_text(r.get("title", []))
            url = r.get("url", "")
            print(f"🗄️  {title}\n   id: {rid}\n   {url}\n")


def cmd_get_page(args):
    page = api("GET", f"/pages/{args.page_id}")
    title = page_title(page)
    url = page.get("url", "")
    created = page.get("created_time", "")[:10]
    edited = page.get("last_edited_time", "")[:10]
    print(f"# {title}")
    print(f"URL: {url}")
    print(f"Created: {created}  |  Last edited: {edited}\n")
    # Fetch and render content blocks
    blocks = api("GET", f"/blocks/{args.page_id}/children")
    lines = blocks_to_text(blocks.get("results", []))
    print("\n".join(lines))


def cmd_list_dbs(args):
    data = api("POST", "/search", {"filter": {"value": "database", "property": "object"}, "page_size": 20})
    for db in data.get("results", []):
        title = extract_text(db.get("title", []))
        print(f"🗄️  {title}  —  {db['id']}\n   {db.get('url','')}\n")


def cmd_get_db(args):
    db = api("GET", f"/databases/{args.db_id}")
    title = extract_text(db.get("title", []))
    props = list(db.get("properties", {}).keys())
    print(f"Database: {title}")
    print(f"ID: {args.db_id}")
    print(f"Properties: {', '.join(props)}\n")


def cmd_query_db(args):
    body = {"page_size": args.limit}
    if args.filter:
        body["filter"] = json.loads(args.filter)
    if args.sort_by:
        body["sorts"] = [{"property": args.sort_by, "direction": args.direction}]
    data = api("POST", f"/databases/{args.db_id}/query", body)
    results = data.get("results", [])
    print(f"{len(results)} rows:\n")
    for page in results:
        title = page_title(page)
        pid = page["id"]
        props = page.get("properties", {})
        # Print non-title properties as key: value
        extras = []
        for name, prop in props.items():
            ptype = prop.get("type")
            if ptype == "title":
                continue
            elif ptype == "select":
                val = (prop.get("select") or {}).get("name", "")
            elif ptype == "multi_select":
                val = ", ".join(s["name"] for s in prop.get("multi_select", []))
            elif ptype == "rich_text":
                val = extract_text(prop.get("rich_text", []))
            elif ptype == "number":
                val = prop.get("number", "")
            elif ptype == "checkbox":
                val = "✅" if prop.get("checkbox") else "☐"
            elif ptype == "date":
                val = (prop.get("date") or {}).get("start", "")
            elif ptype == "status":
                val = (prop.get("status") or {}).get("name", "")
            else:
                continue
            if val:
                extras.append(f"{name}: {val}")
        extra_str = "  |  ".join(extras)
        print(f"• {title}  [{pid[:8]}...]")
        if extra_str:
            print(f"  {extra_str}")
    if data.get("has_more"):
        print(f"\n(more results available — use --limit to increase)")


def cmd_create_page(args):
    body = {
        "parent": {"page_id": args.parent_id},
        "properties": {
            "title": {"title": [{"text": {"content": args.title}}]}
        }
    }
    if args.content:
        body["children"] = [
            {
                "object": "block",
                "type": "paragraph",
                "paragraph": {"rich_text": [{"text": {"content": args.content}}]}
            }
        ]
    page = api("POST", "/pages", body)
    print(f"Created: {page_title(page)}")
    print(f"ID: {page['id']}")
    print(f"URL: {page.get('url', '')}")


def cmd_append(args):
    blocks = []
    if args.heading:
        blocks.append({
            "object": "block", "type": "heading_2",
            "heading_2": {"rich_text": [{"text": {"content": args.heading}}]}
        })
    if args.content:
        for para in args.content.split("\\n"):
            blocks.append({
                "object": "block", "type": "paragraph",
                "paragraph": {"rich_text": [{"text": {"content": para}}]}
            })
    if args.bullet:
        for item in args.bullet:
            blocks.append({
                "object": "block", "type": "bulleted_list_item",
                "bulleted_list_item": {"rich_text": [{"text": {"content": item}}]}
            })
    if not blocks:
        print("Nothing to append — provide --content, --heading, or --bullet")
        return
    result = api("PATCH", f"/blocks/{args.page_id}/children", {"children": blocks})
    print(f"Appended {len(blocks)} block(s) to page {args.page_id}")


def cmd_update_title(args):
    body = {"properties": {"title": {"title": [{"text": {"content": args.title}}]}}}
    page = api("PATCH", f"/pages/{args.page_id}", body)
    print(f"Updated: {page_title(page)}")
    print(f"URL: {page.get('url', '')}")


def main():
    parser = argparse.ArgumentParser(description="Notion API client")
    sub = parser.add_subparsers(dest="command")

    p = sub.add_parser("search", help="Search pages and databases")
    p.add_argument("query")
    p.add_argument("--type", choices=["page", "database"], help="Filter by object type")
    p.add_argument("--limit", type=int, default=10)

    p = sub.add_parser("get-page", help="Read a page and its content")
    p.add_argument("page_id")

    p = sub.add_parser("list-dbs", help="List all accessible databases")

    p = sub.add_parser("get-db", help="Get database schema/properties")
    p.add_argument("db_id")

    p = sub.add_parser("query-db", help="Query rows from a database")
    p.add_argument("db_id")
    p.add_argument("--filter", help='JSON filter e.g. \'{"property":"Status","select":{"equals":"Done"}}\'')
    p.add_argument("--sort-by", help="Property name to sort by")
    p.add_argument("--direction", choices=["ascending", "descending"], default="descending")
    p.add_argument("--limit", type=int, default=20)

    p = sub.add_parser("create-page", help="Create a new page")
    p.add_argument("parent_id", help="Parent page ID")
    p.add_argument("--title", required=True)
    p.add_argument("--content", help="Initial paragraph text")

    p = sub.add_parser("append", help="Append blocks to a page")
    p.add_argument("page_id")
    p.add_argument("--content", help="Paragraph text (use \\n for multiple paragraphs)")
    p.add_argument("--heading", help="H2 heading to prepend")
    p.add_argument("--bullet", nargs="+", help="Bullet list items")

    p = sub.add_parser("update-title", help="Update a page title")
    p.add_argument("page_id")
    p.add_argument("--title", required=True)

    args = parser.parse_args()
    dispatch = {
        "search": cmd_search, "get-page": cmd_get_page,
        "list-dbs": cmd_list_dbs, "get-db": cmd_get_db,
        "query-db": cmd_query_db, "create-page": cmd_create_page,
        "append": cmd_append, "update-title": cmd_update_title,
    }
    if args.command not in dispatch:
        parser.print_help()
        sys.exit(1)
    dispatch[args.command](args)


if __name__ == "__main__":
    main()
