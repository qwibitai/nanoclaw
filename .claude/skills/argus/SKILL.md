---
name: argus
description: Install the argus CLI tool — run Argus agent containers from the command line without opening a chat app.
---

# argus — Argus CLI

`argus` is a Python CLI that sends prompts directly to a Argus agent container from the terminal. It reads registered groups from the Argus database, picks up secrets from `.env`, and pipes a JSON payload into a container run — no chat app required.

## What it does

- Send a prompt to any registered group by name, folder, or JID
- Default target is the main group (no `-g` needed for most use)
- Resume a previous session with `-s <session-id>`
- Read prompts from stdin (`--pipe`) for scripting and piping
- List all registered groups with `--list-groups`
- Auto-detects `container` or `docker` runtime (or override with `--runtime`)
- Prints the agent's response to stdout; session ID to stderr
- Verbose mode (`-v`) shows the command, redacted payload, and exit code

## Prerequisites

- Python 3.8 or later
- Argus installed with a built and tagged container image (`argus-agent:latest`)
- Either `container` (Apple Container, macOS 15+) or `docker` available in `PATH`

## Install

Run this skill from within the Argus directory. The script auto-detects its location, so the symlink always points to the right place.

### 1. Copy the script

```bash
mkdir -p scripts
cp "${CLAUDE_SKILL_DIR}/scripts/argus" scripts/argus
chmod +x scripts/argus
```

### 2. Symlink into PATH

```bash
mkdir -p ~/bin
ln -sf "$(pwd)/scripts/argus" ~/bin/argus
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
argus --list-groups
```

You should see registered groups. If Argus isn't running or the database doesn't exist yet, the list will be empty — that's fine.

## Usage Examples

```bash
# Send a prompt to the main group
argus "What's on my calendar today?"

# Send to a specific group by name (fuzzy match)
argus -g "family" "Remind everyone about dinner at 7"

# Send to a group by exact JID
argus -j "120363336345536173@g.us" "Hello"

# Resume a previous session
argus -s abc123 "Continue where we left off"

# Read prompt from stdin
echo "Summarize this" | argus --pipe -g dev

# Pipe a file
cat report.txt | argus --pipe "Summarize this report"

# List all registered groups
argus --list-groups

# Force a specific runtime
argus --runtime docker "Hello"

# Use a custom image tag (e.g. after rebuilding with a new tag)
argus --image argus-agent:dev "Hello"

# Verbose mode (debug info, secrets redacted)
argus -v "Hello"

# Custom timeout for long-running tasks
argus --timeout 600 "Run the full analysis"
```

## Troubleshooting

### "neither 'container' nor 'docker' found"

Install Docker Desktop or Apple Container (macOS 15+), or pass `--runtime` explicitly.

### "no secrets found in .env"

The script auto-detects your Argus directory and reads `.env` from it. Check that the file exists and contains at least one of: `CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`.

### Container times out

The default timeout is 300 seconds. For longer tasks, pass `--timeout 600` (or higher). If the container consistently hangs, check that your `argus-agent:latest` image is up to date by running `./container/build.sh`.

### "group not found"

Run `argus --list-groups` to see what's registered. Group lookup does a fuzzy partial match on name and folder — if your query matches multiple groups, you'll get an error listing the ambiguous matches.

### Container crashes mid-stream

Containers run with `--rm` so they are automatically removed. If the agent crashes before emitting the output sentinel, `argus` falls back to printing raw stdout. Use `-v` to see what the container produced. Rebuild the image with `./container/build.sh` if crashes are consistent.

### Override the Argus directory

If `argus` can't find your database or `.env`, set the `NANOCLAW_DIR` environment variable:

```bash
export NANOCLAW_DIR=/path/to/your/argus
```
