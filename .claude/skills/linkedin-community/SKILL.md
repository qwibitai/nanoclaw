---
name: linkedin-community
description: "Manage your LinkedIn organic presence — post, reply, engage, measure. Uses agent-browser against your logged-in session. Triggers on: linkedin post, linkedin comment, linkedin engage, linkedin community, linkedin metrics, draft a LinkedIn post."
---

# linkedin-community

Interactive LinkedIn community management driven by `agent-browser` against Brad's logged-in browser session. Use this for ad-hoc work that doesn't fit the n8n pipelines.

**Every state-mutating action (post, comment, like, accept request) MUST go through `mcp__nanoclaw__ask_user_question` for explicit approval before clicking the publish button.** Read-only actions (fetch metrics, classify pending requests) can proceed without approval.

## Why agent-browser instead of the API

Brad's LinkedIn developer app has **Marketing-only scope** (Ads APIs). The Community Management API requires a separate approval that LinkedIn no longer grants to most apps. So organic posting/commenting/engagement is closed at the API level. This skill drives the LinkedIn web UI through the agent's browser session as a workaround.

This is a **gray area on LinkedIn ToS** — automation against the web UI is technically discouraged. Keep usage human-paced: one approval per mutation, no bulk loops, no rapid-fire actions.

## Boundary vs the existing n8n workflows

| Workflow | Where it lives | When to use |
|---|---|---|
| `linkedin-post-creator` | n8n (`POST /webhook/linkedin-post-creator`) | Transcript → polished post draft (uses Brad's voice models). Output goes to a draft doc, not auto-posted. |
| `linkedin-voice-ingestion` | n8n (`POST /webhook/linkedin-voice-ingestion`) | Pulls fresh voice memos into the corpus that powers `linkedin-post-creator`. |
| `newsletter-builder` | n8n (`POST /webhook/newsletter-builder`) | Long-form newsletter, not a LinkedIn post. |
| **this skill** | container (`/linkedin-community`) | Ad-hoc interactive: publish a drafted post, reply to comments, engage on a URL, pull metrics, triage connection requests. |

Rule of thumb: if the input is a transcript and the output is "write me a post draft", route to n8n. If the input is "now actually publish this" or "respond to the comments on yesterday's post", that's this skill.

## Pre-flight checks

Before any workflow, confirm the browser session is logged in:

```bash
agent-browser open https://www.linkedin.com/feed/
agent-browser get url
```

If the URL redirects to `/login` or `/checkpoint/...`, the saved auth state is stale. Tell Brad:

> "My LinkedIn browser session is logged out. I can open the login page and walk you through pasting credentials, or you can do it manually in a one-off and I'll snapshot the auth state. Which?"

Do not try to log in automatically — credential entry must be human-driven.

If logged in, save the working state so the next session reuses it:

```bash
agent-browser state save /workspace/agent/.state/linkedin.json
```

Subsequent sessions: `agent-browser state load /workspace/agent/.state/linkedin.json` before `open`.

## Workflow 1 — Post drafted content

Brad will hand off a finished draft (often from `linkedin-post-creator`). You publish it after a single approval gate.

### Text-only post

```bash
agent-browser open https://www.linkedin.com/feed/
agent-browser find role button click --name "Start a post"
agent-browser wait --text "What do you want to talk about"
agent-browser snapshot -i
```

The snapshot shows the compose modal. The post body editor is typically a `textbox` with role `textbox` and aria-label containing "Text editor for creating content". Use the ref returned in the snapshot:

```bash
agent-browser fill @e<body> "<the drafted post text>"
agent-browser screenshot /workspace/agent/.screenshots/li-compose-preview.png --full
```

Show the screenshot to Brad and ask:

```
mcp__nanoclaw__ask_user_question {
  question: "Ready to publish this LinkedIn post? Reply 'publish' to send, anything else to cancel.",
  options: ["publish", "cancel", "edit"]
}
```

Only on `publish`:

```bash
agent-browser find role button click --name "Post"
agent-browser wait --text "Post successful"
```

On `edit`, take Brad's revised text, clear the field (`agent-browser fill @e<body> ""`), refill, re-screenshot, re-ask.

On `cancel`:

```bash
agent-browser find role button click --name "Close"
# Confirm discard if a "Discard" dialog appears
agent-browser find role button click --name "Discard"
```

### Post with a single image

```bash
agent-browser find role button click --name "Start a post"
agent-browser find role button click --name "Add a photo"
agent-browser snapshot -i
# Find the file input (role=button, but the upload trigger is an <input type=file>)
agent-browser upload @e<file-input> /workspace/agent/.assets/<image>.png
agent-browser wait --text "Add a description"
agent-browser fill @e<alt-text> "<descriptive alt text — required for accessibility>"
agent-browser find role button click --name "Done"
agent-browser fill @e<body> "<post body>"
agent-browser screenshot /workspace/agent/.screenshots/li-compose-preview.png --full
# Approval gate, then publish as above
```

### Document / PDF post

```bash
agent-browser find role button click --name "Start a post"
agent-browser find role button click --name "Add a document"
agent-browser upload @e<file-input> /workspace/agent/.assets/<doc>.pdf
agent-browser wait --text "Document title"
agent-browser fill @e<title> "<title shown above the doc carousel>"
agent-browser find role button click --name "Done"
agent-browser fill @e<body> "<post body>"
# screenshot + approval + publish
```

### Carousel (multi-image)

LinkedIn's "carousel" is really a multi-image post or a document with multiple pages. For multi-image:

```bash
agent-browser find role button click --name "Start a post"
agent-browser find role button click --name "Add a photo"
agent-browser upload @e<file-input> /workspace/agent/.assets/slide1.png /workspace/agent/.assets/slide2.png /workspace/agent/.assets/slide3.png
# Add alt text for each — LinkedIn cycles through them
agent-browser find role button click --name "Next"
# ...repeat alt-text per slide...
agent-browser find role button click --name "Done"
agent-browser fill @e<body> "<post body>"
# screenshot + approval + publish
```

If Brad wants a true "swipe carousel" (the PDF-as-deck pattern), use the **Document / PDF post** path with a pre-rendered PDF deck.

## Workflow 2 — Reply to comments on your own posts

Read-only fetch is fine without approval; each reply needs its own approval.

### List recent posts and unanswered comments

```bash
agent-browser open https://www.linkedin.com/in/me/recent-activity/all/
agent-browser snapshot -i
```

For each recent post, follow the "View comments" link and snapshot:

```bash
agent-browser open https://www.linkedin.com/feed/update/urn:li:activity:<id>/
agent-browser snapshot -i
agent-browser find role button click --name "Load more comments"
# Repeat until no more "Load more comments" button
```

Identify unanswered comments: a comment from someone other than Brad, with no nested reply from Brad underneath it. Build a list:

```
post-id | commenter name | comment text | sentiment (positive/neutral/question) | signal
```

### Draft each reply

For each unanswered comment, draft a reply using this template:

- **Positive/affirming comment** → short ack + one substantive nudge ("Thanks Sarah — the part about <X> resonates because <Y>. What's your take on <Z>?")
- **Question** → answer the question directly, ask a follow-up
- **Pushback** → acknowledge their point, hold the position with evidence, invite discussion

Personalize with their name and (if you can see it from their profile snippet) one concrete detail.

### Post each reply (approval per reply)

```bash
agent-browser find role button click --name "Reply" --nth <n>  # the nth reply button on the page
agent-browser snapshot -i
agent-browser fill @e<reply-box> "<drafted reply>"
agent-browser screenshot /workspace/agent/.screenshots/li-reply-preview.png
```

Ask Brad:

```
mcp__nanoclaw__ask_user_question {
  question: "Reply to <commenter>'s comment? Preview attached. Reply 'post' to send, 'edit' to revise, 'skip' to move on.",
  options: ["post", "edit", "skip"]
}
```

On `post`: `agent-browser find role button click --name "Post" --nth <same-n>` then verify with snapshot.

## Workflow 3 — Engage on someone else's post

Brad gives a URL. You navigate, read, draft a reaction or comment, ask approval.

```bash
agent-browser open <post-url>
agent-browser wait --load networkidle
agent-browser snapshot -i
agent-browser get text @e<post-body>  # extract the post for context
```

Summarize the post in two sentences for Brad, then propose one of:

- **Like only** (low-effort signal)
- **Like + comment** (highest engagement)
- **Comment only** (rare — use when explicit disagreement should stand without endorsement)

Draft the comment if applicable. Ask:

```
mcp__nanoclaw__ask_user_question {
  question: "Engagement plan: <like|comment|both>. Comment draft: \"<text>\". Approve?",
  options: ["approve", "edit-comment", "like-only", "skip"]
}
```

On approve, execute:

```bash
# Like
agent-browser find role button click --name "React Like"

# Comment
agent-browser find role button click --name "Comment"
agent-browser snapshot -i
agent-browser fill @e<comment-box> "<comment>"
agent-browser find role button click --name "Post"
```

## Workflow 4 — Pull post metrics

Read-only — no approval gate. **Your own posts only.** Do not scrape others' analytics views even if accessible; that crosses a clear line.

```bash
agent-browser open https://www.linkedin.com/in/me/recent-activity/all/
agent-browser snapshot -i
```

For each post, click "View analytics" (only visible on Brad's own posts):

```bash
agent-browser find role button click --name "View analytics" --nth <n>
agent-browser wait --text "Impressions"
agent-browser snapshot -i
# Read the numbers
agent-browser get text @e<impressions>
agent-browser get text @e<reactions>
agent-browser get text @e<comments>
agent-browser get text @e<reposts>
agent-browser screenshot /workspace/agent/.screenshots/li-metrics-<post-id>.png --full
```

Report back as a small table. If Brad asks for trend analysis across posts, gather then deliver as a markdown table — don't loop the UI to compute averages, do that in your head / a quick script.

## Workflow 5 — Connection request triage

Read-only classification is automatic; accept/ignore decisions need approval per batch (or per-request if Brad prefers).

```bash
agent-browser open https://www.linkedin.com/mynetwork/invitation-manager/
agent-browser wait --load networkidle
agent-browser snapshot -i
```

For each pending invitation, capture:

- Requester name + headline
- Mutual connections count
- Any note included
- Their company (if visible)

Classify against Brad's ICP (read `/workspace/extra/clients/projects.json` and any `icp.md` if present):

| Signal | Decision |
|---|---|
| Match to active-client domain or industry | `accept` |
| ≥3 mutual connections in Brad's network AND professional headline | `accept` |
| Recruiter with no mutual connections | `ignore` |
| Generic SaaS sales pitch | `ignore` |
| Pure spam / no headline / 0 mutuals | `ignore` |
| Unclear | `ask` — flag for Brad |

Present a digest:

```
| # | Requester | Headline | Mutuals | Recommendation | Why |
|---|-----------|----------|---------|----------------|-----|
| 1 | Jane Doe  | Head of Growth @ Acme | 7 | accept | Matches Meadow ICP |
| 2 | ...       | ...      | 0       | ignore         | Spam |
```

Ask Brad:

```
mcp__nanoclaw__ask_user_question {
  question: "Apply the above recommendations? Reply 'all' to follow every rec, or list numbers to flip (e.g. '1 ignore, 3 accept').",
  options: ["all", "review-each", "cancel"]
}
```

Then execute on the resulting plan, one click per decision:

```bash
# Accept
agent-browser find role button click --name "Accept" --nth <n>

# Ignore (the "Ignore" button is sometimes in an overflow menu)
agent-browser find role button click --name "Ignore" --nth <n>
```

Re-snapshot after every few clicks — LinkedIn re-orders the invitation list as items are processed.

## Caveats

- **ToS gray area** — Web-UI automation is not explicitly approved by LinkedIn. Keep cadence human (single approvals, no tight loops). If LinkedIn surfaces a challenge ("Are you a real person?"), stop and tell Brad.
- **Per-action approval is non-negotiable** — every mutation (post, comment, like, accept) goes through `mcp__nanoclaw__ask_user_question`. No batch publish without a final per-item confirmation.
- **DOM may drift** — LinkedIn ships UI changes constantly. If a `find role button --name "X"` lookup fails, fall back to `agent-browser snapshot -i` and read the actual labels. Don't hardcode CSS selectors when role+name will do.
- **Mobile vs desktop** — agent-browser uses the desktop site. Don't navigate to `m.linkedin.com`.
- **Rate sense** — comments and connection accepts have unspoken rate limits. Reasonable upper bound per session: ~10 comments, ~20 connection actions. Beyond that, batch across days.
- **Screenshots are receipts** — always screenshot before publish/post and save under `/workspace/agent/.screenshots/`. They're the artifact Brad reviews in the approval prompt.
- **Auth state is a credential** — `/workspace/agent/.state/linkedin.json` contains session cookies. Treat it like a token: never print, never copy elsewhere, never include in chat output.

## How to upgrade to the API

When the Community Management API becomes available again, this skill should be deprecated in favor of:

- `POST /rest/posts` — create a UGC post
- `GET /rest/posts/{id}/comments` — read comments
- `POST /rest/posts/{id}/comments` — reply
- `POST /rest/socialActions/{urn}/likes` — like

Migration path: add a new container skill `linkedin-organic-api` that wires the API via OneCLI (separate credential from `linkedin-ads`, scope `r_member_social,w_member_social,r_organization_social,w_organization_social`), keep this skill as the fallback for anything not yet covered by the API. Don't delete this skill — the web-UI flow remains useful for the metrics analytics view (richer than the API) and for connection-request triage (not in the API at all).

## Selector hints (when role+name lookups fail)

If the container skill bundle is mounted, see the companion `selectors.md` next to this `SKILL.md` (kept minimal and tagged with the date it was last verified). Assume it rots and re-snapshot before trusting.
