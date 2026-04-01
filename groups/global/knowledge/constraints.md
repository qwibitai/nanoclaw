# Constraints

Known limitations and preferences. Check this before proposing skills, integrations, or improvements.

Last updated: 2026-03-31

## Geographic
- User is in Vancouver, BC, Canada
- No US-only APIs (e.g., Alpaca Markets is not available to Canadians)
- Prefer services with Canadian or international availability

## Cost
- Prefer free-tier services where possible
- Don't add paid API dependencies without asking first
- Be mindful of container runtime costs when scheduling recurring tasks

## Technical
- Container images are ephemeral — pip installs happen on every container start
- /workspace/project/ is read-only — all code changes go through the PR workflow
- Auto-deploy pulls origin/main every 2 minutes — merged PRs go live quickly
