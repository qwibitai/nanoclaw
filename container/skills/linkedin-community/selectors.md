# LinkedIn DOM selector hints

**Last verified:** 2026-05-12. LinkedIn ships UI changes constantly — re-snapshot before trusting these. Prefer `agent-browser find role button --name "X"` over CSS selectors when possible.

## Compose modal

| Element | Role/name lookup | Notes |
|---|---|---|
| Open compose | role=`button` name=`"Start a post"` | On `/feed/` |
| Post body editor | role=`textbox` aria-label contains `"Text editor for creating content"` | Inside the compose dialog |
| Add photo | role=`button` name=`"Add a photo"` | Opens image picker |
| Add document | role=`button` name=`"Add a document"` | PDF/PPT upload |
| Image alt text | role=`textbox` aria-label contains `"Alt text"` | Required for accessibility, required field |
| Done (after upload) | role=`button` name=`"Done"` | Returns to compose |
| Publish | role=`button` name=`"Post"` (not `"Submit"`) | Bottom-right of compose |
| Close compose | role=`button` name=`"Close"` | Top-right `X` |
| Discard confirm | role=`button` name=`"Discard"` | Dialog after Close |

## Feed item (a single post in the feed)

| Element | Role/name lookup |
|---|---|
| Like | role=`button` name starts with `"React Like"` |
| Comment open | role=`button` name=`"Comment"` |
| Comment textbox | role=`textbox` aria-label contains `"Add a comment"` |
| Reply on a comment | role=`button` name=`"Reply"` |
| Load more comments | role=`button` name=`"Load more comments"` (singular or plural variants exist) |
| View analytics (own posts) | role=`button` name=`"View analytics"` |

## Analytics modal (own posts only)

| Field | Approach |
|---|---|
| Impressions | text label `"Impressions"` — value is the next sibling number |
| Reactions | text label `"Reactions"` |
| Comments | text label `"Comments"` |
| Reposts | text label `"Reposts"` |

LinkedIn periodically renames these to `"Views"` / `"Engagements"` — snapshot first.

## Invitation manager (`/mynetwork/invitation-manager/`)

| Element | Role/name lookup |
|---|---|
| Accept | role=`button` name=`"Accept"` |
| Ignore | role=`button` name=`"Ignore"` |
| Requester card | role=`listitem` — contains name, headline, mutual count |

The list re-orders after each action; re-snapshot every few clicks.

## Activity feed (own posts)

URL: `https://www.linkedin.com/in/me/recent-activity/all/`

Each post is a `feed-shared-update-v2` article (CSS class — fallback only). Prefer:

- role=`article` to enumerate posts
- Within each article: role=`button` name=`"View analytics"` for the metrics entry

## Login redirect detection

If `agent-browser get url` returns anything containing `/login`, `/checkpoint`, or `/uas/login`, the session is stale. Don't try to recover automatically.
