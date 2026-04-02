---
name: add-blogwatcher
description: Add the blogwatcher CLI to the NanoClaw agent container for reading and monitoring RSS/Atom feeds.
---

# Add Blogwatcher Plugin

This skill installs the [blogwatcher](https://github.com/nicholasgasior/blogwatcher) CLI binary inside the agent container so the agent can read and monitor RSS/Atom feeds on demand.

## Phase 1: Pre-flight

Check if `src/plugins/blogwatcher.ts` exists. If it does, skip to Phase 3 (Rebuild) — the code changes are already in place.

## Phase 2: Apply Code Changes

### Ensure plugin infrastructure exists

Check if `src/plugins/registry.ts` exists. If not, the plugin system hasn't been installed yet — this is unexpected since it ships with the core codebase. Stop and ask the user to check their installation.

### Write the plugin module

Look up the latest release at https://github.com/nicholasgasior/blogwatcher/releases and get the linux/amd64 binary URL. Then create `src/plugins/blogwatcher.ts`:

```typescript
import { registerPlugin } from './registry.js';

registerPlugin({
  name: 'blogwatcher',
  binaryInstall: {
    url: 'https://github.com/nicholasgasior/blogwatcher/releases/download/vX.Y.Z/blogwatcher-linux-amd64',
    dest: '/usr/local/bin/blogwatcher',
  },
});
```

Use the exact binary URL from the latest release page (replace `vX.Y.Z` with the actual version tag).

### Register in the plugins barrel

Append to `src/plugins/index.ts`:

```typescript
import './blogwatcher.js';
```

### Create container skill

Create `container/skills/blogwatcher/SKILL.md`:

```markdown
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
```

### Validate code changes

```bash
npm run build
```

Build must be clean before proceeding.

## Phase 3: Rebuild

The blogwatcher binary needs to be baked into the container image. The build script auto-generates `plugins/binaries.json` from the plugin registry before building — do not edit that file manually.

```bash
container/build.sh
```

### Restart the service

```bash
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
```

## Phase 4: Verify

Ask the user to send a message to the agent:

> `run: blogwatcher --help`

The agent should respond with the blogwatcher help output.

## Troubleshooting

**`blogwatcher: command not found` inside the container**
The binary wasn't installed. Check that `binaryInstall` is declared in `src/plugins/blogwatcher.ts` and rebuild: `container/build.sh`

**Download failed during build**
Check that the URL in `binaryInstall.url` points to a valid release asset. Visit https://github.com/nicholasgasior/blogwatcher/releases to find the correct URL.
