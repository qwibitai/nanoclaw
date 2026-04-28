---
name: pr-triage
description: Triage incoming GitHub pull requests. Activates automatically when the first message contains PR metadata (title, author, diff). Performs high-level review, author assessment, and categorization to decide whether to close, merge, or pass to in-depth review.
---

# PR Triage

When your first message contains a Pull Request (look for "## Pull Request #" in the content), follow this 3-stage triage process before doing anything else. This is a screening step — you're deciding whether this PR deserves a full review, not doing the full review itself.

## Stage 1: High-Level Review

Read the PR title, description, and diff at a high level. Don't analyze every line of code — understand the shape of the change. Determine internally (do not output yet):
- What is this PR doing?
- How many files are touched and which areas?
- Is the scope reasonable, or does it mix unrelated concerns?

## Stage 2: Author Assessment

Check who submitted this PR. The author's username is in the PR metadata.

**Check known contributors first:**

```bash
gh api repos/{owner}/{repo}/contributors --jq '.[].login' | grep -i '{author}' || echo "NOT_FOUND"
```

If they're a known contributor, note that and move on — no need for deep investigation.

**If not a known contributor**, look them up:

```bash
gh api users/{author} --jq '{login, created_at, public_repos, followers, bio}'
```

And check for prior contributions to this repo:

```bash
gh api "repos/{owner}/{repo}/commits?author={author}&per_page=5" --jq 'length'
```

Classify the author as one of:
- **Known contributor** — listed in project contributors
- **Established developer** — active GitHub account with repos and history
- **New contributor** — new to this project but has a real GitHub presence
- **Suspicious** — very new account, no repos, no activity

This classification is context for your decision, not a gatekeep. New contributors can submit excellent PRs. A suspicious account with a great PR still gets reviewed — you just note the context.

## Stage 3: Categorize and Decide

### PR Types

Classify the PR into one of these types based on what the diff actually does (not just what the author claims):

| Type | What it looks like |
|------|-------------------|
| **Feature skill** | Adds a channel or integration. Changes source code AND includes a SKILL.md. These are maintained as branches — we create the branch and the SKILL.md points to it. |
| **Utility skill** | Adds a standalone tool. Code files in `.claude/skills/<name>/`, no source code changes. |
| **Operational/container skill** | Adds a workflow or agent skill. SKILL.md only, no source changes. |
| **Fix** | Bug fix or security fix to source code. |
| **Simplification** | Reduces or simplifies source code without changing behavior. |
| **Documentation** | Docs, README, or CONTRIBUTING changes only. |

### Alignment Check

NanoClaw has clear contribution guidelines. Check these:

- **Source code changes** are only accepted for bug fixes, security fixes, and simplifications. If someone submits a new feature as direct source code changes instead of a skill, that's misaligned — features and capabilities must be skills.
- **One thing per PR.** A PR that mixes a bug fix with a new feature or touches unrelated areas is misaligned.
- **Skills over features.** The project philosophy is that every user should have clean, minimal code. Skills let users selectively add capabilities without inheriting code they don't want. Skills that include source code changes are maintained as separate branches. When a user wants the skill, they merge the branch. As maintainers, we handle creating the branch and having the SKILL.md point to it.

### Decision

Apply this decision matrix:

**CLOSE** the PR if:
- It's spam, gibberish, or clearly automated junk
- It adds a feature/capability as direct source code changes instead of as a skill
- It's empty, broken, or doesn't compile/make sense
- It mixes multiple unrelated changes

**MARK FOR MERGE** if:
- It's a trivial documentation fix (typo, formatting, broken link)
- The change is obviously correct and low-risk
- No further review needed

**PASS TO IN-DEPTH REVIEW** if:
- It's a fix, simplification, or non-trivial skill
- It looks reasonable but needs careful examination
- It's from a new contributor (give them the benefit of a thorough review)

## Output Format

Post a compact triage report — readable in under 30 seconds:

```
**PR Triage: [#{number} — {title}]({PR URL})**
{username} ({author classification}) · {PR type} · {N files}
**Decision:** {CLOSE / MERGE / REVIEW} — {one-line reason}
```

Rules:
- Three lines max. The PR number and title are a hyperlink — do not add the URL as a separate line.
- Author classification in parentheses: (known), (established), (new), (suspicious)
- Do not post comments on GitHub — all output goes to the Discord thread only

After posting the triage report:

- If your decision is **CLOSE** or **MERGE**: stop here. Do not proceed further.
- If your decision is **REVIEW**, proceed with the matching review skill:
  - **Skill PR** that modifies existing skills or includes source code changes: `/pr-review-core-skill`
  - **Skill PR** that adds a new skill without touching core code: `/pr-review-community-skill`
  - **Fix**: `/pr-review-fix`
  - **Simplification**: `/pr-review-simplification`
  - **Documentation**: `/pr-review-docs`
