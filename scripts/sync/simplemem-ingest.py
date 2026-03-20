#!/usr/bin/env python3
"""Feed new email summaries into SimpleMem for long-term agent memory.

Reads the gmail-sync-latest.json and email-migrate-latest.json files
produced by the sync scripts, formats them as conversation snippets,
and stores them in SimpleMem via its MCP API.

Usage:
    python3 simplemem-ingest.py
"""

import json
import logging
import os
import sys
import time
import uuid
from pathlib import Path

import requests

SCRIPT_DIR = Path(__file__).resolve().parent

# SimpleMem connection (read from nanoclaw .env)
NANOCLAW_DIR = SCRIPT_DIR.parent.parent
ENV_FILE = NANOCLAW_DIR / ".env"

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("simplemem-ingest")


def load_simplemem_config():
    """Parse SIMPLEMEM_URL from nanoclaw .env to get host, port, and token."""
    if not ENV_FILE.exists():
        log.error("No .env file at %s", ENV_FILE)
        sys.exit(1)

    simplemem_url = None
    with open(ENV_FILE) as f:
        for line in f:
            line = line.strip()
            if line.startswith("SIMPLEMEM_URL="):
                simplemem_url = line.split("=", 1)[1].strip()
                break

    if not simplemem_url:
        log.error("SIMPLEMEM_URL not found in .env")
        sys.exit(1)

    from urllib.parse import urlparse, parse_qs
    parsed = urlparse(simplemem_url)
    token = parse_qs(parsed.query).get("token", [""])[0]
    base_url = f"{parsed.scheme}://{parsed.hostname}:{parsed.port}/mcp"

    return base_url, token


def create_session(base_url, token):
    """Initialize MCP session and return session ID."""
    headers = {
        "Content-Type": "application/json",
        "Accept": "application/json, text/event-stream",
        "Authorization": f"Bearer {token}",
    }

    resp = requests.post(base_url, headers=headers, json={
        "jsonrpc": "2.0",
        "id": 1,
        "method": "initialize",
        "params": {
            "protocolVersion": "2024-11-05",
            "capabilities": {},
            "clientInfo": {"name": "simplemem-ingest", "version": "1.0"},
        },
    })

    session_id = resp.headers.get("Mcp-Session-Id")
    return session_id, headers


def call_tool(base_url, headers, session_id, tool_name, arguments, call_id=2):
    """Call a SimpleMem MCP tool."""
    hdrs = {**headers, "Mcp-Session-Id": session_id}
    resp = requests.post(base_url, headers=hdrs, json={
        "jsonrpc": "2.0",
        "id": call_id,
        "method": "tools/call",
        "params": {"name": tool_name, "arguments": arguments},
    })

    # Parse SSE response
    text = resp.text
    for line in text.split("\n"):
        if line.startswith("data: "):
            try:
                return json.loads(line[6:])
            except json.JSONDecodeError:
                pass

    # Try direct JSON
    try:
        return resp.json()
    except Exception:
        return {"error": text[:200]}


def format_email_for_memory(email_info):
    """Format an email summary as a conversation for SimpleMem."""
    subject = email_info.get("subject", "(no subject)")
    sender = email_info.get("from", "unknown")
    date = email_info.get("date", "")
    snippet = email_info.get("snippet", "")
    to = email_info.get("to", "")

    # Build a natural conversation format that SimpleMem can extract facts from
    text = f"Email received on {date}. From: {sender}. To: {to}. Subject: {subject}. Preview: {snippet}"
    return text


def ingest_emails(summaries_file, base_url, token, source_label):
    """Ingest email summaries into SimpleMem."""
    if not summaries_file.exists():
        log.info("No summaries file at %s, skipping", summaries_file)
        return 0

    with open(summaries_file) as f:
        summaries = json.load(f)

    if not summaries:
        log.info("No new emails to ingest from %s", summaries_file)
        return 0

    log.info("Ingesting %d emails from %s into SimpleMem...", len(summaries), source_label)

    session_id, headers = create_session(base_url, token)
    if not session_id:
        log.error("Failed to create SimpleMem session")
        return 0

    # Send notifications/initialized
    call_tool(base_url, {**headers, "Mcp-Session-Id": session_id}, session_id,
              "memory_stats", {}, call_id=99)

    ingested = 0
    # Batch emails into groups of 5 for memory_add_batch
    batch = []
    for i, email_info in enumerate(summaries):
        text = format_email_for_memory(email_info)
        batch.append(text)

        if len(batch) >= 5 or i == len(summaries) - 1:
            # Use memory_add for each (memory_add_batch may not exist)
            for msg_text in batch:
                try:
                    result = call_tool(
                        base_url, headers, session_id,
                        "memory_add",
                        {"content": msg_text},
                        call_id=100 + ingested,
                    )
                    if result and not result.get("error"):
                        ingested += 1
                    else:
                        log.warning("SimpleMem returned error: %s", result)
                except Exception as e:
                    log.warning("Failed to add memory: %s", e)

            batch = []

            if ingested > 0 and ingested % 20 == 0:
                log.info("  Ingested %d/%d emails", ingested, len(summaries))
                time.sleep(1)  # Rate limit

    log.info("Ingested %d emails from %s", ingested, source_label)

    # Only delete summaries file if at least some emails were ingested
    # Otherwise keep for retry on next run
    if ingested > 0:
        summaries_file.unlink()
    elif len(summaries) > 0:
        log.warning("No emails ingested, keeping %s for retry", summaries_file)

    return ingested


def main():
    base_url, token = load_simplemem_config()

    total = 0

    # Ingest Gmail sync summaries
    gmail_file = SCRIPT_DIR / "gmail-sync-latest.json"
    total += ingest_emails(gmail_file, base_url, token, "mgandal@gmail.com")

    # Ingest Exchange email sync summaries (if email-migrate produces them)
    exchange_file = SCRIPT_DIR / "exchange-sync-latest.json"
    total += ingest_emails(exchange_file, base_url, token, "Exchange/Outlook")

    log.info("Total emails ingested into SimpleMem: %d", total)


if __name__ == "__main__":
    main()
