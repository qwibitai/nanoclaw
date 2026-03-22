---
name: add-statusbar
description: Add a macOS menu bar status indicator for NanoClaw. Shows a ⚡ icon with a green/red dot indicating whether NanoClaw is running, with Start, Stop, and Restart controls. macOS only.
---

# Add macOS Menu Bar Status Indicator

Adds a persistent menu bar icon that shows NanoClaw's running status and lets the user start, stop, or restart the service — similar to how Docker Desktop appears in the menu bar.

**macOS only.** Requires Xcode Command Line Tools (`swiftc`).

## Phase 1: Pre-flight

### Check platform

If not on macOS, stop and tell the user:

> This skill is macOS only. The menu bar status indicator uses AppKit and requires `swiftc` (Xcode Command Line Tools).

### Check for swiftc

```bash
which swiftc
```

If not found, tell the user:

> Xcode Command Line Tools are required. Install them by running:
>
> ```bash
> xcode-select --install
> ```
>
> Then re-run `/add-statusbar`.

### Check if already installed

```bash
launchctl list | grep com.nanoclaw.statusbar
```

If it returns a PID (not `-`), tell the user it's already installed and skip to Phase 4 (Verify).

## Phase 2: Apply Code Changes

### Initialize skills system (if needed)

If `.nanoclaw/` directory doesn't exist yet:

```bash
npx tsx scripts/apply-skill.ts --init
```

### Apply the skill

```bash
npx tsx scripts/apply-skill.ts .claude/skills/add-statusbar
```

This copies `src/statusbar.swift` into the project and records the application in `.nanoclaw/state.yaml`.

## Phase 3: Compile and Install

### Compile the Swift binary

```bash
swiftc -O -o dist/statusbar src/statusbar.swift
```

This produces a small (~55KB) native binary at `dist/statusbar`.

### Create the launchd plist

Determine the absolute project root:

```bash
pwd
```

Create `~/Library/LaunchAgents/com.nanoclaw.statusbar.plist`, substituting the actual values for `{PROJECT_ROOT}` and `{HOME}`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.nanoclaw.statusbar</string>
    <key>ProgramArguments</key>
    <array>
        <string>{PROJECT_ROOT}/dist/statusbar</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>EnvironmentVariables</key>
    <dict>
        <key>HOME</key>
        <string>{HOME}</string>
    </dict>
    <key>StandardOutPath</key>
    <string>{PROJECT_ROOT}/logs/statusbar.log</string>
    <key>StandardErrorPath</key>
    <string>{PROJECT_ROOT}/logs/statusbar.error.log</string>
</dict>
</plist>
```

### Load the service

```bash
launchctl load ~/Library/LaunchAgents/com.nanoclaw.statusbar.plist
```

## Phase 4: Verify

```bash
launchctl list | grep com.nanoclaw.statusbar
```

The first column should show a PID (not `-`).

Tell the user:

> The ⚡ icon should now appear in your macOS menu bar. Click it to see NanoClaw's status and control the service.
>
> - **Green dot** — NanoClaw is running
> - **Red dot** — NanoClaw is stopped
>
> Use **Restart** after making code changes, and **View Logs** to open the log file directly.

## Removal

```bash
launchctl unload ~/Library/LaunchAgents/com.nanoclaw.statusbar.plist
rm ~/Library/LaunchAgents/com.nanoclaw.statusbar.plist
rm dist/statusbar
rm src/statusbar.swift
```
