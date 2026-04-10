#!/usr/bin/env python3
"""validate-cron.py — validate ~/.openclaw/cron/jobs.json before writing.
Usage: python3 validate-cron.py [path-to-cron-file]

Focus: catch NEW jobs that would crash the gateway (bad JSON, missing required
fields, wrong types). Does NOT audit existing jobs — they may use extended
schema values that this validator doesn't know about.

Exit 0 = valid (safe to write), Exit 1 = hard errors found.
"""
import json, sys, os

CRON_FILE = sys.argv[1] if len(sys.argv) > 1 else os.path.expanduser("~/.openclaw/cron/jobs.json")
NEW_JOB_ID = sys.argv[2] if len(sys.argv) > 2 else None  # optional: validate only this job id

errors = 0
warnings = 0

def err(msg):
    global errors
    print(f"❌ {msg}")
    errors += 1

def warn(msg):
    global warnings
    print(f"⚠️  {msg}")
    warnings += 1

# 1. Valid JSON
try:
    with open(CRON_FILE) as f:
        data = json.load(f)
    print(f"✅ Valid JSON ({os.path.getsize(CRON_FILE)} bytes)")
except json.JSONDecodeError as e:
    err(f"Invalid JSON: {e}")
    sys.exit(1)
except FileNotFoundError:
    err(f"File not found: {CRON_FILE}")
    sys.exit(1)

# 2. Top-level structure
if "jobs" not in data:
    err("Missing 'jobs' array at top level")
    sys.exit(1)

jobs = data["jobs"]
if not isinstance(jobs, list):
    err("'jobs' must be an array")
    sys.exit(1)

print(f"✅ Structure OK ({len(jobs)} jobs total)")

# 3. Validate the specific new job (or last job if no id given)
targets = jobs
if NEW_JOB_ID:
    targets = [j for j in jobs if j.get("id") == NEW_JOB_ID]
    if not targets:
        err(f"Job id '{NEW_JOB_ID}' not found in file")
        sys.exit(1)
    print(f"Validating specific job: {targets[0].get('name', NEW_JOB_ID)}")
else:
    # Only validate the last job (the one we just added)
    targets = [jobs[-1]]
    print(f"Validating last job: {targets[0].get('name', '?')}")

REQUIRED_JOB_FIELDS = {"id", "name", "agentId", "enabled", "schedule", "payload"}
KNOWN_SCHEDULE_KINDS = {"cron", "every", "at"}

for job in targets:
    jname = job.get("name", job.get("id", "?"))

    # Required fields
    for req in REQUIRED_JOB_FIELDS:
        if req not in job:
            err(f"Job '{jname}': missing required field '{req}'")

    # Schedule validity
    sched = job.get("schedule", {})
    if not isinstance(sched, dict):
        err(f"Job '{jname}': 'schedule' must be an object")
    else:
        kind = sched.get("kind")
        if kind not in KNOWN_SCHEDULE_KINDS:
            err(f"Job '{jname}': schedule.kind='{kind}' invalid — must be one of {KNOWN_SCHEDULE_KINDS}")
        elif kind == "cron" and not sched.get("expr"):
            err(f"Job '{jname}': cron schedule missing 'expr'")
        elif kind == "every" and not sched.get("everyMs"):
            err(f"Job '{jname}': 'every' schedule missing 'everyMs'")
        elif kind == "at" and not sched.get("at"):
            err(f"Job '{jname}': 'at' schedule missing 'at'")

    # Payload validity
    payload = job.get("payload", {})
    if not isinstance(payload, dict):
        err(f"Job '{jname}': 'payload' must be an object")
    else:
        if "kind" not in payload:
            err(f"Job '{jname}': payload missing 'kind'")
        if payload.get("kind") == "agentTurn" and not payload.get("message"):
            warn(f"Job '{jname}': agentTurn payload has no 'message'")

    # agentId must be a string
    agent_id = job.get("agentId")
    if agent_id and not isinstance(agent_id, str):
        err(f"Job '{jname}': 'agentId' must be a string, got {type(agent_id)}")

    # enabled must be bool
    enabled = job.get("enabled")
    if enabled is not None and not isinstance(enabled, bool):
        err(f"Job '{jname}': 'enabled' must be boolean, got {type(enabled)}")

    # id must be string
    jid = job.get("id")
    if jid and not isinstance(jid, str):
        err(f"Job '{jname}': 'id' must be a string")

if errors == 0:
    print(f"✅ New job validated OK{' ('+str(warnings)+' warnings)' if warnings else ''}")
else:
    print(f"\n❌ {errors} error(s) — do NOT write until fixed")

sys.exit(min(errors, 1))
