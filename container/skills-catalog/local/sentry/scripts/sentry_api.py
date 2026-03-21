#!/usr/bin/env python3
import argparse
import json
import os
import re
import sys
import time
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

DEFAULT_BASE_URL = "https://sentry.io"
DEFAULT_ORG = "your-org"
DEFAULT_PROJECT = "your-project"
MAX_LIMIT = 50

EMAIL_RE = re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}")
IP_RE = re.compile(r"\b(?:\d{1,3}\.){3}\d{1,3}\b")


def redact_string(value):
    value = EMAIL_RE.sub("[REDACTED_EMAIL]", value)
    value = IP_RE.sub("[REDACTED_IP]", value)
    return value


def redact_data(value):
    if isinstance(value, str):
        return redact_string(value)
    if isinstance(value, list):
        return [redact_data(item) for item in value]
    if isinstance(value, dict):
        redacted = {}
        for key, item in value.items():
            if key.lower() in {"email", "ip", "ip_address"}:
                redacted[key] = "[REDACTED]"
            else:
                redacted[key] = redact_data(item)
        return redacted
    return value


def next_cursor(link_header):
    if not link_header:
        return None
    for part in link_header.split(","):
        if 'rel="next"' in part and 'results="true"' in part:
            match = re.search(r'cursor="([^"]+)"', part)
            if match:
                return match.group(1)
    return None


def request_json(url, token, retries=1):
    req = Request(url)
    req.add_header("Authorization", f"Bearer {token}")
    req.add_header("Accept", "application/json")

    attempt = 0
    while True:
        try:
            with urlopen(req) as resp:
                body = resp.read().decode("utf-8")
                data = json.loads(body) if body else None
                return data, resp.headers
        except HTTPError as err:
            body = err.read().decode("utf-8", "ignore")
            if attempt < retries and (err.code >= 500 or err.code == 429):
                attempt += 1
                time.sleep(1)
                continue
            raise RuntimeError(f"HTTP {err.code} for {url}: {body or 'request failed'}") from err
        except URLError as err:
            if attempt < retries:
                attempt += 1
                time.sleep(1)
                continue
            raise RuntimeError(f"Network error for {url}: {err.reason}") from err


def build_url(base_url, path, params=None):
    base = base_url.rstrip("/")
    url = f"{base}{path}"
    if params:
        url = f"{url}?{urlencode(params, doseq=True)}"
    return url


def paged_get(base_url, path, params, token, limit):
    results = []
    cursor = None
    while len(results) < limit:
        page_params = dict(params)
        page_params["per_page"] = min(MAX_LIMIT, limit - len(results))
        if cursor:
            page_params["cursor"] = cursor
        url = build_url(base_url, path, page_params)
        data, headers = request_json(url, token)
        if not data:
            break
        results.extend(data)
        cursor = next_cursor(headers.get("Link"))
        if not cursor:
            break
    return results[:limit]


def require_org_project(org, project):
    if org == DEFAULT_ORG or project == DEFAULT_PROJECT:
        raise RuntimeError(
            "Missing org/project. Set SENTRY_ORG and SENTRY_PROJECT or pass --org/--project."
        )


def handle_list_issues(args, token, base_url):
    require_org_project(args.org, args.project)
    limit = min(args.limit, MAX_LIMIT)
    params = {
        "statsPeriod": args.time_range,
        "environment": args.environment,
    }
    if args.query:
        params["query"] = args.query

    path = f"/api/0/projects/{args.org}/{args.project}/issues/"
    issues = paged_get(base_url, path, params, token, limit)
    return issues


def handle_issue_detail(args, token, base_url):
    path = f"/api/0/issues/{args.issue_id}/"
    url = build_url(base_url, path)
    data, _ = request_json(url, token)
    return data


def handle_issue_events(args, token, base_url):
    limit = min(args.limit, MAX_LIMIT)
    path = f"/api/0/issues/{args.issue_id}/events/"
    events = paged_get(base_url, path, {}, token, limit)
    return events


def handle_event_detail(args, token, base_url):
    require_org_project(args.org, args.project)
    path = f"/api/0/projects/{args.org}/{args.project}/events/{args.event_id}/"
    url = build_url(base_url, path)
    data, _ = request_json(url, token)
    if data and not args.include_entries:
        data = dict(data)
        data.pop("entries", None)
    return data


def build_parser():
    parser = argparse.ArgumentParser(
        description="Read-only Sentry API helper for issues and events"
    )
    parser.add_argument(
        "--base-url",
        default=os.environ.get("SENTRY_BASE_URL", DEFAULT_BASE_URL),
        help="Sentry base URL (default: https://sentry.io)",
    )
    parser.add_argument(
        "--org",
        default=os.environ.get("SENTRY_ORG", DEFAULT_ORG),
        help="Sentry org slug",
    )
    parser.add_argument(
        "--project",
        default=os.environ.get("SENTRY_PROJECT", DEFAULT_PROJECT),
        help="Sentry project slug",
    )
    parser.add_argument(
        "--no-redact",
        action="store_true",
        help="Do not redact PII in output",
    )

    subparsers = parser.add_subparsers(dest="command", required=True)

    list_issues = subparsers.add_parser("list-issues", help="List issues")
    list_issues.add_argument("--time-range", default="24h")
    list_issues.add_argument("--environment", default="prod")
    list_issues.add_argument("--query", default="")
    list_issues.add_argument("--limit", type=int, default=20)

    issue_detail = subparsers.add_parser("issue-detail", help="Issue detail")
    issue_detail.add_argument("issue_id")

    issue_events = subparsers.add_parser("issue-events", help="Issue events")
    issue_events.add_argument("issue_id")
    issue_events.add_argument("--limit", type=int, default=20)

    event_detail = subparsers.add_parser("event-detail", help="Event detail")
    event_detail.add_argument("event_id")
    event_detail.add_argument(
        "--include-entries",
        action="store_true",
        help="Include event entries (may contain stack traces)",
    )

    return parser


def main():
    parser = build_parser()
    args = parser.parse_args()

    token = os.environ.get("SENTRY_AUTH_TOKEN")
    if not token:
        raise RuntimeError("Missing SENTRY_AUTH_TOKEN env var.")

    base_url = args.base_url

    if args.command == "list-issues":
        data = handle_list_issues(args, token, base_url)
    elif args.command == "issue-detail":
        data = handle_issue_detail(args, token, base_url)
    elif args.command == "issue-events":
        data = handle_issue_events(args, token, base_url)
    elif args.command == "event-detail":
        data = handle_event_detail(args, token, base_url)
    else:
        raise RuntimeError(f"Unknown command: {args.command}")

    if not args.no_redact:
        data = redact_data(data)

    print(json.dumps(data, indent=2, sort_keys=True))


if __name__ == "__main__":
    try:
        main()
    except RuntimeError as exc:
        print(f"Error: {exc}", file=sys.stderr)
        sys.exit(1)
