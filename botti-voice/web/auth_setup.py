"""
Standalone script to obtain a Google OAuth refresh token with Gmail, Calendar, and Drive scopes.

Usage:
    python -m web.auth_setup [--credentials PATH]

The script will:
1. Open a browser for Google OAuth consent
2. Print the refresh token to copy into .env as GOOGLE_REFRESH_TOKEN
"""

import argparse
import json
import os
import sys

from google_auth_oauthlib.flow import InstalledAppFlow

SCOPES = [
    "https://www.googleapis.com/auth/gmail.modify",
    "https://www.googleapis.com/auth/calendar",
    "https://www.googleapis.com/auth/drive.readonly",
]

DEFAULT_CREDENTIALS = os.path.expanduser("~/.gmail-mcp/gcp-oauth.keys.json")


def main():
    parser = argparse.ArgumentParser(description="Get Google OAuth refresh token for Botti Voice")
    parser.add_argument(
        "--credentials", "-c",
        default=DEFAULT_CREDENTIALS,
        help=f"Path to OAuth client credentials JSON (default: {DEFAULT_CREDENTIALS})",
    )
    parser.add_argument(
        "--port", "-p",
        type=int,
        default=8090,
        help="Local port for OAuth callback (default: 8090)",
    )
    args = parser.parse_args()

    if not os.path.exists(args.credentials):
        print(f"Error: Credentials file not found at {args.credentials}")
        print("Download OAuth client credentials from GCP Console > APIs & Services > Credentials")
        sys.exit(1)

    # Read the credentials to extract client_id and client_secret
    with open(args.credentials) as f:
        cred_data = json.load(f)

    # Handle both "installed" and "web" credential types
    cred_type = list(cred_data.keys())[0]
    client_id = cred_data[cred_type]["client_id"]
    client_secret = cred_data[cred_type]["client_secret"]

    print(f"Using credentials: {args.credentials}")
    print(f"Client ID: {client_id[:30]}...")
    print(f"Scopes: {', '.join(SCOPES)}")
    print()

    flow = InstalledAppFlow.from_client_secrets_file(args.credentials, SCOPES)
    credentials = flow.run_local_server(port=args.port, open_browser=True)

    print("\n" + "=" * 60)
    print("Authorization successful!")
    print("=" * 60)
    print(f"\nRefresh token:\n{credentials.refresh_token}")
    print(f"\nAdd to your .env file:")
    print(f"GOOGLE_REFRESH_TOKEN={credentials.refresh_token}")
    print(f"GOOGLE_CLIENT_ID_OAUTH={client_id}")
    print(f"GOOGLE_CLIENT_SECRET_OAUTH={client_secret}")
    print()


if __name__ == "__main__":
    main()
