#!/usr/bin/env python3
"""Refresh Google OAuth tokens for all NanoClaw Gmail accounts.

Reads ~/.gmail-mcp{,-jonathan,-attaxion,-dev}/credentials.json, checks if
the access_token is within REFRESH_THRESHOLD_SECONDS of expiry, and if so
exchanges the refresh_token for a new access_token via Google's OAuth2
endpoint.

Exit codes:
  0  All accounts checked, none required refresh OR all refreshes succeeded
  2  At least one credentials.json missing (account not yet authorized)
  3  At least one refresh attempt failed (network, revoked token, etc.)

Designed to be safe to call before every email-intelligence container spawn:
fast (<1s when nothing needs refresh), idempotent, and never destructive.
"""

import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

HOME = Path.home()
ACCOUNTS = [
    ("personal", HOME / ".gmail-mcp"),
    ("jonathan", HOME / ".gmail-mcp-jonathan"),
    ("attaxion", HOME / ".gmail-mcp-attaxion"),
    ("dev",      HOME / ".gmail-mcp-dev"),
]
REFRESH_THRESHOLD_SECONDS = 5 * 60  # refresh if expiring within 5 minutes
GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token"
NETWORK_RETRY_DELAY_SECONDS = 1.0  # single retry on transient network failure


def cleanup_orphan_tmp_files(account_dir: Path) -> None:
    """Remove stale credentials.json.tmp.<pid> files from crashed prior runs.

    The refresh_token() path writes atomically via tmpfile + os.replace and
    unlinks the tmp in a finally block, but a SIGKILL between the write and
    the finally can still leak a tmp file. Clean them up at the start of
    each run so they don't accumulate indefinitely in the credentials dir.
    """
    try:
        for orphan in account_dir.glob("credentials.json.tmp.*"):
            try:
                orphan.unlink(missing_ok=True)
            except OSError:
                pass
    except OSError:
        # account_dir may not exist yet — caller handles that separately
        pass


def _is_transient_network_error(exc: Exception) -> bool:
    """Classify a urlopen exception as transient (worth retrying) or permanent.

    Permanent errors (like invalid_grant) come back as HTTPError with a 4xx
    status and should NOT be retried — they require manual re-auth. Transient
    errors (DNS blips, 5xx, connection resets, timeouts) are worth a single
    retry because Google's token endpoint is rate-limit tolerant of single
    duplicate refreshes and the alternative is a noisy exit 3 for a 0.1%
    blip that would have resolved on its own.
    """
    if isinstance(exc, urllib.error.HTTPError):
        # 4xx = permanent (bad request, invalid_grant, etc.)
        # 5xx = transient (server error)
        return exc.code >= 500
    if isinstance(exc, urllib.error.URLError):
        return True  # DNS / connection / socket errors
    if isinstance(exc, TimeoutError):
        return True
    return False


def needs_refresh(creds: dict) -> bool:
    """Return True if access_token will expire within REFRESH_THRESHOLD_SECONDS."""
    expiry_ms = creds.get("expiry_date")
    if not expiry_ms:
        return True
    now_ms = int(time.time() * 1000)
    return (expiry_ms - now_ms) / 1000 <= REFRESH_THRESHOLD_SECONDS


def load_oauth_keys(account_dir: Path) -> dict | None:
    """Load gcp-oauth.keys.json (client_id + client_secret needed for refresh)."""
    keys_file = account_dir / "gcp-oauth.keys.json"
    if not keys_file.exists():
        return None
    data = json.loads(keys_file.read_text())
    # Google's OAuth client config wraps credentials in {"installed": {...}} or {"web": {...}}
    for wrapper in ("installed", "web"):
        if wrapper in data:
            return data[wrapper]
    return data


def refresh_token(account: str, account_dir: Path) -> tuple[str, str]:
    """Refresh the access token for one account.

    Returns (status, message) where status is "ok" | "missing" | "error".
    """
    # Opportunistic cleanup of orphan tmp files from any prior crashed run.
    cleanup_orphan_tmp_files(account_dir)

    creds_file = account_dir / "credentials.json"
    if not creds_file.exists():
        return ("missing", f"{account}: no credentials.json (not authorized)")

    creds = json.loads(creds_file.read_text())
    if not needs_refresh(creds):
        expiry_min = (creds["expiry_date"] - int(time.time() * 1000)) / 1000 / 60
        return ("ok", f"{account}: token valid for {expiry_min:.0f} more min")

    keys = load_oauth_keys(account_dir)
    if not keys:
        return ("error", f"{account}: gcp-oauth.keys.json missing or malformed")

    refresh = creds.get("refresh_token")
    if not refresh:
        return ("error", f"{account}: no refresh_token — re-auth required")

    body = urllib.parse.urlencode({
        "client_id": keys["client_id"],
        "client_secret": keys["client_secret"],
        "refresh_token": refresh,
        "grant_type": "refresh_token",
    }).encode()
    req = urllib.request.Request(
        GOOGLE_TOKEN_URL,
        data=body,
        headers={"Content-Type": "application/x-www-form-urlencoded"},
    )
    # Single retry on transient network failures. Google's OAuth token endpoint
    # has excellent uptime, but DNS blips and 5xx happen. A single 1s-delayed
    # retry prevents most spurious "error" outputs without inflating the
    # happy-path latency (retries only fire on actual failures).
    new = None
    last_err: Exception | None = None
    for attempt in range(2):
        try:
            with urllib.request.urlopen(req, timeout=10) as resp:
                new = json.loads(resp.read())
            break
        except Exception as e:
            last_err = e
            if attempt == 0 and _is_transient_network_error(e):
                time.sleep(NETWORK_RETRY_DELAY_SECONDS)
                continue
            # permanent error (4xx, invalid_grant, malformed JSON) or final attempt
            return (
                "error",
                f"{account}: refresh failed - {type(e).__name__}: {e}",
            )
    if new is None:
        # Shouldn't be reachable — both attempts either break with `new` set
        # or return early — but defensive fallback to make the type checker
        # and any future refactor happy.
        return (
            "error",
            f"{account}: refresh failed - {type(last_err).__name__ if last_err else 'Unknown'}: {last_err}",
        )

    creds["access_token"] = new["access_token"]
    # Google returns expires_in (seconds); convert to absolute ms
    creds["expiry_date"] = int(time.time() * 1000) + (new.get("expires_in", 3600) * 1000)
    if "scope" in new:
        creds["scope"] = new["scope"]
    # Google may rotate the refresh_token on certain refreshes; persist the new
    # one if present, otherwise next refresh fails with invalid_grant.
    if "refresh_token" in new:
        creds["refresh_token"] = new["refresh_token"]

    # Preserve the original file's mode (OAuth creds should stay 0600). The
    # tmp file would otherwise inherit the umask-default (typically 0644).
    try:
        orig_mode = creds_file.stat().st_mode & 0o777
    except FileNotFoundError:
        orig_mode = 0o600

    # Atomic write: tmpfile + rename, so a crash mid-write can't corrupt creds.
    # PID-suffix the tmp filename so concurrent invocations don't collide.
    tmp = creds_file.parent / f"{creds_file.name}.tmp.{os.getpid()}"
    try:
        tmp.write_text(json.dumps(creds, indent=2))
        os.chmod(tmp, orig_mode)
        os.replace(tmp, creds_file)
    finally:
        if tmp.exists():
            try:
                tmp.unlink()
            except OSError:
                pass
    return ("ok", f"{account}: refreshed (now valid for ~60 min)")


def main():
    statuses = []
    for account, account_dir in ACCOUNTS:
        if not account_dir.exists():
            statuses.append(("missing", f"{account}: directory {account_dir} not present"))
            continue
        statuses.append(refresh_token(account, account_dir))

    any_error = False
    any_missing = False
    for status, message in statuses:
        prefix = {"ok": "OK", "missing": "MISSING", "error": "ERROR"}[status]
        print(f"[{prefix}] {message}")
        if status == "error":
            any_error = True
        if status == "missing":
            any_missing = True

    if any_error:
        sys.exit(3)
    if any_missing:
        sys.exit(2)
    sys.exit(0)


if __name__ == "__main__":
    main()
