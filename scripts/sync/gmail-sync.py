#!/usr/bin/env python3
"""Sync emails from mgandal@gmail.com to mikejg1838@gmail.com via Gmail API.

Copies new emails (since last sync) from the source account to the destination
account, preserving labels and read/unread status. Tracks sync state to avoid
duplicates.

Usage:
    python3 gmail-sync.py              # Run incremental sync
    python3 gmail-sync.py --status     # Show sync state
    python3 gmail-sync.py --full       # Full sync (last 30 days)
"""

import argparse
import base64
import json
import logging
import sys
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
STATE_FILE = SCRIPT_DIR / "gmail-sync-state.json"

SRC_EMAIL = "mgandal@gmail.com"
DST_EMAIL = "mikejg1838@gmail.com"

# Credential paths
SRC_CRED_PATHS = [
    Path.home() / ".google_workspace_mcp" / "credentials" / f"{SRC_EMAIL}.json",
    Path.home() / ".gmail-mcp" / "credentials.json",
]

DST_CRED_PATHS = [
    Path.home() / ".google_workspace_mcp" / "credentials" / f"{DST_EMAIL}.json",
    Path.home() / ".gmail-mcp" / "account2" / "credentials.json",
]

DST_OAUTH_KEYS = Path.home() / ".gmail-mcp" / "account2" / "gcp-oauth.keys.json"

# Labels to skip (system labels that shouldn't be synced)
SKIP_LABELS = {"SPAM", "TRASH", "DRAFT", "CATEGORY_PROMOTIONS", "CATEGORY_SOCIAL",
               "CATEGORY_UPDATES", "CATEGORY_FORUMS", "CATEGORY_PERSONAL"}

BATCH_SIZE = 50  # messages per batch
MAX_RESULTS = 500  # max messages per API list call

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("gmail-sync")


def load_credentials(email, cred_paths, oauth_keys_path=None):
    """Load Gmail API credentials from known locations."""
    from google.oauth2.credentials import Credentials

    for cred_path in cred_paths:
        if not cred_path.exists():
            continue

        with open(cred_path) as f:
            data = json.load(f)

        # Handle different credential formats
        token = data.get("token") or data.get("access_token")
        refresh_token = data.get("refresh_token")
        client_id = data.get("client_id")
        client_secret = data.get("client_secret")

        # If no client_id in cred file, try OAuth keys file
        if not client_id and oauth_keys_path and oauth_keys_path.exists():
            with open(oauth_keys_path) as f:
                oauth_data = json.load(f)
            installed = oauth_data.get("installed", oauth_data.get("web", {}))
            client_id = installed.get("client_id")
            client_secret = installed.get("client_secret")

        if not client_id:
            # Try the main gmail-mcp OAuth keys
            main_keys = Path.home() / ".gmail-mcp" / "gcp-oauth.keys.json"
            if main_keys.exists():
                with open(main_keys) as f:
                    oauth_data = json.load(f)
                installed = oauth_data.get("installed", oauth_data.get("web", {}))
                client_id = installed.get("client_id")
                client_secret = installed.get("client_secret")

        if not (token and refresh_token and client_id):
            continue

        creds = Credentials(
            token=token,
            refresh_token=refresh_token,
            token_uri=data.get("token_uri", "https://oauth2.googleapis.com/token"),
            client_id=client_id,
            client_secret=client_secret,
            scopes=data.get("scopes", []),
        )
        log.info("Loaded credentials for %s from %s", email, cred_path)
        return creds, cred_path

    log.error("No valid credentials found for %s", email)
    log.error("Searched: %s", ", ".join(str(p) for p in cred_paths))
    sys.exit(1)


def build_service(creds):
    """Build Gmail API service."""
    import logging as _logging
    _logging.getLogger("googleapiclient.discovery_cache").setLevel(_logging.ERROR)
    from googleapiclient.discovery import build
    return build("gmail", "v1", credentials=creds)


def load_state():
    if STATE_FILE.exists():
        with open(STATE_FILE) as f:
            return json.load(f)
    return {"last_sync_epoch": 0, "synced_ids": [], "total_synced": 0}


def save_state(state):
    tmp = STATE_FILE.with_suffix(".tmp")
    with open(tmp, "w") as f:
        json.dump(state, f, indent=2)
    tmp.replace(STATE_FILE)


def list_new_messages(src_service, after_epoch):
    """List message IDs from source account after the given epoch."""
    query = f"after:{after_epoch}" if after_epoch else ""
    all_ids = []
    page_token = None

    while True:
        kwargs = {"userId": "me", "maxResults": MAX_RESULTS, "q": query}
        if page_token:
            kwargs["pageToken"] = page_token

        results = src_service.users().messages().list(**kwargs).execute()
        messages = results.get("messages", [])
        all_ids.extend(m["id"] for m in messages)

        page_token = results.get("nextPageToken")
        if not page_token:
            break

    return all_ids


def get_raw_message(src_service, msg_id):
    """Get raw RFC822 message from source."""
    msg = src_service.users().messages().get(
        userId="me", id=msg_id, format="raw"
    ).execute()
    return msg


def import_message(dst_service, raw_b64, label_ids=None):
    """Import a raw message into destination account."""
    body = {"raw": raw_b64}
    if label_ids:
        body["labelIds"] = label_ids

    result = dst_service.users().messages().import_(
        userId="me",
        body=body,
        internalDateSource="dateHeader",
        neverMarkSpam=True,
    ).execute()
    return result


def ensure_label(dst_service, label_name, label_cache):
    """Ensure a label exists in destination, creating parents as needed."""
    if label_name in label_cache:
        return label_cache[label_name]

    parts = label_name.split("/")
    for i in range(1, len(parts) + 1):
        partial = "/".join(parts[:i])
        if partial not in label_cache:
            try:
                result = dst_service.users().labels().create(
                    userId="me",
                    body={"name": partial, "labelListVisibility": "labelShow",
                          "messageListVisibility": "show"},
                ).execute()
                label_cache[partial] = result["id"]
            except Exception as e:
                if "already exists" not in str(e).lower():
                    log.warning("Failed to create label %s: %s", partial, e)

    return label_cache.get(label_name)


def sync_messages(src_service, dst_service, state, full=False):
    """Sync new messages from source to destination."""
    # Build destination label cache
    dst_labels = dst_service.users().labels().list(userId="me").execute()
    label_cache = {l["name"]: l["id"] for l in dst_labels.get("labels", [])}

    # Build source label id→name map
    src_labels = src_service.users().labels().list(userId="me").execute()
    src_label_map = {l["id"]: l["name"] for l in src_labels.get("labels", [])}

    # Determine sync window
    if full:
        after_epoch = int((datetime.now(timezone.utc) - timedelta(days=30)).timestamp())
    elif state["last_sync_epoch"]:
        after_epoch = state["last_sync_epoch"]
    else:
        # First run: sync last 7 days
        after_epoch = int((datetime.now(timezone.utc) - timedelta(days=7)).timestamp())

    log.info("Listing messages after epoch %d (%s)...",
             after_epoch, datetime.fromtimestamp(after_epoch).isoformat())

    msg_ids = list_new_messages(src_service, after_epoch)
    synced_set = set(state.get("synced_ids", []))
    new_ids = [mid for mid in msg_ids if mid not in synced_set]

    log.info("Found %d messages, %d new to sync", len(msg_ids), len(new_ids))

    if not new_ids:
        state["last_sync_epoch"] = int(datetime.now(timezone.utc).timestamp())
        save_state(state)
        return [], state

    synced_messages = []
    errors = 0

    for i, msg_id in enumerate(new_ids):
        try:
            # Get raw message from source
            raw_msg = get_raw_message(src_service, msg_id)
            raw_b64 = raw_msg.get("raw", "")

            # Map source labels to destination
            src_label_ids = raw_msg.get("labelIds", [])
            dst_label_ids = []
            for lid in src_label_ids:
                label_name = src_label_map.get(lid, "")
                if label_name in SKIP_LABELS or label_name.startswith("CATEGORY_"):
                    continue
                if label_name == "INBOX":
                    continue  # Don't put in inbox
                if label_name == "UNREAD":
                    dst_label_ids.append("UNREAD")
                    continue
                if label_name == "SENT":
                    continue
                if label_name == "STARRED":
                    dst_label_ids.append("STARRED")
                    continue
                # Custom labels: prefix with source account
                if label_name and not label_name.startswith("IMPORTANT"):
                    prefixed = f"mgandal/{label_name}"
                    label_id = ensure_label(dst_service, prefixed, label_cache)
                    if label_id:
                        dst_label_ids.append(label_id)

            # Ensure base label exists
            base_label_id = ensure_label(dst_service, "mgandal", label_cache)
            if base_label_id:
                dst_label_ids.append(base_label_id)

            # Import to destination
            import_message(dst_service, raw_b64, dst_label_ids if dst_label_ids else None)

            synced_set.add(msg_id)
            synced_messages.append(msg_id)

            if (i + 1) % 10 == 0:
                log.info("  Synced %d/%d messages", i + 1, len(new_ids))
                # Save state periodically (don't update total_synced here, only at end)
                state["synced_ids"] = list(synced_set)[-5000:]
                save_state(state)

        except Exception as e:
            error_str = str(e).lower()
            if any(kw in error_str for kw in ["quota", "rate limit", "too many"]):
                log.warning("Rate limit hit after %d messages. Saving state.", i)
                break
            log.warning("  Failed to sync message %s: %s", msg_id, e)
            errors += 1
            if errors > 20:
                log.error("Too many errors (%d), stopping", errors)
                break

    # Update state
    state["synced_ids"] = list(synced_set)[-5000:]
    state["last_sync_epoch"] = int(datetime.now(timezone.utc).timestamp())
    state["total_synced"] = state.get("total_synced", 0) + len(synced_messages)
    state["last_run"] = datetime.now(timezone.utc).isoformat()
    save_state(state)

    log.info("Synced %d messages (%d errors)", len(synced_messages), errors)
    return synced_messages, state


def main():
    parser = argparse.ArgumentParser(description="Sync Gmail: mgandal → mikejg1838")
    parser.add_argument("--status", action="store_true", help="Show sync state")
    parser.add_argument("--full", action="store_true", help="Full sync (last 30 days)")
    args = parser.parse_args()

    state = load_state()

    if args.status:
        print(f"Last sync: {state.get('last_run', 'never')}")
        print(f"Total synced: {state.get('total_synced', 0)}")
        print(f"Tracked IDs: {len(state.get('synced_ids', []))}")
        return

    log.info("Starting Gmail sync: %s → %s", SRC_EMAIL, DST_EMAIL)

    src_creds, _ = load_credentials(SRC_EMAIL, SRC_CRED_PATHS)
    dst_creds, _ = load_credentials(DST_EMAIL, DST_CRED_PATHS, DST_OAUTH_KEYS)

    src_service = build_service(src_creds)
    dst_service = build_service(dst_creds)

    synced, state = sync_messages(src_service, dst_service, state, full=args.full)

    # Output synced message info as JSON for SimpleMem ingest
    if synced:
        summaries = []
        for msg_id in synced[:100]:  # Cap at 100 for SimpleMem
            try:
                msg = src_service.users().messages().get(
                    userId="me", id=msg_id, format="metadata",
                    metadataHeaders=["Subject", "From", "Date", "To"]
                ).execute()
                headers = {h["name"]: h["value"] for h in msg.get("payload", {}).get("headers", [])}
                summaries.append({
                    "id": msg_id,
                    "subject": headers.get("Subject", ""),
                    "from": headers.get("From", ""),
                    "to": headers.get("To", ""),
                    "date": headers.get("Date", ""),
                    "snippet": msg.get("snippet", ""),
                })
            except Exception:
                pass

        # Write summaries for SimpleMem ingest
        summaries_file = SCRIPT_DIR / "gmail-sync-latest.json"
        with open(summaries_file, "w") as f:
            json.dump(summaries, f, indent=2)
        log.info("Wrote %d message summaries to %s", len(summaries), summaries_file)


if __name__ == "__main__":
    main()
