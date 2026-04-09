# Review Orchestrator Prompt

Use this after `python3 .codex/scripts/verify.py` succeeds and after automated testing is recorded.

Goal: keep review isolated from implementation by spawning three read-only Codex review subagents, waiting for all of them, then writing `.factory/reviews/*.json` artifacts.

Use this exact operating pattern:

1. Spawn these custom agents in parallel:
   - `quality-reviewer`
   - `performance-reviewer`
   - `security-reviewer`
2. Give each agent the same review scope: current branch diff plus any files or directories called out by the self-check.
3. Wait for all three results.
4. For each result, ensure it contains:
   - `score`
   - `summary`
   - `blocking_findings`
   - `non_blocking_findings`
   - `residual_risks`
   - `recommendation`
   - `reviewed_scope`
5. Record each result with:

```bash
python3 .codex/scripts/record_review_from_json.py --aspect <quality|performance|security> --input <json-file>
```

If a subagent returns free-form text instead of the required structure, make it restate the result in the required JSON shape before recording it.

After review passes, run the `functional-checker` subagent and record its structured result with:

```bash
python3 .codex/scripts/record_test_from_json.py --kind functional --input <json-file>
```

Example parent prompt:

```text
Review this branch against main. Spawn `quality-reviewer`, `performance-reviewer`, and `security-reviewer` in parallel. Keep all three read-only. Have each reviewer inspect the diff plus the files named in the self-check. Wait for all results. Then normalize each result into the required JSON contract and record the artifacts with `.codex/scripts/record_review_from_json.py`. Finally, summarize blockers, residual risks, and overall merge recommendation.
```
