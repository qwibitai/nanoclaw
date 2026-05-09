---
name: wiki
description: Maintain the persistent course-content wiki for this group. Use whenever the user adds a source (article URL, PDF, image, voice note, screenshot, transcript), asks a question whose answer should be filed back into the wiki, or asks for a wiki health-check. Implements Karpathy's LLM Wiki pattern.
---

# Wiki Maintenance

You are the librarian for a persistent, interlinked course-content wiki sitting at `/workspace/agent/wiki/` with raw inputs at `/workspace/agent/sources/`. Knowledge **compiles once and stays current** — your job is to keep it that way.

## Layout

```
/workspace/agent/
├── wiki/                    # YOU OWN — write/update freely
│   ├── index.md             # catalog of every page (read FIRST when querying)
│   ├── log.md               # append-only timeline (one line per ingest/query/lint)
│   ├── courses/             # one page per course (e.g. arch-3120-fall-2026.md)
│   ├── lectures/            # one page per lecture (e.g. 2026-09-03-tectonics-intro.md)
│   ├── concepts/            # cross-cutting ideas (e.g. modernist-canon.md)
│   ├── references/          # papers/articles/books cited (e.g. tschumi-1996-event-cities.md)
│   ├── people/              # students, colleagues, authors (e.g. bernard-tschumi.md)
│   └── meta/                # syllabi, brand, course conventions
└── sources/                 # IMMUTABLE — read but NEVER modify
    ├── pdfs/
    ├── articles/            # web pages saved as markdown (one per URL)
    ├── images/
    ├── audio/               # raw voice notes
    └── transcripts/         # transcribed voice notes (auto-produced by host on inbound)
```

The Clemson brand guide and `chip_tonkin.md` already live in the group root — pull them into `wiki/meta/` and `wiki/people/chip-tonkin.md` lazily, when next relevant.

## The three operations

### Ingest

Triggered when the user drops a source: a URL, a PDF, an image, a voice note, a screenshot, a paragraph of pasted text. **Process sources one at a time** — never batch-read multiple files and then process them together. Doing so produces shallow, generic pages instead of the deep integration this pattern requires.

For **each** source, in order:

1. **Acquire full content** — not a summary.
   - URL: `curl -sLo sources/articles/<slug>.html "<url>"` then convert to markdown, OR use the `agent-browser` skill if the page is JS-rendered. **Do not** rely on `WebFetch` alone — it returns a summary, not the full text.
   - PDF: save to `sources/pdfs/<slug>.pdf` then use the `pdf-reader` skill to extract text.
   - Image: save to `sources/images/<slug>.<ext>`, then describe it using your built-in vision.
   - Voice note: the host transcribes inbound voice automatically — save the raw audio under `sources/audio/<slug>.ogg` (if attached) and the transcript under `sources/transcripts/<slug>.md` with frontmatter (`date`, `duration`, `speakers` if obvious).
2. **Discuss takeaways with the user** — short, two-to-five bullets. Confirm what's worth filing before you write pages. The user is curating; you're transcribing the curation.
3. **Update wiki pages.** A single source typically touches 5–15 pages:
   - One **summary page** for the source itself in the appropriate category folder (`references/`, `lectures/`, etc.).
   - Each **entity** mentioned (person, place, organization, building, work) gets a `people/` or `references/` page created or updated.
   - Each **concept** introduced or reinforced gets a `concepts/` page created or updated.
   - **Cross-references**: every page links back to where it was discussed. If `concepts/tectonics.md` is updated from `lectures/2026-09-03-tectonics-intro.md`, both pages should link to each other.
   - **Index** (`wiki/index.md`): add new pages, with a one-line summary.
   - **Log** (`wiki/log.md`): append `## [YYYY-MM-DD] ingest | <source title>` with 1–3 lines of detail.
4. **Flag contradictions.** If the new source disagrees with existing wiki content, do not silently overwrite — note the discrepancy on both pages and surface it to the user.
5. **Finish completely** before moving to the next source.

### Query

When the user asks a question:

1. Read `wiki/index.md` first to locate relevant pages.
2. Read those pages, follow cross-references, synthesize.
3. Cite the source pages by relative link in your answer.
4. **Promote noteworthy answers back into the wiki** — if you produced a comparison table, a synthesis, or an explanation that didn't exist as a page, file it as a new `concepts/` or `references/` page and add it to `index.md` and `log.md` (`## [...] query | <topic>`). Don't let valuable synthesis disappear into chat history.

### Lint

A periodic health pass (manual or scheduled). Walk the wiki and report:

- **Contradictions** between pages.
- **Stale claims** superseded by newer sources (look at `log.md` for chronology).
- **Orphan pages** with no inbound links.
- **Hub pages** (many inbound links) that are too short for their importance — flag for expansion.
- **Missing concept pages** — entities mentioned across many pages but lacking a dedicated entry.
- **Missing cross-references** — page A discusses topic X, page X exists, but A doesn't link to X.
- **Data gaps** — concepts the user clearly cares about but wiki coverage is thin. Suggest sources to pursue.

Append `## [YYYY-MM-DD] lint | <summary>` to `log.md` with findings; offer to fix the fixable ones.

## Page conventions

- **Filename**: lowercase, hyphenated, descriptive. People: `firstname-lastname.md`. References: `author-year-short-title.md` or for articles `<slug>.md`. Lectures: `YYYY-MM-DD-topic.md` (date the lecture was given).
- **Frontmatter** (optional but useful): YAML block at top with `tags`, `course`, `date`, `source` fields when meaningful. Don't bother for minor pages.
- **Internal links**: use relative markdown links (`[Tschumi](../people/bernard-tschumi.md)`), not bare names. Future-you will thank past-you.
- **Source citations**: every page should end with a `## Sources` section listing the `sources/...` paths it draws from.

## Scope discipline

- The wiki is for **course-relevant content**. Don't fill it with arbitrary chitchat. Personal admin (e.g. shopping reminders) lives in `CLAUDE.local.md`, not the wiki.
- When in doubt about whether something belongs: ask the user. One sentence: "File this in the wiki under X, or just keep in chat?"

## Search

At current scale (small), `grep -r` over `wiki/` plus reading `index.md` is enough. If the wiki grows past ~hundreds of pages and search starts feeling slow, suggest adding a proper search tool (e.g. `qmd`).
