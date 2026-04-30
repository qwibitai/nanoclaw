# Baget agent group template

Files in this folder seed a new "baget" agent group when a founder pairs
their Telegram chat with `@baget_team_bot`. **The host renders these
templates per-founder** — never copy `CLAUDE.md.template` directly to a
group folder; it has unfilled `{{placeholders}}`.

## Files

- **`CLAUDE.md.template`** — persona prompt with `{{cos_name}}`,
  `{{strategist_name}}`, `{{developer_name}}`, `{{marketing_name}}`,
  `{{analyst_name}}`, `{{design_name}}`, `{{company_name}}` placeholders.
  Rendered by `src/baget-pairing.ts::renderBagetClaudeMd()` with the
  founder's actual team names (resolved on the baget.ai side via
  `getAgentName(companyId, role)` from `@baget/shared`, then passed in
  the pairing API call).
- **`container_config.json`** — env + secrets template. The host patches
  `BAGET_COMPANY_ID`, `BAGET_API_BASE_URL`, and the OneCLI secret name
  per founder before writing to the group folder.
- **`README.md`** — this file.

## Install / pairing flow (production)

The full pairing flow is documented in `BAGET-DEPLOY.md`. Summary:

1. Founder taps "Open Telegram with your team" on the baget.ai dashboard.
2. baget.ai backend POSTs to `nanoclaw.baget.ai/baget/agent-groups`
   with the founder's resolved team names.
3. The pairing handler calls `provisionBagetGroup()` from
   `src/baget-pairing.ts`, which:
   - Computes a stable folder name `baget-<u>-<c>` from the user/company
     UUIDs.
   - Renders `CLAUDE.md.template` → writes to
     `groups/<folder>/CLAUDE.local.md`.
   - Patches + writes `container_config.json` to the same folder.
   - Inserts the `agent_groups` row.
4. Returns a single-use Telegram deep link to the founder.
5. Founder taps `/start <token>` → channel adapter binds the chat to
   the agent_group.

## Local development (single-founder install)

For dev / testing on a single founder:

```bash
mkdir -p groups/baget-localdev
# Render the template manually (or use scripts/render-baget-template.ts):
node -e "
const { renderBagetClaudeMd } = require('./dist/baget-pairing.js');
const fs = require('fs');
const md = renderBagetClaudeMd({
  companyName: 'Acme',
  teamMembers: {
    cos: 'Louis',
    strategist: 'Nicolas',
    developer: 'Tristan',
    marketing: 'Valentin',
    analyst: 'Chloé',
    design: 'Théo',
  },
});
fs.writeFileSync('groups/baget-localdev/CLAUDE.local.md', md);
"

# Copy + patch container config:
cp setup/baget-template/container_config.json groups/baget-localdev/
# Edit:
#   - BAGET_API_BASE_URL → https://stg-app.baget.ai
#   - Add BAGET_COMPANY_ID with your test company's UUID
#   - secrets: ['baget-channel-token-localdev']
```

Then `/manage-channels` to wire your local Telegram chat to the group.

## Why per-founder team names

When a founder uses baget.ai, every surface refers to their team by the
SAME names — dashboard cards, activity log, batch summary emails, task
output. Those names come from `@baget/shared::getAgentName(companyId,
role)`, which is deterministic per company.

The channel agent in Telegram has to use those exact same names. If the
dashboard says "Tristan deployed your site" and the founder asks the bot
"did the deploy work?", the bot answering as **Tristan** (not as a
generic "developer") is what makes the team-of-six framing actually feel
like a team.

The template's `{{*_name}}` placeholders get filled at agent_group
creation time using values passed from baget.ai — so the channel agent
and the worker are always referring to the same characters.
