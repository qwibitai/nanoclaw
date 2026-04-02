---
name: blogwatcher
description: blogwatcher CLI — read and monitor RSS/Atom feeds from the command line.
---

# blogwatcher CLI

The `blogwatcher` binary is available in this container for reading RSS and Atom feeds.

## Basic usage

```
# Fetch and display a feed
blogwatcher fetch <feed-url>

# Watch a feed for new items (polls at interval)
blogwatcher watch <feed-url>

# List items as JSON
blogwatcher fetch --format json <feed-url>
```

## Example

```
blogwatcher fetch https://news.ycombinator.com/rss
```

Run `blogwatcher --help` for all options.
