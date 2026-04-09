# Channel map

Every channel Claudio runs in, what it's for, and how they connect. When a request could belong to more than one channel, use this to decide where it goes.

## Discord channels

### #silverthorne — household operations
**Group folder:** `discord_silverthorne`
**Purpose:** Chores, announcements, shared decisions, pet (Silverthorne Household sheet) management.
**Pinned cards:** `status_card` (today's chores + upcoming week)
**NOT for:** Baby tracking (→ #emilio-care), couple-only stuff (→ #panda), games (→ #family-fun).

### #emilio-care — baby ops
**Group folder:** `discord_emilio-care`
**Purpose:** Feedings, diaper changes, pumping sessions, sleep log, baby-related TODOs. All data lives in the Emilio Tracking sheet.
**Pinned cards:** `status_card` (last feed/diaper/nap, today's totals, pump streak)
**Cross-channel writes:** appends `Chore Log` + `hydrate_brenda` entries to the Silverthorne Household sheet when Brenda pumps (throttled to 3h).

### #family-fun — household games
**Group folder:** `discord_family-fun`
**Purpose:** The daily **Saga Wordle** — versus + rolling story + Silverthorne pet XP stakes. Paden, Brenda, Danny all play.
**Pinned cards:** `wordle_card`
**Input flow:** guesses come via DM (see `discord_dms`), NOT in-channel. Reveal poller reads Portillo Games sheet.
**Cross-channel writes:** appends `Pet Log` rows to the Silverthorne Household sheet for XP/health on win/loss.

### #panda — couple's space (Paden ❤️ Brenda)
**Group folder:** `discord_parents`
**Purpose:** The Panda Romance Game (36 Questions → Daily Pulse rotation), Paden's calendar card, shared couple logistics.
**Pinned cards:** `calendar_card`, `panda_heart`
**Input flow:** game answers come via DM (see `discord_dms`), NOT in-channel. Reveal poller reads Portillo Games sheet.
**Privacy:** Danny is NOT a player here. This is couple-only. Never leak into other channels.

### DMs (Paden, Brenda, Danny) — private inbox
**Group folder:** `discord_dms` (shared across all 3 DM JIDs)
**Purpose:** Private submissions for games running in #family-fun and #panda. Also a general-purpose vault for anything someone wants to send privately.
**Writes to:** Portillo Games sheet (`Wordle Submissions`, `Panda Submissions` tabs).
**Privacy:** What Paden DMs never goes to Brenda's DM. Ever. Confirmations only — never echo content.

## Cross-channel flows (memorize these)

- **Brenda pumps in #emilio-care** → pump logged in Emilio Tracking → Nyx gets +10 XP in Silverthorne Household → (throttled) hydration nudge posted in #silverthorne → chore completion gives Voss or Zima XP.
- **Saga Wordle in #family-fun** → players DM guesses → `discord_dms` writes to Portillo Games sheet → `discord_family-fun` reveal poller picks them up → day resolution writes pet XP/health to Silverthorne Household sheet → chapter posted in #family-fun.
- **Panda game in #panda** → couple DMs answers → `discord_dms` writes to Portillo Games sheet → `discord_parents` reveal poller picks them up → reveal posted in #panda + Love Map updated.
- **Calendar event created/updated/deleted in #panda** → `calendar_card` edited in place immediately.

## Channels are NOT isolated

Groups share state through Google Sheets (not through the filesystem — each group mounts its own `/workspace/group/`). If a group needs to see or write data owned by another, go through the sheet, not through files. See `/workspace/global/sheets.md` for ownership.
