---
name: books
description: Query the user's personal book library (465 books from Amazon order history). Use when the user asks about their books, reading history, authors, purchases, or book recommendations from their collection.
allowed-tools: Bash(sqlite3:*,python3:*)
---

# Books Library

Query the user's book collection stored in a SQLite database.

## Database Location

`/home/node/.claude/skills/books/books.db`

## Schema

```sql
CREATE TABLE books (
    title TEXT,
    author TEXT,
    type TEXT,       -- e.g. "Physical Book", "Kindle Edition"
    price TEXT,      -- dollar amount as string (e.g. "20.96")
    order_date TEXT, -- ISO 8601 (e.g. "2001-09-10T17:22:27Z")
    asin TEXT,
    publisher TEXT,
    order_id TEXT
);
```

## Querying

Use `sqlite3` CLI with the `-header -column` flags for readable output:

```bash
sqlite3 -header -column /home/node/.claude/skills/books/books.db "SELECT title, author FROM books WHERE author LIKE '%Hobb%';"
```

## Example Queries

### Search by author
```bash
sqlite3 -header -column /home/node/.claude/skills/books/books.db "SELECT title, order_date FROM books WHERE author LIKE '%Robin Hobb%' ORDER BY order_date;"
```

### Search by title
```bash
sqlite3 -header -column /home/node/.claude/skills/books/books.db "SELECT title, author FROM books WHERE title LIKE '%dragon%' ORDER BY title;"
```

### List all unique authors
```bash
sqlite3 -header -column /home/node/.claude/skills/books/books.db "SELECT DISTINCT author FROM books WHERE author != '' ORDER BY author;"
```

### Count books
```bash
sqlite3 /home/node/.claude/skills/books/books.db "SELECT COUNT(*) FROM books;"
```

### Books purchased in a date range
```bash
sqlite3 -header -column /home/node/.claude/skills/books/books.db "SELECT title, author, order_date FROM books WHERE order_date BETWEEN '2020-01-01' AND '2020-12-31' ORDER BY order_date;"
```

### Spending summary
```bash
sqlite3 -header -column /home/node/.claude/skills/books/books.db "SELECT type, COUNT(*) as count, ROUND(SUM(CAST(price AS REAL)), 2) as total_spent FROM books WHERE price != '' GROUP BY type;"
```

## Notes

- Some fields may be empty (especially `author` and `publisher`)
- Use `LIKE` with `%` wildcards for flexible matching
- The `price` column is a string — cast to REAL for arithmetic
- Dates are ISO 8601 so string comparison works for ranges
