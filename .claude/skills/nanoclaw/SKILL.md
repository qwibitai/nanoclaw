---
name: nanoclaw
description: Install the nanoclaw CLI tool — send prompts to NanoClaw agents (`nanoclaw agent`) and manage your install from the command line.
---

# nanoclaw — NanoClaw CLI

`nanoclaw` is a Python CLI that sends prompts directly to a NanoClaw agent container from the terminal. It reads registered groups from the NanoClaw database, picks up secrets from `.env`, and pipes a JSON payload into a container run — no chat app required.

## What it does

- `nanoclaw agent "…"` — send a prompt to any registered group (canonical form; `nanoclaw "…"` also works)
- Default target is the main group (no `-g` needed for most use)
- Resume a previous session with `-s <session-id>`
- Read prompts from stdin (`--pipe`) for scripting and piping
- List all registered groups with `nanoclaw agent --list-groups`
- Auto-detects `container` or `docker` runtime (or override with `--runtime`)
- Prints the agent's response to stdout; session ID to stderr
- Verbose mode (`-v`) shows the command, redacted payload, and exit code
- `nanoclaw agent -f tasks.txt` — read prompt from a file (alternative to `--pipe`)
- `nanoclaw ps` — list, inspect, manage, and restart running NanoClaw containers
- `nanoclaw sessions` — list groups with a saved session ID (for use with `-s`)
- `nanoclaw history` — print recent messages for a group from the local database
- `nanoclaw watch` — tail a group's conversation in real time from the DB
- `nanoclaw groups` — list, add, and remove registered groups from the CLI
- `nanoclaw rebuild` — build (or rebuild) the `nanoclaw-agent` container image
- `nanoclaw molt` — export/import NanoClaw installs via the [molt](https://github.com/kenbolton/molt) migration tool (optional dependency)

## Prerequisites

- Python 3.8 or later
- NanoClaw installed with a built and tagged container image (`nanoclaw-agent:latest`)
- Either `container` (Apple Container, macOS 15+) or `docker` available in `PATH`

## Install

Run this skill from within the NanoClaw directory. The script auto-detects its location, so the symlink always points to the right place.

### 1. Copy the script

```bash
mkdir -p scripts
cp "${CLAUDE_SKILL_DIR}/scripts/nanoclaw" scripts/nanoclaw
chmod +x scripts/nanoclaw
```

### 2. Symlink into PATH

```bash
mkdir -p ~/bin
ln -sf "$(pwd)/scripts/nanoclaw" ~/bin/nanoclaw
```

Make sure `~/bin` is in `PATH`. Add this to `~/.zshrc` or `~/.bashrc` if needed:

```bash
export PATH="$HOME/bin:$PATH"
```

Then reload the shell:

```bash
source ~/.zshrc   # or ~/.bashrc
```

### 3. Verify

```bash
nanoclaw groups
```

You should see registered groups. If NanoClaw isn't running or the database doesn't exist yet, the list will be empty — that's fine.

## Usage Examples

```bash
# Send a prompt to the main group (canonical form)
nanoclaw agent "What's on my calendar today?"

# Short form also works
nanoclaw "What's on my calendar today?"

# Send to a specific group by name (fuzzy match)
nanoclaw agent -g "family" "Remind everyone about dinner at 7"

# Send to a group by exact JID
nanoclaw agent -j "120363336345536173@g.us" "Hello"

# Resume a previous session
nanoclaw agent -s abc123 "Continue where we left off"

# Read prompt from stdin
echo "Summarize this" | nanoclaw agent --pipe -g dev

# Pipe a file
cat report.txt | nanoclaw agent --pipe "Summarize this report"

# List all registered groups
nanoclaw agent --list-groups

# Force a specific runtime
nanoclaw agent --runtime docker "Hello"

# Use a custom image tag (e.g. after rebuilding with a new tag)
nanoclaw agent --image nanoclaw-agent:dev "Hello"

# Verbose mode (debug info, secrets redacted)
nanoclaw agent -v "Hello"

# Custom timeout for long-running tasks
nanoclaw agent --timeout 600 "Run the full analysis"

# Read prompt from a file
nanoclaw agent -f tasks.txt

# Prefix the file contents with an inline instruction
nanoclaw agent "Summarize this:" -f report.txt
```

### Container management (nanoclaw ps)

```bash
# List all running NanoClaw containers
nanoclaw ps

# Filter by name substring
nanoclaw ps main

# Also show unnamed/zombie containers
nanoclaw ps --all

# Dump logs for all named containers
nanoclaw ps --logs

# Dump logs for containers matching "main"
nanoclaw ps --logs main

# Follow logs (multiplexed, Ctrl-C to stop)
nanoclaw ps --tail

# Remove stale unnamed containers
nanoclaw ps --kill-zombies

# Stop and remove a specific stuck container (NanoClaw may re-process the pending message)
nanoclaw ps --restart main
```

### Session management (nanoclaw sessions)

```bash
# List all groups with a saved session ID
nanoclaw sessions

# Filter by group name or folder substring
nanoclaw sessions main
```

Use the session ID with `-s` to resume a previous conversation:

```bash
nanoclaw -s <session-id> "Continue where we left off"
```

### Message history (nanoclaw history)

```bash
# Last 20 messages for the main group
nanoclaw history

# Last 20 messages for a specific group (fuzzy match)
nanoclaw history -g family

# Show more messages
nanoclaw history -n 50

# By exact JID
nanoclaw history -j "120363336345536173@g.us"
```

### Live message tail (nanoclaw watch)

```bash
# Watch the main group in real time (Ctrl-C to stop)
nanoclaw watch

# Watch a specific group
nanoclaw watch -g family

# Faster poll interval (default is 2s)
nanoclaw watch -n 1
```

### Group management (nanoclaw groups)

```bash
# List registered groups
nanoclaw groups

# Register a new group
nanoclaw groups add "120363336345536173@g.us" --name "My Group"

# Register with a custom folder and agent name
nanoclaw groups add "120363336345536173@g.us" --name "My Group" --folder my-group --agent-name "Andy"

# Mark as the main group
nanoclaw groups add "120363336345536173@g.us" --name "My Group" --main

# Remove a group (prompts for confirmation; group folder on disk is preserved)
nanoclaw groups remove "My Group"
```

### Rebuilding the container image (nanoclaw rebuild)

```bash
# Rebuild with the default tag (nanoclaw-agent:latest)
nanoclaw rebuild

# Build with a custom tag
nanoclaw rebuild --tag dev

# Prune builder cache first, then rebuild (use when COPY steps serve stale files)
nanoclaw rebuild --clean
```

### Migration (nanoclaw molt)

Requires [molt](https://github.com/kenbolton/molt) installed and available in `PATH`.

```bash
# Export this NanoClaw install to a bundle (source defaults to NANOCLAW_DIR)
nanoclaw molt export --out ~/my-nanoclaw.molt

# Import a bundle into this install (dest and --arch default to this install)
nanoclaw molt import ~/my-nanoclaw.molt

# Import with folder renames
nanoclaw molt import ~/my-nanoclaw.molt --rename family=household

# Dry run
nanoclaw molt import ~/my-nanoclaw.molt --dry-run

# List available molt drivers
nanoclaw molt archs

# Pass any other molt command through directly
nanoclaw molt --help
```

## Troubleshooting

### "neither 'container' nor 'docker' found"

Install Docker Desktop or Apple Container (macOS 15+), or pass `--runtime` explicitly.

### "no secrets found in .env"

The script auto-detects your NanoClaw directory and reads `.env` from it. Check that the file exists and contains at least one of: `CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`.

### Container times out

The default timeout is 300 seconds. For longer tasks, pass `--timeout 600` (or higher). If the container consistently hangs, check that your `nanoclaw-agent:latest` image is up to date by running `./container/build.sh`.

### "group not found"

Run `nanoclaw agent --list-groups` (or `nanoclaw groups`) to see what's registered. Group lookup does a fuzzy partial match on name and folder — if your query matches multiple groups, you'll get an error listing the ambiguous matches.

### Container crashes mid-stream

Containers run with `--rm` so they are automatically removed. If the agent crashes before emitting the output sentinel, `nanoclaw` falls back to printing raw stdout. Use `-v` to see what the container produced. Rebuild the image with `./container/build.sh` if crashes are consistent.

### Override the NanoClaw directory

If `nanoclaw` can't find your database or `.env`, set the `NANOCLAW_DIR` environment variable:

```bash
export NANOCLAW_DIR=/path/to/your/nanoclaw
```
