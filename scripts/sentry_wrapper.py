#!/usr/bin/env python3
"""Minimal Sentry API wrapper.

Capabilities:
- list projects
- list issues (with query/sort/limit)
- get issue details
- get issue events (latest occurrences)
- update issue (resolve, ignore, assign)

No delete operations on purpose.

Auth: SENTRY_AUTH_TOKEN env var, falls back to macOS Keychain
(service=nanoclaw, account=sentry-auth-token).

Config: Reads org and baseUrl from config/private.yaml via load_private_config.

Examples:
  python3 scripts/sentry_wrapper.py projects
  python3 scripts/sentry_wrapper.py issues --project krobar-api
  python3 scripts/sentry_wrapper.py issues --project krobar-api --query 'is:unresolved' --sort freq --limit 10
  python3 scripts/sentry_wrapper.py issue --id 12345 --project krobar-api
  python3 scripts/sentry_wrapper.py events --id 12345 --project krobar-api
  python3 scripts/sentry_wrapper.py resolve --id 12345 --project krobar-api
  python3 scripts/sentry_wrapper.py ignore --id 12345 --project krobar-api
  python3 scripts/sentry_wrapper.py assign --id 12345 --project krobar-api --assignee user@example.com
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

# Load config — try private config loader first, fall back to env vars
sys.path.insert(0, str(Path(__file__).resolve().parent))
try:
    from load_private_config import load_private_config
    _PRIVATE = load_private_config()
    SENTRY_BASE_URL = _PRIVATE["sentry"]["baseUrl"].rstrip("/")
    SENTRY_ORG = _PRIVATE["sentry"]["org"]
except (ImportError, KeyError):
    SENTRY_BASE_URL = os.environ.get("SENTRY_BASE_URL", "https://sentry.io").rstrip("/")
    SENTRY_ORG = os.environ.get("SENTRY_ORG", "")
    if not SENTRY_ORG:
        print(json.dumps({"error": "SENTRY_ORG env var is required when load_private_config is unavailable"}))
        sys.exit(1)


def die(message: str, code: int = 1) -> int:
    print(json.dumps({"error": message}), file=sys.stdout)
    return code


def resolve_token() -> str:
    """Resolve SENTRY_AUTH_TOKEN from env, falling back to macOS Keychain."""
    token = os.environ.get("SENTRY_AUTH_TOKEN", "")
    if token:
        return token
    try:
        result = subprocess.run(
            [
                "security", "find-generic-password",
                "-s", "nanoclaw",
                "-a", "sentry-auth-token", "-w",
            ],
            capture_output=True, text=True, timeout=5,
        )
        if result.returncode == 0 and result.stdout.strip():
            return result.stdout.strip()
    except (FileNotFoundError, subprocess.TimeoutExpired):
        pass
    return ""


TOKEN = resolve_token()


def api_request(
    method: str, path: str, data: dict | None = None, params: dict | None = None
) -> dict | list:
    """Make an authenticated Sentry API request."""
    if not TOKEN:
        raise RuntimeError("No Sentry auth token available")

    url = f"{SENTRY_BASE_URL}{path}"
    if params:
        url += "?" + urlencode(params)

    body = json.dumps(data).encode("utf-8") if data else None
    req = Request(url, data=body, method=method)
    req.add_header("Authorization", f"Bearer {TOKEN}")
    req.add_header("Accept", "application/json")
    if body:
        req.add_header("Content-Type", "application/json")

    with urlopen(req, timeout=30) as resp:
        raw = resp.read().decode("utf-8")
        return json.loads(raw) if raw.strip() else {}


def cmd_projects(_args: argparse.Namespace) -> int:
    """List all projects in the org."""
    try:
        result = api_request("GET", f"/api/0/organizations/{SENTRY_ORG}/projects/")
        projects = [
            {
                "slug": p.get("slug"),
                "name": p.get("name"),
                "platform": p.get("platform"),
                "dateCreated": p.get("dateCreated"),
            }
            for p in result
        ] if isinstance(result, list) else result
        print(json.dumps(projects, indent=2))
        return 0
    except (HTTPError, URLError, RuntimeError) as err:
        return die(str(err))


def cmd_issues(args: argparse.Namespace) -> int:
    """List issues for a project."""
    try:
        params: dict[str, str] = {}
        if args.query:
            params["query"] = args.query
        if args.sort:
            params["sort"] = args.sort
        if args.limit:
            params["limit"] = str(args.limit)

        result = api_request(
            "GET",
            f"/api/0/projects/{SENTRY_ORG}/{args.project}/issues/",
            params=params,
        )
        issues = [
            {
                "id": i.get("id"),
                "title": i.get("title"),
                "culprit": i.get("culprit"),
                "level": i.get("level"),
                "status": i.get("status"),
                "count": i.get("count"),
                "userCount": i.get("userCount"),
                "firstSeen": i.get("firstSeen"),
                "lastSeen": i.get("lastSeen"),
                "permalink": i.get("permalink"),
                "assignedTo": i.get("assignedTo"),
            }
            for i in result
        ] if isinstance(result, list) else result
        print(json.dumps(issues, indent=2))
        return 0
    except (HTTPError, URLError, RuntimeError) as err:
        return die(str(err))


def cmd_issue(args: argparse.Namespace) -> int:
    """Get details for a single issue."""
    try:
        result = api_request(
            "GET",
            f"/api/0/projects/{SENTRY_ORG}/{args.project}/issues/{args.id}/",
        )
        print(json.dumps(result, indent=2))
        return 0
    except (HTTPError, URLError, RuntimeError) as err:
        return die(str(err))


def cmd_events(args: argparse.Namespace) -> int:
    """Get latest events for an issue."""
    try:
        result = api_request(
            "GET",
            f"/api/0/projects/{SENTRY_ORG}/{args.project}/issues/{args.id}/events/",
            params={"limit": str(args.limit or 10)},
        )
        print(json.dumps(result, indent=2))
        return 0
    except (HTTPError, URLError, RuntimeError) as err:
        return die(str(err))


def cmd_resolve(args: argparse.Namespace) -> int:
    """Resolve an issue."""
    try:
        result = api_request(
            "PUT",
            f"/api/0/projects/{SENTRY_ORG}/{args.project}/issues/{args.id}/",
            data={"status": "resolved"},
        )
        print(json.dumps(result, indent=2))
        return 0
    except (HTTPError, URLError, RuntimeError) as err:
        return die(str(err))


def cmd_ignore(args: argparse.Namespace) -> int:
    """Ignore an issue."""
    try:
        result = api_request(
            "PUT",
            f"/api/0/projects/{SENTRY_ORG}/{args.project}/issues/{args.id}/",
            data={"status": "ignored"},
        )
        print(json.dumps(result, indent=2))
        return 0
    except (HTTPError, URLError, RuntimeError) as err:
        return die(str(err))


def cmd_assign(args: argparse.Namespace) -> int:
    """Assign an issue."""
    try:
        result = api_request(
            "PUT",
            f"/api/0/projects/{SENTRY_ORG}/{args.project}/issues/{args.id}/",
            data={"assignedTo": args.assignee},
        )
        print(json.dumps(result, indent=2))
        return 0
    except (HTTPError, URLError, RuntimeError) as err:
        return die(str(err))


def main() -> int:
    parser = argparse.ArgumentParser(description="Minimal Sentry API wrapper")
    sub = parser.add_subparsers(dest="command")

    sub.add_parser("projects")

    p_issues = sub.add_parser("issues")
    p_issues.add_argument("--project", required=True)
    p_issues.add_argument("--query")
    p_issues.add_argument("--sort", choices=["date", "freq", "new", "priority"])
    p_issues.add_argument("--limit", type=int, default=25)

    p_issue = sub.add_parser("issue")
    p_issue.add_argument("--id", required=True)
    p_issue.add_argument("--project", required=True)

    p_events = sub.add_parser("events")
    p_events.add_argument("--id", required=True)
    p_events.add_argument("--project", required=True)
    p_events.add_argument("--limit", type=int, default=10)

    p_resolve = sub.add_parser("resolve")
    p_resolve.add_argument("--id", required=True)
    p_resolve.add_argument("--project", required=True)

    p_ignore = sub.add_parser("ignore")
    p_ignore.add_argument("--id", required=True)
    p_ignore.add_argument("--project", required=True)

    p_assign = sub.add_parser("assign")
    p_assign.add_argument("--id", required=True)
    p_assign.add_argument("--project", required=True)
    p_assign.add_argument("--assignee", required=True)

    args = parser.parse_args()
    if not args.command:
        parser.print_help()
        return 1

    dispatch = {
        "projects": cmd_projects,
        "issues": cmd_issues,
        "issue": cmd_issue,
        "events": cmd_events,
        "resolve": cmd_resolve,
        "ignore": cmd_ignore,
        "assign": cmd_assign,
    }
    return dispatch[args.command](args)


if __name__ == "__main__":
    sys.exit(main())
