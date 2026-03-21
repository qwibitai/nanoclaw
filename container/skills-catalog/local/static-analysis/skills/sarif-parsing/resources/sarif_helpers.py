"""
SARIF Parsing Helper Functions

Reusable utilities for working with SARIF files.
No external dependencies beyond standard library.
"""

import hashlib
import json
from collections import defaultdict
from collections.abc import Iterator
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any
from urllib.parse import unquote


@dataclass
class Finding:
    """Structured representation of a SARIF result."""

    rule_id: str
    level: str
    message: str
    file_path: str | None = None
    start_line: int | None = None
    end_line: int | None = None
    start_column: int | None = None
    end_column: int | None = None
    fingerprint: str | None = None
    tool_name: str | None = None
    rule_name: str | None = None
    raw: dict = field(default_factory=dict, repr=False)


def load_sarif(path: str | Path) -> dict:
    """Load and parse a SARIF file."""
    with open(path) as f:
        return json.load(f)


def save_sarif(sarif: dict, path: str | Path, indent: int = 2) -> None:
    """Save SARIF data to file."""
    with open(path, "w") as f:
        json.dump(sarif, f, indent=indent)


def validate_version(sarif: dict) -> bool:
    """Check if SARIF version is 2.1.0."""
    return sarif.get("version") == "2.1.0"


def normalize_path(uri: str, base_path: str = "") -> str:
    """Normalize SARIF artifact URI to consistent path."""
    if not uri:
        return ""

    # Remove file:// prefix
    if uri.startswith("file://"):
        uri = uri[7:]

    # URL decode
    uri = unquote(uri)

    # Handle relative paths
    if base_path and not Path(uri).is_absolute():
        uri = str(Path(base_path) / uri)

    return str(Path(uri))


def safe_get(data: dict, *keys, default: Any = None) -> Any:
    """Safely navigate nested dict structure."""
    for key in keys:
        if isinstance(data, dict):
            data = data.get(key, {})
        elif isinstance(data, list) and isinstance(key, int):
            data = data[key] if 0 <= key < len(data) else {}
        else:
            return default
    return data if data != {} else default


def extract_location(result: dict) -> tuple[str | None, int | None, int | None]:
    """Extract file path, start line, and end line from result."""
    loc = safe_get(result, "locations", 0, default={})
    phys = loc.get("physicalLocation", {})
    region = phys.get("region", {})

    file_path = safe_get(phys, "artifactLocation", "uri")
    start_line = region.get("startLine")
    end_line = region.get("endLine")

    return file_path, start_line, end_line


def iter_results(sarif: dict) -> Iterator[tuple[dict, dict]]:
    """Iterate over all results with their run context."""
    for run in sarif.get("runs", []):
        for result in run.get("results", []):
            yield result, run


def extract_findings(sarif: dict) -> list[Finding]:
    """Extract all findings as structured objects."""
    findings = []

    for result, run in iter_results(sarif):
        tool_name = safe_get(run, "tool", "driver", "name")
        file_path, start_line, end_line = extract_location(result)

        loc = safe_get(result, "locations", 0, default={})
        phys = loc.get("physicalLocation", {})
        region = phys.get("region", {})

        # Get fingerprint
        fp = None
        if result.get("partialFingerprints"):
            fp = next(iter(result["partialFingerprints"].values()), None)
        elif result.get("fingerprints"):
            fp = next(iter(result["fingerprints"].values()), None)

        findings.append(
            Finding(
                rule_id=result.get("ruleId", "unknown"),
                level=result.get("level", "warning"),
                message=safe_get(result, "message", "text", default=""),
                file_path=file_path,
                start_line=start_line,
                end_line=end_line,
                start_column=region.get("startColumn"),
                end_column=region.get("endColumn"),
                fingerprint=fp,
                tool_name=tool_name,
                raw=result,
            )
        )

    return findings


def filter_by_level(findings: list[Finding], *levels: str) -> list[Finding]:
    """Filter findings by severity level(s)."""
    return [f for f in findings if f.level in levels]


def filter_by_file(findings: list[Finding], pattern: str) -> list[Finding]:
    """Filter findings by file path pattern (substring match)."""
    return [f for f in findings if f.file_path and pattern in f.file_path]


def filter_by_rule(findings: list[Finding], *rule_ids: str) -> list[Finding]:
    """Filter findings by rule ID(s)."""
    return [f for f in findings if f.rule_id in rule_ids]


def sort_by_severity(findings: list[Finding], reverse: bool = False) -> list[Finding]:
    """Sort findings by severity (error > warning > note > none)."""
    severity_order = {"error": 0, "warning": 1, "note": 2, "none": 3}
    return sorted(findings, key=lambda f: severity_order.get(f.level, 99), reverse=reverse)


def group_by_file(findings: list[Finding]) -> dict[str, list[Finding]]:
    """Group findings by file path."""
    grouped = defaultdict(list)
    for f in findings:
        key = f.file_path or "unknown"
        grouped[key].append(f)
    return dict(grouped)


def group_by_rule(findings: list[Finding]) -> dict[str, list[Finding]]:
    """Group findings by rule ID."""
    grouped = defaultdict(list)
    for f in findings:
        grouped[f.rule_id].append(f)
    return dict(grouped)


def count_by_level(findings: list[Finding]) -> dict[str, int]:
    """Count findings by severity level."""
    counts = defaultdict(int)
    for f in findings:
        counts[f.level] += 1
    return dict(counts)


def count_by_rule(findings: list[Finding]) -> dict[str, int]:
    """Count findings by rule ID."""
    counts = defaultdict(int)
    for f in findings:
        counts[f.rule_id] += 1
    return dict(counts)


def compute_fingerprint(result: dict, include_message: bool = True) -> str:
    """Compute stable fingerprint from result data."""
    components = [result.get("ruleId", "")]

    file_path, start_line, _ = extract_location(result)
    if file_path:
        # Use only filename, not full path (more stable across environments)
        components.append(Path(file_path).name)
    if start_line:
        components.append(str(start_line))
    if include_message:
        msg = safe_get(result, "message", "text", default="")
        # First 50 chars of message for stability
        components.append(msg[:50])

    return hashlib.sha256("|".join(components).encode()).hexdigest()[:16]


def deduplicate(findings: list[Finding]) -> list[Finding]:
    """Remove duplicate findings based on fingerprints."""
    seen = set()
    unique = []

    for f in findings:
        key = f.fingerprint or compute_fingerprint(f.raw)
        if key not in seen:
            seen.add(key)
            unique.append(f)

    return unique


def merge_sarif_files(*paths: str | Path) -> dict:
    """Merge multiple SARIF files into one."""
    merged = {
        "version": "2.1.0",
        "$schema": "https://json.schemastore.org/sarif-2.1.0.json",
        "runs": [],
    }

    for path in paths:
        sarif = load_sarif(path)
        merged["runs"].extend(sarif.get("runs", []))

    return merged


def diff_findings(
    baseline: list[Finding], current: list[Finding]
) -> tuple[list[Finding], list[Finding], list[Finding]]:
    """
    Compare two sets of findings.

    Returns:
        - new: findings in current but not baseline
        - fixed: findings in baseline but not current
        - unchanged: findings in both
    """
    baseline_fps = {f.fingerprint or compute_fingerprint(f.raw) for f in baseline}
    current_fps = {f.fingerprint or compute_fingerprint(f.raw) for f in current}

    new = [f for f in current if (f.fingerprint or compute_fingerprint(f.raw)) not in baseline_fps]
    fixed = [
        f for f in baseline if (f.fingerprint or compute_fingerprint(f.raw)) not in current_fps
    ]
    unchanged = [
        f for f in current if (f.fingerprint or compute_fingerprint(f.raw)) in baseline_fps
    ]

    return new, fixed, unchanged


def get_rules(sarif: dict) -> dict[str, dict]:
    """Extract rule definitions from SARIF file."""
    rules = {}
    for run in sarif.get("runs", []):
        for rule in safe_get(run, "tool", "driver", "rules", default=[]):
            rules[rule.get("id", "")] = rule
    return rules


def to_csv_rows(findings: list[Finding]) -> list[list[str]]:
    """Convert findings to CSV-ready rows."""
    rows = [["rule_id", "level", "file", "line", "message"]]
    for f in findings:
        rows.append(
            [
                f.rule_id,
                f.level,
                f.file_path or "",
                str(f.start_line or ""),
                f.message.replace("\n", " ")[:200],
            ]
        )
    return rows


def summary(findings: list[Finding]) -> dict:
    """Generate summary statistics for findings."""
    return {
        "total": len(findings),
        "by_level": count_by_level(findings),
        "by_rule": count_by_rule(findings),
        "files_affected": len(set(f.file_path for f in findings if f.file_path)),
        "rules_triggered": len(set(f.rule_id for f in findings)),
    }


# Example usage
if __name__ == "__main__":
    import sys

    if len(sys.argv) < 2:
        print("Usage: python sarif_helpers.py <sarif_file>")
        sys.exit(1)

    sarif = load_sarif(sys.argv[1])

    if not validate_version(sarif):
        print("Warning: SARIF version is not 2.1.0")

    findings = extract_findings(sarif)
    findings = sort_by_severity(findings)

    print("\nSummary:")
    stats = summary(findings)
    print(f"  Total findings: {stats['total']}")
    print(f"  Files affected: {stats['files_affected']}")
    print(f"  Rules triggered: {stats['rules_triggered']}")
    print("\nBy severity:")
    for level, count in stats["by_level"].items():
        print(f"  {level}: {count}")

    print("\nTop 5 rules:")
    for rule, count in sorted(stats["by_rule"].items(), key=lambda x: -x[1])[:5]:
        print(f"  {rule}: {count}")
