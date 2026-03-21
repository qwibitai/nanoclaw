# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""Merge SARIF files into a single consolidated output.

Usage:
    uv run merge_sarif.py RAW_DIR OUTPUT_FILE

Reads *.sarif files from RAW_DIR (e.g., $OUTPUT_DIR/raw), produces
OUTPUT_FILE (e.g., $OUTPUT_DIR/results/results.sarif) containing all
findings merged and deduplicated.

Attempts to use SARIF Multitool for merging if available, falls back to
pure Python implementation.
"""

from __future__ import annotations

import json
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path


def has_sarif_multitool() -> bool:
    """Check if SARIF Multitool is pre-installed via npx."""
    if not shutil.which("npx"):
        return False
    try:
        result = subprocess.run(
            ["npx", "--no-install", "@microsoft/sarif-multitool", "--version"],
            capture_output=True,
            timeout=30,
        )
        return result.returncode == 0
    except subprocess.TimeoutExpired:
        print("Warning: SARIF Multitool version check timed out", file=sys.stderr)
        return False
    except FileNotFoundError:
        return False
    except OSError as e:
        print(f"Warning: Failed to check SARIF Multitool: {e}", file=sys.stderr)
        return False


def merge_with_multitool(sarif_files: list[Path]) -> dict | None:
    """Use SARIF Multitool to merge SARIF files. Returns merged SARIF or None."""
    if not sarif_files:
        return None

    with tempfile.NamedTemporaryFile(suffix=".sarif", delete=False) as tmp:
        tmp_path = Path(tmp.name)

    try:
        cmd = [
            "npx",
            "--no-install",
            "@microsoft/sarif-multitool",
            "merge",
            *[str(f) for f in sarif_files],
            "--output-file",
            str(tmp_path),
            "--force",
        ]
        result = subprocess.run(cmd, capture_output=True, timeout=120)
        if result.returncode != 0:
            print(f"SARIF Multitool merge failed: {result.stderr.decode()}", file=sys.stderr)
            return None

        return json.loads(tmp_path.read_text())
    except subprocess.TimeoutExpired as e:
        print(f"SARIF Multitool timed out: {e}", file=sys.stderr)
        return None
    except json.JSONDecodeError as e:
        print(f"SARIF Multitool produced invalid JSON: {e}", file=sys.stderr)
        return None
    except FileNotFoundError as e:
        print(f"SARIF Multitool not found: {e}", file=sys.stderr)
        return None
    except OSError as e:
        print(f"SARIF Multitool OS error ({type(e).__name__}): {e}", file=sys.stderr)
        return None
    finally:
        tmp_path.unlink(missing_ok=True)


def merge_sarif_pure_python(sarif_files: list[Path]) -> dict:
    """Pure Python SARIF merge (fallback)."""
    merged = {
        "version": "2.1.0",
        "$schema": "https://json.schemastore.org/sarif-2.1.0.json",
        "runs": [],
    }

    seen_rules: dict[str, dict] = {}
    all_results: list[dict] = []
    seen_results: set[tuple[str, str, int]] = set()
    tool_info: dict | None = None
    skipped_files: list[str] = []

    for sarif_file in sorted(sarif_files):
        try:
            data = json.loads(sarif_file.read_text())
        except json.JSONDecodeError as e:
            print(f"Warning: Failed to parse {sarif_file}: {e}", file=sys.stderr)
            skipped_files.append(str(sarif_file))
            continue

        for run in data.get("runs", []):
            if tool_info is None and run.get("tool"):
                tool_info = run["tool"]

            driver = run.get("tool", {}).get("driver", {})
            for rule in driver.get("rules", []):
                rule_id = rule.get("id", "")
                if rule_id and rule_id not in seen_rules:
                    seen_rules[rule_id] = rule

            for result in run.get("results", []):
                rule_id = result.get("ruleId", "")
                uri = ""
                start_line = 0
                locations = result.get("locations", [])
                if locations:
                    phys = locations[0].get("physicalLocation", {})
                    uri = phys.get("artifactLocation", {}).get("uri", "")
                    start_line = phys.get("region", {}).get("startLine", 0)
                dedup_key = (rule_id, uri, start_line)
                if dedup_key in seen_results:
                    continue
                seen_results.add(dedup_key)
                all_results.append(result)

    if all_results:
        merged_run = {
            "tool": tool_info or {"driver": {"name": "semgrep", "rules": []}},
            "results": all_results,
        }
        merged_run["tool"]["driver"]["rules"] = list(seen_rules.values())
        merged["runs"].append(merged_run)

    if skipped_files:
        print(
            f"WARNING: {len(skipped_files)} of {len(sarif_files)} SARIF files "
            f"could not be parsed. Results may be incomplete.",
            file=sys.stderr,
        )
        for sf in skipped_files:
            print(f"  Skipped: {sf}", file=sys.stderr)

    return merged


def main() -> int:
    if len(sys.argv) != 3:
        print(f"Usage: {sys.argv[0]} RAW_DIR OUTPUT_FILE", file=sys.stderr)
        return 1

    raw_dir = Path(sys.argv[1])
    output_file = Path(sys.argv[2])

    if not raw_dir.is_dir():
        print(f"Error: {raw_dir} is not a directory", file=sys.stderr)
        return 1

    # Collect SARIF files from raw directory only
    sarif_files = sorted(raw_dir.glob("*.sarif"))
    print(f"Found {len(sarif_files)} SARIF files to merge in {raw_dir}")

    if not sarif_files:
        print("No SARIF files found, nothing to merge", file=sys.stderr)
        return 1

    # Ensure output directory exists
    output_file.parent.mkdir(parents=True, exist_ok=True)

    # Try SARIF Multitool first, fall back to pure Python
    merged: dict | None = None
    if has_sarif_multitool():
        print("Using SARIF Multitool for merge...")
        merged = merge_with_multitool(sarif_files)
        if merged:
            print("SARIF Multitool merge successful")

    if merged is None:
        print("Using pure Python merge (SARIF Multitool not available or failed)")
        merged = merge_sarif_pure_python(sarif_files)

    result_count = sum(len(run.get("results", [])) for run in merged.get("runs", []))
    print(f"Merged SARIF contains {result_count} findings")

    # Write output
    output_file.write_text(json.dumps(merged, indent=2))
    print(f"Written to {output_file}")

    return 0


if __name__ == "__main__":
    sys.exit(main())
