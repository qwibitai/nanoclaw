"""
setup_chat_watch.py — Create Workspace Events API subscription for Google Chat.

Usage: python3 setup_chat_watch.py

Uses the same OAuth credentials as setup_gmail_watch.py.
Creates a subscription on the target Chat space that pushes to Pub/Sub.
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
SCOPES = "https://www.googleapis.com/auth/chat.messages.readonly https://www.googleapis.com/auth/chat.spaces.readonly"

SPACE_ID = "spaces/AAQAF8zXzRE"
PUBSUB_TOPIC = "projects/adp-413110/topics/gmail-notifications"

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
        pass

def main():
    # Step 1: OAuth
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

    server = HTTPServer(("localhost", 8099), CallbackHandler)
    server.handle_request()

    if not auth_code:
        print("ERROR: No auth code received.")
        return

    print(f"Auth code received.")

    # Step 2: Exchange code
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
    print(f"REFRESH TOKEN (Chat):")
    print(f"{refresh_token}")
    print(f"{'='*60}\n")

    # Step 3: Create Workspace Events subscription
    print(f"Creating Workspace Events subscription for {SPACE_ID}...")
    sub_body = {
        "targetResource": f"//chat.googleapis.com/{SPACE_ID}",
        "eventTypes": [
            "google.workspace.chat.message.v1.created",
        ],
        "notificationEndpoint": {
            "pubsubTopic": PUBSUB_TOPIC,
        },
        "payloadOptions": {
            "includeResource": True,
        },
        # TTL: max 4 hours for message events, needs periodic renewal
        "ttl": "14400s",
    }

    resp = requests.post(
        "https://workspaceevents.googleapis.com/v1/subscriptions",
        headers={
            "Authorization": f"Bearer {access_token}",
            "Content-Type": "application/json",
        },
        json=sub_body,
    )

    result = resp.json()

    if "error" in result:
        print(f"ERROR: {json.dumps(result['error'], indent=2)}")
        print(f"\nIf 'PERMISSION_DENIED', make sure:")
        print(f"  1. Workspace Events API is enabled in GCP")
        print(f"  2. The user has access to {SPACE_ID}")
        print(f"  3. The Pub/Sub topic {PUBSUB_TOPIC} exists")
    else:
        print(f"Subscription created!")
        print(f"  Name: {result.get('name', result.get('metadata', {}).get('subscription', ''))}")
        print(json.dumps(result, indent=2))

    print(f"\nDone.")
    print(f"Next: set CHAT_WEBHOOK_ACCOUNTS on Cloud Run with:")
    print(f'  {{"boty":{{"space_id":"{SPACE_ID}","refresh_token":"{refresh_token}"}}}}')

if __name__ == "__main__":
    main()
