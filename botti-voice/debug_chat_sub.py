"""Debug: check and renew the Workspace Events Chat subscription."""
import json
import webbrowser
from http.server import HTTPServer, BaseHTTPRequestHandler
from urllib.parse import urlparse, parse_qs
import requests

CLIENT_ID = "215323664878-jc2jj3ha4p4p9asripo8omjebdkb85es.apps.googleusercontent.com"
CLIENT_SECRET = "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"
REDIRECT_URI = "http://localhost:8099"
SCOPES = "https://www.googleapis.com/auth/chat.messages.readonly https://www.googleapis.com/auth/chat.spaces.readonly"
SUB_NAME = "subscriptions/chat-spaces-czpBQVFBRjh6WHpSRToxMTgxMzcxODUyNzI1NDc4MTk0MTI6MTE2MTQzMjE3NTE2NDQzOTMyNjE5"

auth_code = None
class H(BaseHTTPRequestHandler):
    def do_GET(self):
        global auth_code
        auth_code = parse_qs(urlparse(self.path).query).get("code", [None])[0]
        self.send_response(200)
        self.send_header("Content-Type", "text/html")
        self.end_headers()
        self.wfile.write(b"<h1>OK</h1>")
    def log_message(self, *a): pass

print("Opening browser...")
webbrowser.open(f"https://accounts.google.com/o/oauth2/v2/auth?client_id={CLIENT_ID}&redirect_uri={REDIRECT_URI}&scope={SCOPES}&response_type=code&access_type=offline&prompt=consent")
HTTPServer(("localhost", 8099), H).handle_request()

tokens = requests.post("https://oauth2.googleapis.com/token", data={
    "code": auth_code, "client_id": CLIENT_ID, "client_secret": CLIENT_SECRET,
    "redirect_uri": REDIRECT_URI, "grant_type": "authorization_code",
}).json()
at = tokens["access_token"]

# GET current subscription
print("\n--- Current subscription ---")
r = requests.get(f"https://workspaceevents.googleapis.com/v1/{SUB_NAME}",
    headers={"Authorization": f"Bearer {at}"})
sub = r.json()
print(json.dumps(sub, indent=2))

# DELETE then recreate
print("\n--- Deleting subscription ---")
r = requests.delete(f"https://workspaceevents.googleapis.com/v1/{SUB_NAME}",
    headers={"Authorization": f"Bearer {at}"})
print(f"Delete: {r.status_code} {r.text[:200]}")

# Recreate
print("\n--- Creating new subscription ---")
r = requests.post("https://workspaceevents.googleapis.com/v1/subscriptions",
    headers={"Authorization": f"Bearer {at}", "Content-Type": "application/json"},
    json={
        "targetResource": "//chat.googleapis.com/spaces/AAQAF8zXzRE",
        "eventTypes": ["google.workspace.chat.message.v1.created"],
        "notificationEndpoint": {"pubsubTopic": "projects/adp-413110/topics/gmail-notifications"},
        "payloadOptions": {"includeResource": True},
        "ttl": "14400s",
    })
print(json.dumps(r.json(), indent=2))
