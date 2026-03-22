#!/usr/bin/env python3
"""Linear API client for project management operations."""

import argparse
import json
import os
import sys
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

LINEAR_API_URL = "https://api.linear.app/graphql"
PRIORITY_LABELS = {0: "No priority", 1: "Urgent", 2: "High", 3: "Medium", 4: "Low"}


def get_token():
    token = os.environ.get("LINEAR_API_KEY")
    if not token:
        print("Error: LINEAR_API_KEY environment variable not set.", file=sys.stderr)
        print("Get your API key at: https://linear.app/settings/api", file=sys.stderr)
        sys.exit(1)
    return token


def gql(query, variables=None):
    token = get_token()
    payload = json.dumps({"query": query, "variables": variables or {}}).encode()
    req = Request(LINEAR_API_URL, data=payload)
    req.add_header("Authorization", token)
    req.add_header("Content-Type", "application/json")
    req.add_header("Accept", "application/json")
    try:
        with urlopen(req, timeout=30) as resp:
            data = json.loads(resp.read())
    except HTTPError as e:
        body = e.read().decode()
        print(f"HTTP {e.code}: {body}", file=sys.stderr)
        sys.exit(1)
    except URLError as e:
        print(f"Network error: {e.reason}", file=sys.stderr)
        sys.exit(1)
    if "errors" in data:
        for err in data["errors"]:
            print(f"GraphQL error: {err['message']}", file=sys.stderr)
        sys.exit(1)
    return data.get("data", {})


# ── teams ──────────────────────────────────────────────────────────────────────

def cmd_teams(args):
    data = gql("""
    query { teams { nodes { id key name description } } }
    """)
    teams = data["teams"]["nodes"]
    if not teams:
        print("No teams found.")
        return
    for t in teams:
        desc = f" — {t['description']}" if t.get("description") else ""
        print(f"• [{t['key']}] {t['name']}{desc}")


# ── projects ───────────────────────────────────────────────────────────────────

def cmd_projects(args):
    if args.team:
        data = gql("""
        query($filter: ProjectFilter) {
          projects(filter: $filter) {
            nodes { id name state description url teams { nodes { key } } }
          }
        }
        """, {"filter": {"teams": {"key": {"eq": args.team}}}})
    else:
        data = gql("""
        query {
          projects { nodes { id name state description url teams { nodes { key } } } }
        }
        """)
    projects = data["projects"]["nodes"]
    if not projects:
        print("No projects found.")
        return
    for p in projects:
        teams = ", ".join(t["key"] for t in p.get("teams", {}).get("nodes", []))
        team_str = f" [{teams}]" if teams else ""
        print(f"• {p['name']}{team_str} — {p['state']}")
        if p.get("url"):
            print(f"  {p['url']}")


# ── issues ─────────────────────────────────────────────────────────────────────

def build_issue_filter(args):
    filters = []
    if args.assignee == "me":
        filters.append("assignee: { isMe: { eq: true } }")
    elif args.assignee:
        filters.append(f'assignee: {{ displayName: {{ containsIgnoreCase: "{args.assignee}" }} }}')
    if args.team:
        filters.append(f'team: {{ key: {{ eq: "{args.team}" }} }}')
    if args.state:
        filters.append(f'state: {{ name: {{ containsIgnoreCase: "{args.state}" }} }}')
    if args.project:
        filters.append(f'project: {{ name: {{ containsIgnoreCase: "{args.project}" }} }}')
    if args.days:
        filters.append(f'createdAt: {{ gte: "-P{args.days}D" }}')
    return "filter: {" + " ".join(filters) + "}" if filters else ""


def print_issue_list(issues):
    if not issues:
        print("No issues found.")
        return
    for issue in issues:
        state = issue.get("state", {}).get("name", "?")
        priority = PRIORITY_LABELS.get(issue.get("priority", 0), "?")
        assignee = issue.get("assignee", {})
        assignee_str = f" → {assignee['displayName']}" if assignee else ""
        print(f"• [{issue['identifier']}] {issue['title']}")
        print(f"  {state} | {priority}{assignee_str}")
        if issue.get("url"):
            print(f"  {issue['url']}")


def cmd_issues(args):
    filter_str = build_issue_filter(args)
    limit = min(args.limit, 50)
    data = gql(f"""
    query {{
      issues({filter_str} first: {limit} orderBy: updatedAt) {{
        nodes {{
          id identifier title priority url
          state {{ name }}
          assignee {{ displayName }}
          project {{ name }}
        }}
      }}
    }}
    """)
    print_issue_list(data["issues"]["nodes"])


def cmd_issue(args):
    data = gql("""
    query($id: String!) {
      issue(id: $id) {
        id identifier title description priority url createdAt updatedAt
        state { name }
        assignee { displayName email }
        project { name }
        team { key name }
        comments { nodes { body createdAt user { displayName } } }
      }
    }
    """, {"id": args.id})
    issue = data.get("issue")
    if not issue:
        print(f"Issue {args.id} not found.")
        return
    print(f"[{issue['identifier']}] {issue['title']}")
    print(f"State:    {issue['state']['name']}")
    print(f"Priority: {PRIORITY_LABELS.get(issue['priority'], '?')}")
    if issue.get("assignee"):
        print(f"Assignee: {issue['assignee']['displayName']}")
    if issue.get("project"):
        print(f"Project:  {issue['project']['name']}")
    print(f"URL:      {issue['url']}")
    if issue.get("description"):
        print(f"\nDescription:\n{issue['description']}")
    comments = issue.get("comments", {}).get("nodes", [])
    if comments:
        print(f"\nComments ({len(comments)}):")
        for c in comments[-5:]:
            user = c.get("user", {}).get("displayName", "?")
            print(f"  [{user}] {c['body'][:200]}")


# ── create ─────────────────────────────────────────────────────────────────────

def get_team_id(team_key):
    data = gql("""
    query($filter: TeamFilter) { teams(filter: $filter) { nodes { id key } } }
    """, {"filter": {"key": {"eq": team_key}}})
    teams = data["teams"]["nodes"]
    if not teams:
        print(f"Team '{team_key}' not found.", file=sys.stderr)
        sys.exit(1)
    return teams[0]["id"]


def get_project_id(name):
    data = gql("""
    query($filter: ProjectFilter) { projects(filter: $filter) { nodes { id name } } }
    """, {"filter": {"name": {"containsIgnoreCase": name}}})
    projects = data["projects"]["nodes"]
    if not projects:
        print(f"Project '{name}' not found.", file=sys.stderr)
        sys.exit(1)
    if len(projects) > 1:
        names = ", ".join(p["name"] for p in projects)
        print(f"Ambiguous project name '{name}'. Matches: {names}", file=sys.stderr)
        sys.exit(1)
    return projects[0]["id"]


def get_state_id(team_id, state_name):
    data = gql("""
    query($teamId: ID!) {
      workflowStates(filter: { team: { id: { eq: $teamId } } }) {
        nodes { id name }
      }
    }
    """, {"teamId": team_id})
    states = data["workflowStates"]["nodes"]
    for s in states:
        if s["name"].lower() == state_name.lower():
            return s["id"]
    # fuzzy match
    for s in states:
        if state_name.lower() in s["name"].lower():
            return s["id"]
    available = ", ".join(s["name"] for s in states)
    print(f"State '{state_name}' not found. Available: {available}", file=sys.stderr)
    sys.exit(1)


def cmd_create(args):
    team_id = get_team_id(args.team)
    variables = {
        "teamId": team_id,
        "title": args.title,
    }
    if args.description:
        variables["description"] = args.description
    if args.priority is not None:
        variables["priority"] = args.priority
    if args.state:
        variables["stateId"] = get_state_id(team_id, args.state)
    if args.project:
        variables["projectId"] = get_project_id(args.project)

    data = gql("""
    mutation($teamId: String!, $title: String!, $description: String,
             $priority: Int, $stateId: String, $projectId: String) {
      issueCreate(input: {
        teamId: $teamId
        title: $title
        description: $description
        priority: $priority
        stateId: $stateId
        projectId: $projectId
      }) {
        success
        issue { id identifier title url state { name } priority }
      }
    }
    """, variables)
    result = data["issueCreate"]
    if result["success"]:
        issue = result["issue"]
        print(f"Created: [{issue['identifier']}] {issue['title']}")
        print(f"State:    {issue['state']['name']}")
        print(f"Priority: {PRIORITY_LABELS.get(issue['priority'], '?')}")
        print(f"URL:      {issue['url']}")
    else:
        print("Failed to create issue.", file=sys.stderr)
        sys.exit(1)


# ── bulk-create ────────────────────────────────────────────────────────────────

def cmd_bulk_create(args):
    """Create multiple issues from a JSON array.

    Input JSON format (file or stdin):
    [
      {"title": "...", "description": "...", "priority": 2, "state": "Backlog"},
      ...
    ]
    """
    if args.file and args.file != "-":
        with open(args.file) as f:
            issues = json.load(f)
    else:
        issues = json.load(sys.stdin)

    if not isinstance(issues, list):
        print("Input must be a JSON array of issue objects.", file=sys.stderr)
        sys.exit(1)

    team_id = get_team_id(args.team)
    project_id = get_project_id(args.project) if args.project else None

    created = 0
    for item in issues:
        variables = {"teamId": team_id, "title": item["title"]}
        if item.get("description"):
            variables["description"] = item["description"]
        if item.get("priority") is not None:
            variables["priority"] = item["priority"]
        if item.get("state"):
            variables["stateId"] = get_state_id(team_id, item["state"])
        if project_id:
            variables["projectId"] = project_id

        data = gql("""
        mutation($teamId: String!, $title: String!, $description: String,
                 $priority: Int, $stateId: String, $projectId: String) {
          issueCreate(input: {
            teamId: $teamId title: $title description: $description
            priority: $priority stateId: $stateId projectId: $projectId
          }) {
            success
            issue { identifier title url priority state { name } }
          }
        }
        """, variables)
        result = data["issueCreate"]
        if result["success"]:
            issue = result["issue"]
            priority = PRIORITY_LABELS.get(issue["priority"], "?")
            print(f"  ✓ [{issue['identifier']}] {issue['title']} [{priority}]")
            created += 1
        else:
            print(f"  ✗ Failed: {item['title']}", file=sys.stderr)

    print(f"\nCreated {created}/{len(issues)} issues.")


# ── update ─────────────────────────────────────────────────────────────────────

def resolve_issue_id(identifier):
    """Resolve a short identifier like ENG-42 to the internal UUID."""
    data = gql("""
    query($filter: IssueFilter) { issues(filter: $filter) { nodes { id identifier } } }
    """, {"filter": {"identifier": {"eq": identifier}}})
    issues = data["issues"]["nodes"]
    if not issues:
        print(f"Issue {identifier} not found.", file=sys.stderr)
        sys.exit(1)
    return issues[0]["id"]


def cmd_update(args):
    issue_id = resolve_issue_id(args.id)
    variables = {"issueId": issue_id}
    input_fields = {}

    if args.state:
        # Get team for this issue to resolve state
        data = gql("query($id: ID!) { issue(id: $id) { team { id } } }", {"id": issue_id})
        team_id = data["issue"]["team"]["id"]
        input_fields["stateId"] = get_state_id(team_id, args.state)
    if args.priority is not None:
        input_fields["priority"] = args.priority
    if args.title:
        input_fields["title"] = args.title
    if args.description:
        input_fields["description"] = args.description

    if not input_fields:
        print("Nothing to update. Provide --state, --priority, --title, or --description.")
        return

    variables["input"] = input_fields
    data = gql("""
    mutation($issueId: String!, $input: IssueUpdateInput!) {
      issueUpdate(id: $issueId, input: $input) {
        success
        issue { identifier title url state { name } priority }
      }
    }
    """, variables)
    result = data["issueUpdate"]
    if result["success"]:
        issue = result["issue"]
        print(f"Updated: [{issue['identifier']}] {issue['title']}")
        print(f"State:    {issue['state']['name']}")
        print(f"Priority: {PRIORITY_LABELS.get(issue['priority'], '?')}")
        print(f"URL:      {issue['url']}")
    else:
        print("Failed to update issue.", file=sys.stderr)
        sys.exit(1)


# ── comment ────────────────────────────────────────────────────────────────────

def cmd_comment(args):
    issue_id = resolve_issue_id(args.id)
    data = gql("""
    mutation($issueId: String!, $body: String!) {
      commentCreate(input: { issueId: $issueId, body: $body }) {
        success
        comment { id url }
      }
    }
    """, {"issueId": issue_id, "body": args.body})
    result = data["commentCreate"]
    if result["success"]:
        print(f"Comment added: {result['comment']['url']}")
    else:
        print("Failed to add comment.", file=sys.stderr)
        sys.exit(1)


# ── search ─────────────────────────────────────────────────────────────────────

def cmd_search(args):
    data = gql("""
    query($term: String!, $first: Int) {
      issueSearch(query: $term, first: $first) {
        nodes {
          id identifier title priority url
          state { name }
          assignee { displayName }
        }
      }
    }
    """, {"term": args.query, "first": args.limit})
    print_issue_list(data["issueSearch"]["nodes"])


# ── project-status ─────────────────────────────────────────────────────────────

def cmd_project_status(args):
    data = gql("""
    query($filter: ProjectFilter) {
      projects(filter: $filter) {
        nodes {
          id name state description url
          progress
          issues {
            nodes {
              identifier title priority
              state { name type }
            }
          }
        }
      }
    }
    """, {"filter": {"name": {"containsIgnoreCase": args.name}}})
    projects = data["projects"]["nodes"]
    if not projects:
        print(f"No project matching '{args.name}' found.")
        return

    for p in projects:
        issues = p.get("issues", {}).get("nodes", [])
        total = len(issues)
        done = sum(1 for i in issues if i.get("state", {}).get("type") in ("completed", "cancelled"))
        pct = round(done / total * 100) if total else 0

        print(f"## {p['name']}")
        print(f"State:    {p['state']}")
        print(f"Progress: {done}/{total} done ({pct}%)")
        if p.get("url"):
            print(f"URL:      {p['url']}")

        # Group by state
        by_state = {}
        for issue in issues:
            state = issue["state"]["name"]
            by_state.setdefault(state, []).append(issue)

        for state, state_issues in by_state.items():
            print(f"\n{state} ({len(state_issues)}):")
            for i in state_issues[:10]:
                priority = PRIORITY_LABELS.get(i.get("priority", 0), "?")
                print(f"  • [{i['identifier']}] {i['title']} [{priority}]")
            if len(state_issues) > 10:
                print(f"  ... and {len(state_issues) - 10} more")


# ── main ───────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Linear API client")
    sub = parser.add_subparsers(dest="command", required=True)

    sub.add_parser("teams", help="List all teams")

    p_proj = sub.add_parser("projects", help="List projects")
    p_proj.add_argument("--team", help="Filter by team key (e.g. ENG)")

    p_issues = sub.add_parser("issues", help="List issues")
    p_issues.add_argument("--assignee", help="Filter by assignee (use 'me' for yourself)")
    p_issues.add_argument("--team", help="Filter by team key")
    p_issues.add_argument("--state", help="Filter by state name")
    p_issues.add_argument("--project", help="Filter by project name")
    p_issues.add_argument("--days", type=int, help="Issues created in last N days")
    p_issues.add_argument("--limit", type=int, default=25, help="Max results (default 25)")

    p_issue = sub.add_parser("issue", help="Get issue detail")
    p_issue.add_argument("id", help="Issue identifier (e.g. ENG-42)")

    p_create = sub.add_parser("create", help="Create an issue")
    p_create.add_argument("--team", required=True, help="Team key (e.g. ENG)")
    p_create.add_argument("--title", required=True, help="Issue title")
    p_create.add_argument("--description", help="Issue description (markdown)")
    p_create.add_argument("--priority", type=int, choices=[0, 1, 2, 3, 4],
                          help="0=None 1=Urgent 2=High 3=Medium 4=Low")
    p_create.add_argument("--state", help="State name (e.g. Todo, Backlog, In Progress)")
    p_create.add_argument("--project", help="Project name to assign the issue to")

    p_bulk = sub.add_parser("bulk-create", help="Create multiple issues from JSON")
    p_bulk.add_argument("--team", required=True, help="Team key (e.g. ENG)")
    p_bulk.add_argument("--project", help="Project name to assign all issues to")
    p_bulk.add_argument("--file", default="-",
                        help="JSON file path, or - to read from stdin (default)")

    p_update = sub.add_parser("update", help="Update an issue")
    p_update.add_argument("id", help="Issue identifier (e.g. ENG-42)")
    p_update.add_argument("--state", help="New state name")
    p_update.add_argument("--priority", type=int, choices=[0, 1, 2, 3, 4])
    p_update.add_argument("--title", help="New title")
    p_update.add_argument("--description", help="New description")

    p_comment = sub.add_parser("comment", help="Add a comment to an issue")
    p_comment.add_argument("id", help="Issue identifier (e.g. ENG-42)")
    p_comment.add_argument("--body", required=True, help="Comment text (markdown)")

    p_search = sub.add_parser("search", help="Search issues")
    p_search.add_argument("query", help="Search term")
    p_search.add_argument("--limit", type=int, default=10)

    p_ps = sub.add_parser("project-status", help="Show project progress summary")
    p_ps.add_argument("name", help="Project name (partial match)")

    args = parser.parse_args()
    commands = {
        "teams": cmd_teams,
        "projects": cmd_projects,
        "issues": cmd_issues,
        "issue": cmd_issue,
        "create": cmd_create,
        "bulk-create": cmd_bulk_create,
        "update": cmd_update,
        "comment": cmd_comment,
        "search": cmd_search,
        "project-status": cmd_project_status,
    }
    commands[args.command](args)


if __name__ == "__main__":
    main()
