#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

python3 - "$ROOT_DIR" "$@" <<'PY'
import argparse
import json
import os
import sys
import tempfile
from datetime import datetime, timezone

root_dir = sys.argv[1]
argv = sys.argv[2:]
default_registry = os.path.join(root_dir, ".claude", "progress", "incident.json")


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def ensure_parent(path: str) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)


def compact_text(value, max_len=500) -> str:
    text = "" if value is None else str(value)
    text = " ".join(text.split()).strip()
    if len(text) > max_len:
        text = text[: max_len - 3].rstrip() + "..."
    return text


def default_registry_doc() -> dict:
    return {
        "schema_version": 2,
        "updated_at": now_iso(),
        "incidents": [],
    }


def parse_iso(value: str) -> str:
    if not value:
        return ""
    s = str(value).strip()
    if not s:
        return ""
    try:
        datetime.fromisoformat(s.replace("Z", "+00:00"))
        return s
    except Exception:
        return ""


def normalize_notes(raw_notes):
    out = []
    if not isinstance(raw_notes, list):
        return out
    for note in raw_notes:
        if not isinstance(note, dict):
            continue
        text = compact_text(note.get("text", ""), 800)
        if not text:
            continue
        ts = parse_iso(note.get("ts") or note.get("timestamp") or now_iso()) or now_iso()
        author = compact_text(note.get("author", "operator"), 80) or "operator"
        out.append({"ts": ts, "author": author, "text": text})
    return out[-3:]


def maybe_last_occurrence(raw: dict) -> dict:
    occ = raw.get("occurrences")
    if not isinstance(occ, list) or not occ:
        return {}
    last = occ[-1]
    return last if isinstance(last, dict) else {}


def normalize_context(raw: dict) -> dict:
    ctx = {}
    raw_ctx = raw.get("context") if isinstance(raw.get("context"), dict) else {}
    lane = compact_text(raw.get("lane") or raw_ctx.get("lane"), 120)
    chat_jid = compact_text(raw.get("chat_jid") or raw_ctx.get("chat_jid"), 180)
    run_id = compact_text(raw.get("run_id") or raw_ctx.get("run_id"), 180)
    if lane:
        ctx["lane"] = lane
    if chat_jid:
        ctx["chat_jid"] = chat_jid
    if run_id:
        ctx["run_id"] = run_id
    return ctx


def normalize_resolution(raw_resolution, raw_incident):
    if not isinstance(raw_resolution, dict):
        return None
    summary = compact_text(raw_resolution.get("summary"), 500)
    verification = compact_text(raw_resolution.get("verification"), 500)
    fix_reference = compact_text(raw_resolution.get("fix_reference"), 240)
    confirmed_by_user = compact_text(
        raw_resolution.get("confirmed_by_user") or raw_resolution.get("confirmed_by"),
        240,
    )
    confirmed_at = parse_iso(raw_resolution.get("confirmed_at") or raw_incident.get("resolved_at")) or now_iso()
    resolved_by = compact_text(raw_resolution.get("resolved_by"), 80)

    resolution = {
        "summary": summary,
        "confirmed_by_user": confirmed_by_user,
        "confirmed_at": confirmed_at,
    }
    if verification:
        resolution["verification"] = verification
    if fix_reference:
        resolution["fix_reference"] = fix_reference
    if resolved_by:
        resolution["resolved_by"] = resolved_by

    if not summary and not confirmed_by_user:
        return None
    return resolution


def next_action_for_root_cause(root_cause: str) -> str:
    mapping = {
        "dispatch_blocked": "Run dispatch-lint on payload, fix branch/contract fields, then redispatch.",
        "wa_conflict_churn": "Stabilize WhatsApp session, run recover, then verify with status+trace.",
        "schema_drift": "Run db-doctor, apply migrations/schema fix, restart service, rerun preflight.",
        "container_stale": "Run recover, clear stale runs, verify container runtime and worker lanes.",
        "no_ingest": "Validate WhatsApp/channel ingest path and recent message arrival.",
    }
    return mapping.get(root_cause, "Run status + trace + reliability and capture an incident bundle.")


def normalize_incident(raw: dict) -> dict:
    ts_now = now_iso()
    incident_id = compact_text(raw.get("id"), 180)
    if not incident_id:
        incident_id = f"incident-{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')}"

    title = compact_text(raw.get("title") or f"Incident {incident_id}", 260)
    status = raw.get("status", "open")
    if status not in {"open", "resolved"}:
        status = "open"

    severity = compact_text(raw.get("severity") or "unknown", 40) or "unknown"
    created_at = parse_iso(raw.get("created_at")) or ts_now
    updated_at = parse_iso(raw.get("updated_at")) or created_at
    resolved_at = parse_iso(raw.get("resolved_at"))

    context = normalize_context(raw)

    occ = maybe_last_occurrence(raw)
    occ_root_cause = compact_text(occ.get("root_cause"), 120)
    occ_bundle = compact_text(occ.get("bundle_dir"), 600)
    occ_manifest = compact_text(occ.get("manifest_path"), 600)
    occ_status = compact_text(occ.get("overall_status"), 40)
    occ_non_zero = occ.get("non_zero_command_count")
    occ_ts = parse_iso(occ.get("timestamp"))

    summary_raw = raw.get("summary") if isinstance(raw.get("summary"), dict) else {}
    notes = normalize_notes(raw.get("notes", []))
    latest_note_text = notes[-1]["text"] if notes else ""

    suspected_cause = compact_text(
        summary_raw.get("suspected_cause")
        or raw.get("cause")
        or raw.get("evidence_root_cause")
        or occ_root_cause
        or "unknown",
        140,
    )

    symptom = compact_text(summary_raw.get("symptom") or raw.get("latest_note") or latest_note_text or title, 500)
    impact = compact_text(summary_raw.get("impact") or raw.get("impact"), 500)
    next_action = compact_text(summary_raw.get("next_action") or raw.get("next_action"), 500)

    evidence_raw = raw.get("evidence") if isinstance(raw.get("evidence"), dict) else {}
    evidence = {"bundle_count": 0}

    bundle_count = evidence_raw.get("bundle_count")
    if isinstance(bundle_count, int):
        evidence["bundle_count"] = max(bundle_count, 0)
    else:
        old_count = raw.get("bundle_count")
        if isinstance(old_count, int):
            evidence["bundle_count"] = max(old_count, 0)
        elif isinstance(raw.get("occurrences"), list):
            evidence["bundle_count"] = len(raw.get("occurrences"))
        elif occ_bundle:
            evidence["bundle_count"] = 1

    last_bundle = compact_text(
        evidence_raw.get("last_bundle_dir") or raw.get("evidence_bundle") or occ_bundle,
        600,
    )
    last_manifest = compact_text(
        evidence_raw.get("last_manifest_path") or raw.get("evidence_manifest") or occ_manifest,
        600,
    )
    last_root_cause = compact_text(
        evidence_raw.get("last_root_cause") or raw.get("evidence_root_cause") or occ_root_cause,
        140,
    )
    evidence_status = compact_text(
        evidence_raw.get("last_status") or raw.get("evidence_status") or occ_status,
        40,
    )
    last_checked_at = parse_iso(
        evidence_raw.get("last_checked_at") or raw.get("last_debug_at") or occ_ts
    )

    non_zero = evidence_raw.get("non_zero_command_count")
    if not isinstance(non_zero, int) and isinstance(occ_non_zero, int):
        non_zero = occ_non_zero

    debug_summary = compact_text(
        evidence_raw.get("debug_summary") or raw.get("debug_summary"),
        500,
    )

    if last_bundle:
        evidence["last_bundle_dir"] = last_bundle
    if last_manifest:
        evidence["last_manifest_path"] = last_manifest
    if last_root_cause:
        evidence["last_root_cause"] = last_root_cause
    if evidence_status:
        evidence["last_status"] = evidence_status
    if last_checked_at:
        evidence["last_checked_at"] = last_checked_at
    if isinstance(non_zero, int):
        evidence["non_zero_command_count"] = non_zero
    if debug_summary:
        evidence["debug_summary"] = debug_summary

    resolution = normalize_resolution(raw.get("resolution"), raw)
    if status == "resolved" and resolution is None:
        status = "open"
        resolved_at = ""

    incident = {
        "id": incident_id,
        "title": title,
        "status": status,
        "severity": severity,
        "created_at": created_at,
        "updated_at": updated_at,
        "summary": {
            "symptom": symptom,
            "suspected_cause": suspected_cause,
        },
        "evidence": evidence,
    }

    if context:
        incident["context"] = context
    if impact:
        incident["summary"]["impact"] = impact
    if next_action:
        incident["summary"]["next_action"] = next_action
    if notes:
        incident["notes"] = notes
    if status == "resolved" and resolution is not None:
        incident["resolution"] = resolution
        incident["resolved_at"] = parse_iso(resolved_at) or resolution.get("confirmed_at") or now_iso()

    return incident


def normalize_registry(doc: dict) -> dict:
    incidents_in = doc.get("incidents") if isinstance(doc, dict) else []
    if not isinstance(incidents_in, list):
        incidents_in = []

    dedup = {}
    for raw in incidents_in:
        if not isinstance(raw, dict):
            continue
        incident = normalize_incident(raw)
        iid = incident["id"]
        prev = dedup.get(iid)
        if prev is None:
            dedup[iid] = incident
        else:
            if incident.get("updated_at", "") >= prev.get("updated_at", ""):
                dedup[iid] = incident

    incidents = sorted(dedup.values(), key=lambda x: x.get("updated_at", ""), reverse=True)

    return {
        "schema_version": 2,
        "updated_at": parse_iso(doc.get("updated_at") if isinstance(doc, dict) else "") or now_iso(),
        "incidents": incidents,
    }


def load_registry(path: str) -> dict:
    ensure_parent(path)
    if not os.path.exists(path) or os.path.getsize(path) == 0:
        doc = default_registry_doc()
        save_registry(path, doc)
        return doc

    with open(path, "r", encoding="utf-8") as f:
        try:
            raw = json.load(f)
        except json.JSONDecodeError as e:
            raise RuntimeError(f"invalid registry JSON at {path}: {e}") from e

    if not isinstance(raw, dict):
        raise RuntimeError(f"registry root must be object: {path}")

    return normalize_registry(raw)


def atomic_write_json(path: str, payload: dict) -> None:
    ensure_parent(path)
    dir_path = os.path.dirname(path) or "."
    fd, tmp_path = tempfile.mkstemp(
        prefix=".incident-write-",
        suffix=".json.tmp",
        dir=dir_path,
    )
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(payload, f, ensure_ascii=True, indent=2)
            f.write("\n")
            f.flush()
            os.fsync(f.fileno())
        with open(tmp_path, "r", encoding="utf-8") as f:
            json.load(f)
        os.replace(tmp_path, path)
    except Exception:
        try:
            os.unlink(tmp_path)
        except FileNotFoundError:
            pass
        raise


def save_registry(path: str, doc: dict) -> None:
    ensure_parent(path)
    normalized = normalize_registry(doc)
    normalized["updated_at"] = now_iso()
    atomic_write_json(path, normalized)


def find_incident(doc: dict, incident_id: str):
    incidents = doc.get("incidents", [])
    for i, item in enumerate(incidents):
        if item.get("id") == incident_id:
            return i, item
    return None, None


def maybe_load_json(path: str):
    if not path or not os.path.exists(path):
        return None
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return None


def output(payload: dict, args):
    if getattr(args, "json", False):
        print(json.dumps(payload, ensure_ascii=True, indent=2))
    else:
        msg = payload.get("message")
        if msg:
            print(msg)

    json_out = getattr(args, "json_out", "")
    if json_out:
        atomic_write_json(json_out, payload)


def shared_output_flags(p):
    p.add_argument("--json", action="store_true", help="Emit JSON payload")
    p.add_argument("--json-out", default="", help="Write JSON payload to file")


def ensure_summary(incident: dict):
    summary = incident.get("summary")
    if not isinstance(summary, dict):
        summary = {"symptom": incident.get("title", ""), "suspected_cause": "unknown"}
        incident["summary"] = summary
    summary.setdefault("symptom", incident.get("title", ""))
    summary.setdefault("suspected_cause", "unknown")
    return summary


def ensure_evidence(incident: dict):
    evidence = incident.get("evidence")
    if not isinstance(evidence, dict):
        evidence = {"bundle_count": 0}
        incident["evidence"] = evidence
    if not isinstance(evidence.get("bundle_count"), int):
        evidence["bundle_count"] = 0
    return evidence


parser = argparse.ArgumentParser(
    prog="scripts/jarvis-incident.sh",
    description="Compact incident lifecycle management for .claude/progress/incident.json",
)
parser.add_argument(
    "--registry",
    default=default_registry,
    help=f"Registry JSON path (default: {default_registry})",
)

sub = parser.add_subparsers(dest="command", required=True)

p_init = sub.add_parser("init", help="Initialize/migrate registry file")
shared_output_flags(p_init)

p_add = sub.add_parser("add", help="Create a new open incident")
p_add.add_argument("--id", default="", help="Incident ID (default: incident-<timestamp>)")
p_add.add_argument("--title", required=True, help="Incident title")
p_add.add_argument("--severity", default="unknown", help="Severity label")
p_add.add_argument("--lane", default="", help="Lane context")
p_add.add_argument("--chat-jid", default="", help="Chat context")
p_add.add_argument("--run-id", default="", help="Run context")
p_add.add_argument("--symptom", default="", help="Symptom summary")
p_add.add_argument("--cause", default="", help="Initial suspected cause")
p_add.add_argument("--impact", default="", help="Impact summary")
p_add.add_argument("--next-action", default="", help="Next action summary")
p_add.add_argument("--reported-by", default="user", help="Reporter")
shared_output_flags(p_add)

p_list = sub.add_parser("list", help="List incidents")
p_list.add_argument("--status", choices=["open", "resolved", "all"], default="all", help="Filter by status")
shared_output_flags(p_list)

p_show = sub.add_parser("show", help="Show one incident")
p_show.add_argument("--id", required=True, help="Incident ID")
shared_output_flags(p_show)

p_note = sub.add_parser("note", help="Add compact note to incident")
p_note.add_argument("--id", required=True, help="Incident ID")
p_note.add_argument("--note", required=True, help="Note text")
p_note.add_argument("--author", default="operator", help="Note author")
shared_output_flags(p_note)

p_enrich = sub.add_parser("enrich", help="Update incident cause/details/evidence after debugging")
p_enrich.add_argument("--id", required=True, help="Incident ID")
p_enrich.add_argument("--symptom", default="", help="Symptom summary")
p_enrich.add_argument("--cause", default="", help="Suspected/root cause")
p_enrich.add_argument("--impact", default="", help="Impact summary")
p_enrich.add_argument("--next-action", default="", help="Next action summary")
p_enrich.add_argument("--severity", default="", help="Severity override")
p_enrich.add_argument("--lane", default="", help="Lane context")
p_enrich.add_argument("--chat-jid", default="", help="Chat context")
p_enrich.add_argument("--run-id", default="", help="Run context")
p_enrich.add_argument("--bundle-dir", default="", help="Evidence bundle dir")
p_enrich.add_argument("--manifest", default="", help="Evidence manifest path")
p_enrich.add_argument("--root-cause", default="", help="Root cause override")
p_enrich.add_argument("--evidence-status", default="", help="Evidence overall status")
p_enrich.add_argument("--non-zero-commands", type=int, default=None, help="Non-zero command count")
p_enrich.add_argument("--debug-summary", default="", help="Compact debug summary")
shared_output_flags(p_enrich)

p_reopen = sub.add_parser("reopen", help="Reopen a resolved incident")
p_reopen.add_argument("--id", required=True, help="Incident ID")
p_reopen.add_argument("--reason", required=True, help="Reopen reason")
p_reopen.add_argument("--reopened-by", default="operator", help="Actor")
shared_output_flags(p_reopen)

p_resolve = sub.add_parser("resolve", help="Resolve incident (requires explicit user confirmation)")
p_resolve.add_argument("--id", required=True, help="Incident ID")
p_resolve.add_argument("--resolution", required=True, help="Exact fix summary")
p_resolve.add_argument("--verification", default="", help="Verification evidence")
p_resolve.add_argument("--fix-reference", default="", help="Commit/PR/script/docs reference")
p_resolve.add_argument("--prevention-note", required=True, help="Prevention action added to avoid recurrence")
p_resolve.add_argument("--lesson-reference", required=True, help="Path/reference where lesson was persisted (CLAUDE/docs)")
p_resolve.add_argument("--resolved-by", default="user", help="Actor recording resolution")
p_resolve.add_argument("--user-confirmed-fixed", action="store_true", help="Required guard to resolve")
p_resolve.add_argument("--user-confirmation", required=True, help="Explicit user confirmation text")
shared_output_flags(p_resolve)

p_register = sub.add_parser("register-bundle", help="Register debug bundle evidence onto an incident")
p_register.add_argument("--bundle-dir", required=True, help="Incident bundle directory")
p_register.add_argument("--manifest", default="", help="Manifest path (default: <bundle-dir>/manifest.json)")
p_register.add_argument("--incident-id", default="", help="Existing incident ID to update")
p_register.add_argument("--title", default="", help="Title for newly created incident")
p_register.add_argument("--lane", default="", help="Lane context")
p_register.add_argument("--chat-jid", default="", help="Chat context")
p_register.add_argument("--run-id", default="", help="Run context")
shared_output_flags(p_register)

args = parser.parse_args(argv)

try:
    doc = load_registry(args.registry)
except Exception as e:
    print(f"error: {e}", file=sys.stderr)
    sys.exit(1)

if args.command == "init":
    save_registry(args.registry, doc)
    payload = {
        "script": "jarvis-incident",
        "command": "init",
        "registry": args.registry,
        "schema_version": 2,
        "incident_count": len(doc.get("incidents", [])),
        "message": f"incident registry ready: {args.registry}",
    }
    output(payload, args)
    sys.exit(0)

if args.command == "add":
    ts = now_iso()
    incident_id = compact_text(args.id, 180) or f"incident-{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')}"
    _, existing = find_incident(doc, incident_id)
    if existing is not None:
        print(f"error: incident already exists: {incident_id}", file=sys.stderr)
        sys.exit(1)

    summary = {
        "symptom": compact_text(args.symptom or args.title, 500) or compact_text(args.title, 260),
        "suspected_cause": compact_text(args.cause, 140) or "unknown",
    }
    impact = compact_text(args.impact, 500)
    next_action = compact_text(args.next_action, 500)
    if impact:
        summary["impact"] = impact
    if next_action:
        summary["next_action"] = next_action

    incident = {
        "id": incident_id,
        "title": compact_text(args.title, 260),
        "status": "open",
        "severity": compact_text(args.severity, 40) or "unknown",
        "created_at": ts,
        "updated_at": ts,
        "summary": summary,
        "evidence": {"bundle_count": 0},
    }

    context = {}
    lane = compact_text(args.lane, 120)
    chat_jid = compact_text(args.chat_jid, 180)
    run_id = compact_text(args.run_id, 180)
    if lane:
        context["lane"] = lane
    if chat_jid:
        context["chat_jid"] = chat_jid
    if run_id:
        context["run_id"] = run_id
    if context:
        incident["context"] = context

    reporter = compact_text(args.reported_by, 80)
    if reporter:
        incident["notes"] = [{"ts": ts, "author": reporter, "text": f"reported: {summary['symptom']}"}]

    doc["incidents"].append(incident)
    save_registry(args.registry, doc)
    payload = {
        "script": "jarvis-incident",
        "command": "add",
        "registry": args.registry,
        "incident_id": incident_id,
        "status": "open",
        "message": f"incident added: {incident_id}",
    }
    output(payload, args)
    sys.exit(0)

if args.command == "list":
    incidents = doc.get("incidents", [])
    if args.status != "all":
        incidents = [i for i in incidents if i.get("status") == args.status]

    payload = {
        "script": "jarvis-incident",
        "command": "list",
        "registry": args.registry,
        "status_filter": args.status,
        "count": len(incidents),
        "incidents": incidents,
    }

    if args.json:
        output(payload, args)
    else:
        print(f"== Incident Registry ({args.status}) ==")
        if not incidents:
            print("(no incidents)")
        for item in incidents:
            summary = item.get("summary") if isinstance(item.get("summary"), dict) else {}
            evidence = item.get("evidence") if isinstance(item.get("evidence"), dict) else {}
            cause = summary.get("suspected_cause", "unknown")
            bundles = evidence.get("bundle_count", 0)
            print(
                f"- {item.get('id')} | {item.get('status')} | sev={item.get('severity','unknown')} | cause={cause} | bundles={bundles} | updated={item.get('updated_at')}"
            )
        if args.json_out:
            output(payload, argparse.Namespace(json=False, json_out=args.json_out))
    sys.exit(0)

if args.command == "show":
    _, incident = find_incident(doc, args.id)
    if incident is None:
        print(f"error: incident not found: {args.id}", file=sys.stderr)
        sys.exit(1)

    payload = {
        "script": "jarvis-incident",
        "command": "show",
        "registry": args.registry,
        "incident": incident,
    }

    if args.json:
        output(payload, args)
    else:
        print(f"== Incident {args.id} ==")
        print(f"status: {incident.get('status')}")
        print(f"severity: {incident.get('severity')}")
        print(f"title: {incident.get('title')}")
        print(f"created_at: {incident.get('created_at')}")
        print(f"updated_at: {incident.get('updated_at')}")
        summary = incident.get("summary", {})
        print(f"symptom: {summary.get('symptom')}")
        print(f"suspected_cause: {summary.get('suspected_cause')}")
        if summary.get("impact"):
            print(f"impact: {summary.get('impact')}")
        if summary.get("next_action"):
            print(f"next_action: {summary.get('next_action')}")
        evidence = incident.get("evidence", {})
        print(f"bundle_count: {evidence.get('bundle_count', 0)}")
        if evidence.get("last_bundle_dir"):
            print(f"last_bundle_dir: {evidence.get('last_bundle_dir')}")
        if evidence.get("last_root_cause"):
            print(f"last_root_cause: {evidence.get('last_root_cause')}")
        if incident.get("resolution"):
            res = incident["resolution"]
            print("resolution:")
            print(f"  summary: {res.get('summary')}")
            print(f"  verification: {res.get('verification','')}")
            print(f"  fix_reference: {res.get('fix_reference','')}")
            print(f"  prevention_note: {res.get('prevention_note','')}")
            print(f"  lesson_reference: {res.get('lesson_reference','')}")
            print(f"  confirmed_by_user: {res.get('confirmed_by_user','')}")
            print(f"  confirmed_at: {res.get('confirmed_at','')}")
        if args.json_out:
            output(payload, argparse.Namespace(json=False, json_out=args.json_out))
    sys.exit(0)

if args.command == "note":
    idx, incident = find_incident(doc, args.id)
    if incident is None:
        print(f"error: incident not found: {args.id}", file=sys.stderr)
        sys.exit(1)

    notes = normalize_notes(incident.get("notes", []))
    note_obj = {
        "ts": now_iso(),
        "author": compact_text(args.author, 80) or "operator",
        "text": compact_text(args.note, 800),
    }
    if not note_obj["text"]:
        print("error: note text is empty after normalization", file=sys.stderr)
        sys.exit(1)

    notes.append(note_obj)
    incident["notes"] = notes[-3:]
    incident["updated_at"] = now_iso()
    doc["incidents"][idx] = incident
    save_registry(args.registry, doc)

    payload = {
        "script": "jarvis-incident",
        "command": "note",
        "registry": args.registry,
        "incident_id": args.id,
        "note": note_obj,
        "message": f"note added to {args.id}",
    }
    output(payload, args)
    sys.exit(0)

if args.command == "enrich":
    idx, incident = find_incident(doc, args.id)
    if incident is None:
        print(f"error: incident not found: {args.id}", file=sys.stderr)
        sys.exit(1)

    summary = ensure_summary(incident)
    evidence = ensure_evidence(incident)

    if args.symptom:
        summary["symptom"] = compact_text(args.symptom, 500)
    if args.cause:
        summary["suspected_cause"] = compact_text(args.cause, 140)
    if args.impact:
        summary["impact"] = compact_text(args.impact, 500)
    if args.next_action:
        summary["next_action"] = compact_text(args.next_action, 500)
    if args.root_cause:
        root = compact_text(args.root_cause, 140)
        summary["suspected_cause"] = root
        evidence["last_root_cause"] = root
        if "next_action" not in summary or not summary.get("next_action"):
            summary["next_action"] = next_action_for_root_cause(root)

    if args.bundle_dir:
        bundle = compact_text(args.bundle_dir, 600)
        if bundle and evidence.get("last_bundle_dir") != bundle:
            evidence["bundle_count"] = int(evidence.get("bundle_count", 0)) + 1
        evidence["last_bundle_dir"] = bundle
        evidence["last_checked_at"] = now_iso()
    if args.manifest:
        evidence["last_manifest_path"] = compact_text(args.manifest, 600)
    if args.evidence_status:
        evidence["last_status"] = compact_text(args.evidence_status, 40)
    if args.non_zero_commands is not None:
        evidence["non_zero_command_count"] = max(0, int(args.non_zero_commands))
    if args.debug_summary:
        evidence["debug_summary"] = compact_text(args.debug_summary, 500)

    context = incident.get("context") if isinstance(incident.get("context"), dict) else {}
    if args.lane:
        context["lane"] = compact_text(args.lane, 120)
    if args.chat_jid:
        context["chat_jid"] = compact_text(args.chat_jid, 180)
    if args.run_id:
        context["run_id"] = compact_text(args.run_id, 180)
    if context:
        incident["context"] = context

    if args.severity:
        incident["severity"] = compact_text(args.severity, 40)

    incident["summary"] = summary
    incident["evidence"] = evidence
    incident["updated_at"] = now_iso()
    doc["incidents"][idx] = incident
    save_registry(args.registry, doc)

    payload = {
        "script": "jarvis-incident",
        "command": "enrich",
        "registry": args.registry,
        "incident_id": args.id,
        "status": incident.get("status"),
        "message": f"incident enriched: {args.id}",
    }
    output(payload, args)
    sys.exit(0)

if args.command == "reopen":
    idx, incident = find_incident(doc, args.id)
    if incident is None:
        print(f"error: incident not found: {args.id}", file=sys.stderr)
        sys.exit(1)

    previous_resolution = incident.get("resolution") if isinstance(incident.get("resolution"), dict) else None
    incident["status"] = "open"
    incident.pop("resolved_at", None)
    incident.pop("resolution", None)
    incident["updated_at"] = now_iso()

    summary = ensure_summary(incident)
    if args.reason and not summary.get("next_action"):
        summary["next_action"] = compact_text(args.reason, 500)
    incident["summary"] = summary

    note_text = f"reopened by {compact_text(args.reopened_by,80) or 'operator'}: {compact_text(args.reason,500)}"
    if previous_resolution and previous_resolution.get("summary"):
        note_text += f" | previous_resolution={compact_text(previous_resolution.get('summary'),220)}"

    notes = normalize_notes(incident.get("notes", []))
    notes.append({"ts": now_iso(), "author": compact_text(args.reopened_by,80) or "operator", "text": note_text})
    incident["notes"] = notes[-3:]

    doc["incidents"][idx] = incident
    save_registry(args.registry, doc)

    payload = {
        "script": "jarvis-incident",
        "command": "reopen",
        "registry": args.registry,
        "incident_id": args.id,
        "status": "open",
        "message": f"incident reopened: {args.id}",
    }
    output(payload, args)
    sys.exit(0)

if args.command == "resolve":
    if not args.user_confirmed_fixed:
        print("error: --user-confirmed-fixed is required to mark incident resolved", file=sys.stderr)
        sys.exit(1)
    if len(compact_text(args.user_confirmation, 240)) < 3:
        print("error: --user-confirmation must be explicit", file=sys.stderr)
        sys.exit(1)
    if len(compact_text(args.verification, 500)) < 3:
        print("error: --verification is required for resolution evidence", file=sys.stderr)
        sys.exit(1)
    if len(compact_text(args.fix_reference, 240)) < 3:
        print("error: --fix-reference is required for resolution evidence", file=sys.stderr)
        sys.exit(1)
    if len(compact_text(args.prevention_note, 500)) < 5:
        print("error: --prevention-note is required to document recurrence prevention", file=sys.stderr)
        sys.exit(1)
    if len(compact_text(args.lesson_reference, 240)) < 3:
        print("error: --lesson-reference is required (CLAUDE/docs path or link)", file=sys.stderr)
        sys.exit(1)

    idx, incident = find_incident(doc, args.id)
    if incident is None:
        print(f"error: incident not found: {args.id}", file=sys.stderr)
        sys.exit(1)

    ts = now_iso()
    resolution = {
        "summary": compact_text(args.resolution, 500),
        "verification": compact_text(args.verification, 500),
        "fix_reference": compact_text(args.fix_reference, 240),
        "prevention_note": compact_text(args.prevention_note, 500),
        "lesson_reference": compact_text(args.lesson_reference, 240),
        "confirmed_by_user": compact_text(args.user_confirmation, 240),
        "confirmed_at": ts,
        "resolved_by": compact_text(args.resolved_by, 80) or "user",
    }

    incident["status"] = "resolved"
    incident["resolved_at"] = ts
    incident["updated_at"] = ts
    incident["resolution"] = resolution
    doc["incidents"][idx] = incident
    save_registry(args.registry, doc)

    payload = {
        "script": "jarvis-incident",
        "command": "resolve",
        "registry": args.registry,
        "incident_id": args.id,
        "status": "resolved",
        "resolution": resolution,
        "message": f"incident resolved: {args.id}",
    }
    output(payload, args)
    sys.exit(0)

if args.command == "register-bundle":
    manifest_path = args.manifest or os.path.join(args.bundle_dir, "manifest.json")
    manifest = maybe_load_json(manifest_path)
    if manifest is None:
        print(f"error: manifest not found or invalid: {manifest_path}", file=sys.stderr)
        sys.exit(1)

    trace_json_path = os.path.join(args.bundle_dir, "commands", "trace.json")
    trace = maybe_load_json(trace_json_path) or {}
    metrics = trace.get("metrics") if isinstance(trace.get("metrics"), dict) else {}

    root_cause = compact_text(trace.get("root_cause") or "unknown", 140) or "unknown"
    non_zero_commands = manifest.get("non_zero_command_count")
    if not isinstance(non_zero_commands, int):
        non_zero_commands = 0

    incident_id = compact_text(args.incident_id, 180) or compact_text(os.path.basename(args.bundle_dir.rstrip("/")), 180)
    idx, incident = find_incident(doc, incident_id)
    created = False
    reopened = False

    if incident is None:
        created = True
        ts = now_iso()
        incident = {
            "id": incident_id,
            "title": compact_text(args.title, 260) or f"Incident {incident_id}",
            "status": "open",
            "severity": "unknown",
            "created_at": ts,
            "updated_at": ts,
            "summary": {
                "symptom": compact_text(args.title, 500) or f"Debug incident {incident_id}",
                "suspected_cause": root_cause,
                "next_action": next_action_for_root_cause(root_cause),
            },
            "evidence": {"bundle_count": 0},
        }
        doc["incidents"].append(incident)
        idx = len(doc["incidents"]) - 1
    else:
        if incident.get("status") == "resolved":
            reopened = True
            incident["status"] = "open"
            incident.pop("resolved_at", None)
            incident.pop("resolution", None)

    summary = ensure_summary(incident)
    evidence = ensure_evidence(incident)

    previous_bundle = evidence.get("last_bundle_dir", "")
    if compact_text(args.bundle_dir, 600) and previous_bundle != compact_text(args.bundle_dir, 600):
        evidence["bundle_count"] = int(evidence.get("bundle_count", 0)) + 1

    evidence["last_bundle_dir"] = compact_text(args.bundle_dir, 600)
    evidence["last_manifest_path"] = compact_text(manifest_path, 600)
    evidence["last_root_cause"] = root_cause
    evidence["last_status"] = compact_text(manifest.get("overall_status"), 40)
    evidence["last_checked_at"] = now_iso()
    evidence["non_zero_command_count"] = non_zero_commands

    debug_summary = (
        f"root_cause={root_cause}; messages={metrics.get('messages', 0)}; "
        f"worker_runs={metrics.get('worker_runs', 0)}; dispatch_blocks={metrics.get('dispatch_blocks', 0)}; "
        f"non_zero_commands={non_zero_commands}"
    )
    evidence["debug_summary"] = compact_text(debug_summary, 500)

    summary["suspected_cause"] = root_cause
    if not summary.get("next_action") or summary.get("suspected_cause") != root_cause:
        summary["next_action"] = next_action_for_root_cause(root_cause)

    context = incident.get("context") if isinstance(incident.get("context"), dict) else {}
    lane = compact_text(args.lane, 120)
    chat_jid = compact_text(args.chat_jid, 180)
    run_id = compact_text(args.run_id, 180)
    if lane:
        context["lane"] = lane
    if chat_jid:
        context["chat_jid"] = chat_jid
    if run_id:
        context["run_id"] = run_id
    if context:
        incident["context"] = context

    incident["summary"] = summary
    incident["evidence"] = evidence
    incident["updated_at"] = now_iso()
    doc["incidents"][idx] = incident
    save_registry(args.registry, doc)

    payload = {
        "script": "jarvis-incident",
        "command": "register-bundle",
        "registry": args.registry,
        "incident_id": incident_id,
        "created": created,
        "reopened": reopened,
        "status": incident.get("status"),
        "occurrence_count": evidence.get("bundle_count", 0),
        "root_cause": root_cause,
        "message": f"incident tracked: {incident_id} (status={incident.get('status')})",
    }
    output(payload, args)
    sys.exit(0)

print(f"error: unsupported command: {args.command}", file=sys.stderr)
sys.exit(1)
PY
