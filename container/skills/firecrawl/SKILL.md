---
name: firecrawl
description: Scrape any URL or search the web via the Firecrawl API — clean markdown output. Use for scraping a known URL, searching when you don't have a URL, extracting article content, or pulling structured data from a webpage.
---

# Firecrawl

Web scraping and search via the Firecrawl API.

## Auth — OneCLI inject (no header from you)

The Firecrawl API key lives in the OneCLI vault (host pattern `api.firecrawl.dev`, inject rule `Authorization: Bearer {value}`). The OneCLI HTTPS proxy adds the `Authorization` header to every request to that host, in flight. **You never see the key.**

**Do NOT send your own `Authorization` header.** If you do, the proxy passes it through unchanged and Firecrawl rejects it. Just call the API with no auth header and it'll work.

## Scrape a URL

```bash
curl -s \
  -X POST https://api.firecrawl.dev/v1/scrape \
  -H "Content-Type: application/json" \
  -d '{"url": "https://example.com", "formats": ["markdown"]}'
```

Returns JSON with a `data.markdown` field containing clean page content.

## Search the web

```bash
curl -s \
  -X POST https://api.firecrawl.dev/v1/search \
  -H "Content-Type: application/json" \
  -d '{"query": "your search query", "limit": 5}'
```

Returns JSON with a `data` array of results, each with `url`, `title`, `description`, and `markdown`.

## Practical usage

Extract markdown from a scraped page:

```bash
curl -s \
  -X POST https://api.firecrawl.dev/v1/scrape \
  -H "Content-Type: application/json" \
  -d '{"url": "https://example.com", "formats": ["markdown"]}' \
  | node -e "const d=require('fs').readFileSync('/dev/stdin','utf8'); console.log(JSON.parse(d).data?.markdown || 'No content')"
```

Search and extract URLs + titles:

```bash
curl -s \
  -X POST https://api.firecrawl.dev/v1/search \
  -H "Content-Type: application/json" \
  -d '{"query": "latest AI news", "limit": 5}' \
  | node -e "const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')); d.data?.forEach(r=>console.log(r.url+'\n'+r.title+'\n'))"
```

## Tips

- Prefer search when you don't have a specific URL
- Scrape for full page content of a known URL
- Results are clean markdown — ready to read directly
- If a request returns 401, the OneCLI secret is missing or its host pattern doesn't match `api.firecrawl.dev`. Ask the user to run `onecli secrets list` to confirm.
