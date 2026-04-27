#!/usr/bin/env python3
"""
Send email via Microsoft Graph API using the existing outlook-mcp token file.
Usage: python3 send_email.py --to addr --subject "..." --body-file report.html [--body-html "..."]
"""
import argparse, json, os, sys, time
import urllib.request, urllib.error

TOKEN_PATH = os.path.expanduser("~/.outlook-mcp-tokens.json")
GRAPH_SEND = "https://graph.microsoft.com/v1.0/me/sendMail"


def load_token():
    with open(TOKEN_PATH) as f:
        data = json.load(f)
    if data.get("expires_at", 0) < time.time() * 1000 + 60000:
        data = refresh_token(data)
    return data["access_token"]


def refresh_token(data):
    client_id = os.environ.get("MS_CLIENT_ID", "")
    client_secret = os.environ.get("MS_CLIENT_SECRET", "")
    if not client_id or not client_secret:
        # Try reading from .env in script dir
        env_path = os.path.join(os.path.dirname(__file__), "../../.env")
        if os.path.exists(env_path):
            for line in open(env_path):
                k, _, v = line.strip().partition("=")
                if k == "MS_CLIENT_ID":
                    client_id = v
                if k == "MS_CLIENT_SECRET":
                    client_secret = v
    payload = "&".join([
        "grant_type=refresh_token",
        f"refresh_token={urllib.parse.quote(data['refresh_token'])}",
        f"client_id={urllib.parse.quote(client_id)}",
        f"client_secret={urllib.parse.quote(client_secret)}",
        "scope=https://graph.microsoft.com/.default offline_access",
    ])
    req = urllib.request.Request(
        "https://login.microsoftonline.com/common/oauth2/v2.0/token",
        data=payload.encode(),
        headers={"Content-Type": "application/x-www-form-urlencoded"},
    )
    with urllib.request.urlopen(req, timeout=30) as r:
        new = json.loads(r.read())
    new["expires_at"] = int(time.time() * 1000) + new["expires_in"] * 1000
    # Preserve refresh_token if not returned
    if "refresh_token" not in new:
        new["refresh_token"] = data["refresh_token"]
    with open(TOKEN_PATH, "w") as f:
        json.dump(new, f)
    return new


def send_email(to, subject, body_html, token):
    import urllib.parse
    payload = json.dumps({
        "message": {
            "subject": subject,
            "body": {"contentType": "HTML", "content": body_html},
            "toRecipients": [{"emailAddress": {"address": to}}],
        },
        "saveToSentItems": True,
    }).encode()
    req = urllib.request.Request(
        GRAPH_SEND,
        data=payload,
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            status = r.status
        print(f"Sent. HTTP {status}")
        return True
    except urllib.error.HTTPError as e:
        body = e.read().decode()
        print(f"ERROR {e.code}: {body}", file=sys.stderr)
        return False


def main():
    import urllib.parse
    ap = argparse.ArgumentParser()
    ap.add_argument("--to", required=True)
    ap.add_argument("--subject", required=True)
    ap.add_argument("--body-file", help="Path to HTML file")
    ap.add_argument("--body-html", help="HTML string directly")
    args = ap.parse_args()

    if args.body_file:
        with open(args.body_file) as f:
            body = f.read()
    elif args.body_html:
        body = args.body_html
    else:
        print("ERROR: provide --body-file or --body-html", file=sys.stderr)
        sys.exit(1)

    token = load_token()
    ok = send_email(args.to, args.subject, body, token)
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
