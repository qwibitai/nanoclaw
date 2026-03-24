"""
setup_gmail_watch.py — One-shot OAuth flow + Gmail watch() setup.

Usage: python3 setup_gmail_watch.py

1. Opens browser for OAuth consent (sam@bestoftours.co.uk)
2. Exchanges code for refresh_token
3. Calls gmail.users.watch() on the Pub/Sub topic
4. Prints the refresh_token to copy into Cloud Run env vars
"""
import json
import os
import webbrowser
from http.server import HTTPServer, BaseHTTPRequestHandler
from urllib.parse import urlparse, parse_qs

import requests

CLIENT_ID = os.environ.get("OAUTH_CLIENT_ID", "")
CLIENT_SECRET = os.environ.get("OAUTH_CLIENT_SECRET", "")
if not CLIENT_ID or not CLIENT_SECRET:
    print("Set OAUTH_CLIENT_ID and OAUTH_CLIENT_SECRET env vars first.")
    exit(1)
REDIRECT_URI = "http://localhost:8099"
SCOPES = "https://mail.google.com/ https://www.googleapis.com/auth/calendar https://www.googleapis.com/auth/drive.readonly"
TOPIC = "projects/adp-413110/topics/gmail-notifications"

auth_code = None

class CallbackHandler(BaseHTTPRequestHandler):
    def do_GET(self):
        global auth_code
        qs = parse_qs(urlparse(self.path).query)
        auth_code = qs.get("code", [None])[0]
        self.send_response(200)
        self.send_header("Content-Type", "text/html")
        self.end_headers()
        self.wfile.write(b"<h1>OK - retourne dans le terminal.</h1>")

    def log_message(self, format, *args):
        pass  # silence logs

def main():
    # Step 1: Open browser for consent
    auth_url = (
        "https://accounts.google.com/o/oauth2/v2/auth?"
        f"client_id={CLIENT_ID}&"
        f"redirect_uri={REDIRECT_URI}&"
        f"scope={SCOPES}&"
        "response_type=code&"
        "access_type=offline&"
        "prompt=consent"
    )
    print(f"\nOpening browser for OAuth consent...")
    print(f"Sign in with sam@bestoftours.co.uk\n")
    webbrowser.open(auth_url)

    # Step 2: Wait for callback
    server = HTTPServer(("localhost", 8099), CallbackHandler)
    server.handle_request()

    if not auth_code:
        print("ERROR: No auth code received.")
        return

    print(f"Auth code received.")

    # Step 3: Exchange code for tokens
    token_resp = requests.post("https://oauth2.googleapis.com/token", data={
        "code": auth_code,
        "client_id": CLIENT_ID,
        "client_secret": CLIENT_SECRET,
        "redirect_uri": REDIRECT_URI,
        "grant_type": "authorization_code",
    })
    tokens = token_resp.json()

    if "error" in tokens:
        print(f"ERROR: {tokens['error']}: {tokens.get('error_description', '')}")
        return

    access_token = tokens["access_token"]
    refresh_token = tokens.get("refresh_token", "")

    print(f"\n{'='*60}")
    print(f"REFRESH TOKEN (copy this):")
    print(f"{refresh_token}")
    print(f"{'='*60}\n")

    # Step 4: Call gmail.users.watch()
    print("Setting up Gmail watch()...")
    watch_resp = requests.post(
        "https://gmail.googleapis.com/gmail/v1/users/me/watch",
        headers={"Authorization": f"Bearer {access_token}"},
        json={"topicName": TOPIC, "labelIds": ["INBOX"]},
    )
    watch_data = watch_resp.json()

    if "error" in watch_data:
        print(f"ERROR watch(): {watch_data['error']}")
    else:
        print(f"Gmail watch() active!")
        print(f"  historyId: {watch_data.get('historyId')}")
        print(f"  expiration: {watch_data.get('expiration')}")

    print(f"\nDone. Update Cloud Run with the refresh token above.")

if __name__ == "__main__":
    main()
