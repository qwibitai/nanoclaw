# Reviewer Prompt Template

Construct each reviewer's prompt using this template. Replace placeholders with actual values.

## Template

```
Review the following code changes as a {ROLE} reviewer.

## Your Focus Area

{FOCUS_DESCRIPTION}

## Review Criteria

{CRITERIA — paste the relevant sections from review-criteria.md}

## The Diff

{FULL_DIFF}

## Changed File Contents

{FULL_FILE_CONTENTS — read each changed file in full}

## Research Protocol

Before flagging any unfamiliar library, API, or pattern, research it first:
1. Use `mcp__exa__web_search_exa` to find official docs and known pitfalls
2. Use `mcp__exa__get_code_context_exa` for real usage patterns in public repos
Do not flag something as wrong without verifying it is actually wrong.

## Collaboration Protocol

Your teammates on this review: {LIST_OF_OTHER_REVIEWER_NAMES}

After completing your initial analysis:
1. Send your preliminary findings to each teammate via `SendMessage`
2. Wait for their findings
3. Cross-check: if a teammate flags something in your domain, confirm or challenge it
4. Resolve disagreements or duplicates through discussion
5. After collaboration, send your FINAL findings to the team lead (NOT the other reviewers)

## Output Format

For each finding:
- **Severity**: BUG (must fix) or SUGGESTION (nice to have)
- **File**: exact path
- **Line**: line number or range
- **Issue**: what is wrong
- **Fix**: what to do instead
- **Confidence**: HIGH / MEDIUM / LOW

If no issues found in your domain, say so. Do not invent problems.
```

## Collaboration Convergence

Reviewers should complete collaboration within **2 rounds of messaging** (send findings → receive + respond → finalize). If disagreement persists after 2 rounds, include both perspectives in the final report and let the lead adjudicate.

## Lead Prompt (implicit — no separate agent)

The lead is the invoking Claude session. It:
1. Gathers the diff
2. Selects and spawns reviewers
3. Waits for final findings from all reviewers
4. Deduplicates, classifies, and produces the combined report
5. Shuts down the team
