#!/usr/bin/env python3
from __future__ import annotations

import sys
from pathlib import Path

root = Path(__file__).resolve().parents[2]
required = [
    root / '.codex' / 'config.toml',
    root / '.codex' / 'hooks.json',
    root / '.codex' / 'prompts' / 'planner.md',
    root / '.codex' / 'prompts' / 'decomposer.md',
    root / '.codex' / 'prompts' / 'tester-automated.md',
    root / '.codex' / 'prompts' / 'tester-functional.md',
    root / '.codex' / 'scripts' / 'verify.py',
    root / '.codex' / 'scripts' / 'factory_gates.py',
    root / '.codex' / 'scripts' / 'validate_artifacts.py',
    root / '.codex' / 'scripts' / 'validate_work.py',
    root / '.codex' / 'scripts' / 'stage_playbook.py',
    root / '.codex' / 'scripts' / 'stage_orchestrator.py',
    root / '.codex' / 'scripts' / 'sync_linear.py',
    root / '.codex' / 'scripts' / 'record_decomposition_from_json.py',
    root / '.codex' / 'scripts' / 'render_linear_task_graph.py',
    root / '.codex' / 'scripts' / 'record_test_from_json.py',
    root / '.codex' / 'agents' / 'planner-high.toml',
    root / '.codex' / 'agents' / 'docs-decomposer.toml',
    root / '.codex' / 'agents' / 'quality-reviewer.toml',
    root / '.codex' / 'agents' / 'performance-reviewer.toml',
    root / '.codex' / 'agents' / 'security-reviewer.toml',
    root / '.codex' / 'agents' / 'automated-tester.toml',
    root / '.codex' / 'agents' / 'functional-checker.toml',
    root / '.factory' / 'README.md',
    root / 'WORKFLOW.md',
    root / 'docs' / 'FACTORY.md',
    root / 'docs' / 'QUALITY.md',
    root / 'docs' / 'product' / 'README.md',
    root / 'docs' / 'product' / 'BRIEF.md',
    root / 'docs' / 'architecture' / 'README.md',
    root / 'docs' / 'decisions' / 'README.md',
]
missing = [str(path.relative_to(root)) for path in required if not path.exists()]
if missing:
    print('Missing factory scaffold files:')
    for item in missing:
        print(f'- {item}')
    sys.exit(1)
print('Factory scaffold OK')
