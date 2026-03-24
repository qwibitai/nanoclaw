"""
setup_thais_gmail.py — Generate Gmail MCP credentials for thais@bestoftours.co.uk.
Outputs credentials to ~/.gmail-mcp-thais/ in the same format as ~/.gmail-mcp/.
"""
import json
import os
import shutil
import webbrowser
from http.server import HTTPServer, BaseHTTPRequestHandler
from urllib.parse import urlparse, parse_qs

import requests

# Use the same OAuth client as the existing gmail-mcp
KEYS_FILE = os.path.expanduser("~/.gmail-mcp/gcp-oauth.keys.json")
with open(KEYS_FILE) as f:
    keys = json.load(f)
    client_type = list(keys.keys())[0]
    CLIENT_ID = keys[client_type]["client_id"]
    CLIENT_SECRET = keys[client_type]["client_secret"]

REDIRECT_URI = "http://localhost:8099"
SCOPES = "https://mail.google.com/ https://www.googleapis.com/auth/calendar https://www.googleapis.com/auth/drive.readonly"
OUTPUT_DIR = os.path.expanduser("~/.gmail-mcp-thais")

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

print(f"\nUsing client: {CLIENT_ID[:30]}...")
print(f"Sign in with thais@bestoftours.co.uk\n")

webbrowser.open(
    f"https://accounts.google.com/o/oauth2/v2/auth?"
    f"client_id={CLIENT_ID}&redirect_uri={REDIRECT_URI}&scope={SCOPES}&"
    f"response_type=code&access_type=offline&prompt=consent"
)
HTTPServer(("localhost", 8099), H).handle_request()

if not auth_code:
    print("ERROR: No auth code received.")
    exit(1)

tokens = requests.post("https://oauth2.googleapis.com/token", data={
    "code": auth_code, "client_id": CLIENT_ID, "client_secret": CLIENT_SECRET,
    "redirect_uri": REDIRECT_URI, "grant_type": "authorization_code",
}).json()

if "error" in tokens:
    print(f"ERROR: {tokens['error']}: {tokens.get('error_description', '')}")
    exit(1)

# Write credentials in gmail-mcp format
os.makedirs(OUTPUT_DIR, exist_ok=True)
shutil.copy(KEYS_FILE, os.path.join(OUTPUT_DIR, "gcp-oauth.keys.json"))

creds = {
    "access_token": tokens["access_token"],
    "refresh_token": tokens["refresh_token"],
    "scope": tokens.get("scope", SCOPES),
    "token_type": tokens.get("token_type", "Bearer"),
    "expiry_date": tokens.get("expires_in", 3600) * 1000,
}
with open(os.path.join(OUTPUT_DIR, "credentials.json"), "w") as f:
    json.dump(creds, f, indent=2)

print(f"\nCredentials written to {OUTPUT_DIR}/")
print(f"  gcp-oauth.keys.json (copied)")
print(f"  credentials.json (new)")
print(f"\nRefresh token: {tokens['refresh_token'][:30]}...")
