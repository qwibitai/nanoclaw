# Wiki Skill

You maintain a personal knowledge wiki for the user. The wiki lives in `wiki/` and raw sources in `sources/`. You are the sole maintainer — you read sources, extract knowledge, and integrate it into wiki pages.

## File Layout

```
wiki/
  index.md       ← catalog of all pages (update on every ingest)
  log.md         ← append-only activity log
  <topic>.md     ← one page per entity, concept, person, or theme
sources/
  <filename>     ← immutable raw files (never modify)
attachments/
  <filename>     ← PDFs sent via WhatsApp (auto-downloaded)
```

## Operations

### Ingest

Triggered when the user drops a source (URL, PDF, image, voice note) or says "add this", "read this", "ingest".

1. Read/fetch the source fully (see Source Handling below)
2. Save it to `sources/` if it's a file
3. Extract key facts, ideas, people, concepts
4. Update or create relevant wiki pages — a single source may touch 5–15 pages
5. Update `wiki/index.md` with any new or changed pages
6. Append to `wiki/log.md`: `## [YYYY-MM-DD] ingest | <source title>`
7. Briefly tell the user what was added and which pages were updated

### Query

Triggered when the user asks a question about something in the wiki.

1. Read `wiki/index.md` to locate relevant pages
2. Read those pages in full
3. Synthesize an answer with citations to wiki pages and original sources
4. If the answer is rich enough to be a wiki page itself, offer to file it

### Lint

Triggered by "lint", "health check", or scheduled.

Check for:
- Contradictions between pages
- Stale claims that newer sources may supersede
- Orphan pages with no inbound links
- Important concepts that lack a dedicated page
- Missing cross-references between related pages

Report findings and suggest sources or investigations to pursue.

## Source Handling

### URLs
Do NOT use WebFetch (returns summaries). Download the full document:
```bash
# Save raw HTML and strip tags to plain text
curl -sL "<url>" -o sources/<slug>.html
python3 -c "
import sys, html.parser, re
class P(html.parser.HTMLParser):
    def __init__(self): super().__init__(); self.out=[]; self.skip=False
    def handle_starttag(self,t,a): self.skip=t in ('script','style','nav','footer')
    def handle_endtag(self,t): self.skip=False
    def handle_data(self,d):
        if not self.skip: self.out.append(d)
p=P(); p.feed(open('sources/<slug>.html').read())
print(re.sub(r'\n{3,}','\n\n',''.join(p.out)).strip())
" > sources/<slug>.txt
```
If the page requires JavaScript, use `agent-browser` to open it and extract full text instead.

### PDFs
PDFs sent via WhatsApp are auto-saved to `attachments/`. Extract text with:
```bash
pdf-reader extract attachments/<filename>.pdf
```
For PDFs from URLs:
```bash
curl -sLo sources/<filename>.pdf "<url>"
pdf-reader extract sources/<filename>.pdf
```

### Images / Screenshots
Use the vision capability to read the image. Describe what you see and extract any text or data.

### Voice Notes
Voice notes are transcribed automatically before reaching you. Treat the transcript as the source text.

## Wiki Page Format

```markdown
# <Title>

> Sources: [[source1]], [[source2]] | Updated: YYYY-MM-DD

One-paragraph summary.

## Key Points
- ...

## Related
- [[related-page]] — why it's related
```

## Conventions

- One concept/person/theme per page — don't merge unrelated topics
- Cross-link aggressively: `[[page-name]]` for any related page that exists
- Flag contradictions inline: `> ⚠️ Contradicts [[other-page]]: ...`
- Keep pages factual — save your synthesis for a dedicated synthesis page
- The index is your navigation tool — keep it current and accurate
