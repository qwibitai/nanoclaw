#!/usr/bin/env python3
"""One-time script to add Google Calendar read-only scope to existing OAuth tokens.

For each Gmail account (~/.gmail-mcp, ~/.gmail-mcp-jonathan, ~/.gmail-mcp-attaxion, ~/.gmail-mcp-dev),
this script:
1. Reads the existing OAuth client config (gcp-oauth.keys.json)
2. Reads the existing credentials (credentials.json)
3. Initiates a new OAuth flow with the COMBINED scopes (existing + calendar.readonly)
4. Saves the updated credentials with the new scope

Run this once. After that, the refresh script will maintain the tokens.

Usage: python3 scripts/authorize-calendar.py [--account personal|jonathan|attaxion|dev|all]
"""

import json
import sys
import os
import http.server
import urllib.parse
import urllib.request
import webbrowser
from pathlib import Path

HOME = Path.home()

ACCOUNTS = {
    "personal": HOME / ".gmail-mcp",
    "jonathan": HOME / ".gmail-mcp-jonathan",
    "attaxion": HOME / ".gmail-mcp-attaxion",
    "dev": HOME / ".gmail-mcp-dev",
}

CALENDAR_SCOPE = "https://www.googleapis.com/auth/calendar.readonly"
REDIRECT_URI = "http://localhost:8085"


def get_existing_scopes(creds_path: Path) -> list[str]:
    """Read existing scopes from credentials.json."""
    if not creds_path.exists():
        return []
    with open(creds_path) as f:
        creds = json.load(f)
    scope_str = creds.get("scope", "")
    return [s.strip() for s in scope_str.split() if s.strip()]


def authorize_account(name: str, account_dir: Path) -> bool:
    """Run OAuth flow for a single account, adding calendar scope."""
    keys_path = account_dir / "gcp-oauth.keys.json"
    creds_path = account_dir / "credentials.json"

    if not keys_path.exists():
        print(f"  SKIP {name}: no gcp-oauth.keys.json found")
        return False

    with open(keys_path) as f:
        keys = json.load(f)

    client_id = keys["installed"]["client_id"]
    client_secret = keys["installed"]["client_secret"]
    token_uri = keys["installed"]["token_uri"]

    # Combine existing scopes with calendar scope
    existing_scopes = get_existing_scopes(creds_path)
    if CALENDAR_SCOPE in existing_scopes:
        print(f"  OK {name}: calendar scope already present")
        return True

    all_scopes = list(set(existing_scopes + [CALENDAR_SCOPE]))
    scope_str = " ".join(all_scopes)

    print(f"\n  Authorizing {name} with scopes: {scope_str}")
    print(f"  Opening browser for Google OAuth consent...")

    # Build authorization URL
    auth_url = (
        "https://accounts.google.com/o/oauth2/v2/auth?"
        + urllib.parse.urlencode({
            "client_id": client_id,
            "redirect_uri": REDIRECT_URI,
            "response_type": "code",
            "scope": scope_str,
            "access_type": "offline",
            "prompt": "consent",  # Force consent to get new refresh token with expanded scopes
        })
    )

    # Start local HTTP server to capture the OAuth callback
    auth_code = None

    class CallbackHandler(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            nonlocal auth_code
            query = urllib.parse.urlparse(self.path).query
            params = urllib.parse.parse_qs(query)
            auth_code = params.get("code", [None])[0]

            self.send_response(200)
            self.send_header("Content-Type", "text/html")
            self.end_headers()
            self.wfile.write(
                b"<html><body><h2>Authorization complete!</h2>"
                b"<p>You can close this tab.</p></body></html>"
            )

        def log_message(self, *args):
            pass  # Suppress HTTP log noise

    server = http.server.HTTPServer(("localhost", 8085), CallbackHandler)
    webbrowser.open(auth_url)

    print("  Waiting for OAuth callback...")
    server.handle_request()  # Handle one request (the callback)
    server.server_close()

    if not auth_code:
        print(f"  ERROR {name}: no authorization code received")
        return False

    # Exchange code for tokens
    token_data = urllib.parse.urlencode({
        "code": auth_code,
        "client_id": client_id,
        "client_secret": client_secret,
        "redirect_uri": REDIRECT_URI,
        "grant_type": "authorization_code",
    }).encode()

    req = urllib.request.Request(token_uri, data=token_data, method="POST")
    try:
        with urllib.request.urlopen(req) as resp:
            tokens = json.loads(resp.read())
    except Exception as e:
        print(f"  ERROR {name}: token exchange failed: {e}")
        return False

    # Save updated credentials
    creds = {
        "access_token": tokens["access_token"],
        "refresh_token": tokens.get("refresh_token", ""),
        "scope": scope_str,
        "token_type": tokens.get("token_type", "Bearer"),
        "expiry_date": int((tokens.get("expires_in", 3600)) * 1000 + __import__("time").time() * 1000),
    }

    # Preserve existing refresh_token if new one wasn't issued
    if not creds["refresh_token"] and creds_path.exists():
        with open(creds_path) as f:
            old = json.load(f)
        creds["refresh_token"] = old.get("refresh_token", "")

    with open(creds_path, "w") as f:
        json.dump(creds, f, indent=2)

    print(f"  OK {name}: calendar scope added, credentials saved")
    return True


def main():
    account_name = "all"
    if len(sys.argv) > 1:
        if sys.argv[1] == "--account" and len(sys.argv) > 2:
            account_name = sys.argv[2]
        else:
            account_name = sys.argv[1].lstrip("-")

    if account_name == "all":
        targets = ACCOUNTS
    elif account_name in ACCOUNTS:
        targets = {account_name: ACCOUNTS[account_name]}
    else:
        print(f"Unknown account: {account_name}")
        print(f"Valid accounts: {', '.join(ACCOUNTS.keys())}, all")
        sys.exit(1)

    print("Adding Google Calendar read-only scope to OAuth tokens\n")
    results = {}
    for name, path in targets.items():
        results[name] = authorize_account(name, path)

    print("\n--- Summary ---")
    for name, ok in results.items():
        print(f"  {name}: {'OK' if ok else 'FAILED'}")

    if not all(results.values()):
        sys.exit(1)


if __name__ == "__main__":
    main()
