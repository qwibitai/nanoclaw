---
name: lazylibrarian
description: Search for books and add them to LazyLibrarian. Use when the user asks to find a book, add a book, check download status, or list wanted books.
allowed-tools: Bash(curl:*)
---

# LazyLibrarian Book Management

Use when the user wants to:
- Search for a book ("find book X", "search for X by Y")
- Add a book to the wanted list ("add book X", "download X")
- List the current wanted/queued books
- Check whether a book is already in the library

## Configuration

Read your LazyLibrarian config from the `## LazyLibrarian` section of your CLAUDE.md:

```bash
# Extract config from CLAUDE.md
LL_URL=$(grep -A2 'LAZYLIBRARIAN_URL' /workspace/group/CLAUDE.md | grep -v 'LAZYLIBRARIAN_URL' | head -1 | tr -d ' ')
LL_KEY=$(grep -A2 'LAZYLIBRARIAN_API_KEY' /workspace/group/CLAUDE.md | grep -v 'LAZYLIBRARIAN_API_KEY' | head -1 | tr -d ' ')
```

Or parse it directly if stored as:
```
LAZYLIBRARIAN_URL: http://192.168.x.x:5299
LAZYLIBRARIAN_API_KEY: yourkeyhere
```

## API Reference

All requests: `GET $LL_URL/api?apikey=$LL_KEY&cmd=<CMD>[&params]`

Responses are JSON: `{"success": true/false, "data": [...]}` or `{"success": true, "data": "message"}`.

### Search for books

```bash
curl -s "$LL_URL/api?apikey=$LL_KEY&cmd=searchBook&name=TITLE&author=AUTHOR"
```

- `name` — book title (URL-encode spaces as `+` or `%20`)
- `author` — author name (optional but improves results)
- Returns array of book objects with `BookID`, `BookName`, `AuthorName`, `BookDesc`, `BookIsbn`

URL-encode helper:
```bash
TITLE_ENC=$(python3 -c "import urllib.parse, sys; print(urllib.parse.quote_plus(sys.argv[1]))" "Dune")
AUTHOR_ENC=$(python3 -c "import urllib.parse, sys; print(urllib.parse.quote_plus(sys.argv[1]))" "Frank Herbert")
curl -s "$LL_URL/api?apikey=$LL_KEY&cmd=searchBook&name=$TITLE_ENC&author=$AUTHOR_ENC"
```

### Add a book to the wanted list

```bash
curl -s "$LL_URL/api?apikey=$LL_KEY&cmd=addBook&id=BOOKID"
```

- `id` — the `BookID` from search results
- LazyLibrarian will queue a search for this book automatically

### List wanted books

```bash
curl -s "$LL_URL/api?apikey=$LL_KEY&cmd=getWanted"
```

Returns books with status `Wanted`.

### Force search/download for a book already in library

```bash
curl -s "$LL_URL/api?apikey=$LL_KEY&cmd=searchItem&id=BOOKID"
```

### Get download history

```bash
curl -s "$LL_URL/api?apikey=$LL_KEY&cmd=getHistory"
```

## Workflow

### Finding and adding a book

1. **Search first** — always search before adding:
   ```bash
   curl -s "$LL_URL/api?apikey=$LL_KEY&cmd=searchBook&name=TITLE_ENC&author=AUTHOR_ENC"
   ```

2. **Show results** — list top 3–5 results with title, author, and a short description if available. Ask the user which one to add.

3. **Add on confirmation** — once user confirms, call `addBook` with the `BookID`:
   ```bash
   curl -s "$LL_URL/api?apikey=$LL_KEY&cmd=addBook&id=BOOKID"
   ```

4. **Confirm to user** — report success or failure.

### If only one result

If there's exactly one match and it closely matches what the user asked for, you may add it directly without asking for confirmation — but tell the user what you did.

### If config is missing

If `LAZYLIBRARIAN_URL` or `LAZYLIBRARIAN_API_KEY` are not set in CLAUDE.md, tell the user:

> LazyLibrarian isn't configured yet. Please add your URL and API key to the LazyLibrarian section of my memory (ask me to show you the format if needed).

## Response Format (WhatsApp)

```
*Found 3 results for "Dune":*

1. *Dune* — Frank Herbert (1965)
   Science fiction epic set on desert planet Arrakis.

2. *Dune Messiah* — Frank Herbert (1969)
   Sequel to Dune.

3. *Children of Dune* — Frank Herbert (1976)
   Third book in the Dune Chronicles.

Which one would you like to add? (reply 1, 2, or 3)
```

After adding:
```
✓ *Dune* by Frank Herbert has been added to your wanted list. LazyLibrarian will search for a download now.
```
