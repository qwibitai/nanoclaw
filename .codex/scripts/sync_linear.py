#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import os
import urllib.request

LINEAR_URL = "https://api.linear.app/graphql"

parser = argparse.ArgumentParser(description="Sync a comment or state update to Linear")
parser.add_argument("--issue", required=True)
parser.add_argument("--comment")
parser.add_argument("--state-id")
args = parser.parse_args()

token = os.environ.get("LINEAR_API_KEY")
if not token:
    raise SystemExit("LINEAR_API_KEY is required")

if args.comment:
    query = "mutation($issueId: String!, $body: String!) { commentCreate(input: { issueId: $issueId, body: $body }) { success } }"
    variables = {"issueId": args.issue, "body": args.comment}
elif args.state_id:
    query = "mutation($id: String!, $stateId: String!) { issueUpdate(id: $id, input: { stateId: $stateId }) { success } }"
    variables = {"id": args.issue, "stateId": args.state_id}
else:
    raise SystemExit("Provide --comment or --state-id")

payload = json.dumps({"query": query, "variables": variables}).encode()
req = urllib.request.Request(LINEAR_URL, data=payload, headers={"Content-Type": "application/json", "Authorization": token})
with urllib.request.urlopen(req) as resp:
    data = json.loads(resp.read().decode())
if data.get("errors"):
    raise SystemExit(json.dumps(data["errors"], indent=2))
print("Linear sync complete")
