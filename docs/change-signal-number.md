# Changing Your NanoClaw Signal Number

*Synthesized by Jorgenclaw (AI agent) and Claude Code (host AI), with direct prompting and verification from Scott Jorgensen*

**Feeling stuck? Ask Claude directly where you are in the process and what to do next.**

## What You're Doing

Changing the phone number your NanoClaw agent uses on Signal. This keeps all your existing linked device sessions, message history, and group registrations intact — no need to re-link or start from scratch.

## What You'll Need

- Access to the Signal app on a phone where the agent's number is registered
- SSH or terminal access to the machine running NanoClaw
- The new phone number you want to switch to

## Before You Start

Your NanoClaw agent connects to Signal through a program called signal-cli, which runs as a background service (like a server that's always listening). When you change the number in the Signal app, signal-cli doesn't know about the change yet — it still thinks the old number is correct. The steps below update signal-cli to match.

## Steps

### Step 1: Change the number in the Signal app

On the phone where your agent's Signal account lives:

1. Open **Signal**
2. Go to **Settings** → **Account** → **Change Phone Number**
3. Follow the prompts to switch to your new number
4. Signal will verify the new number via SMS or voice call
5. Once confirmed, Signal says the number has been changed

**What this does:** Tells Signal's servers that your account now uses the new number. All your existing linked devices (including signal-cli) stay connected — they just don't know the number changed yet.

### Step 2: Stop NanoClaw and signal-cli

```bash
systemctl --user stop nanoclaw
systemctl --user stop signal-cli
```

**What this does:** Safely shuts down both services so we can update their configuration files without anything running.

### Step 3: Update signal-cli's account files

signal-cli stores the phone number in two places. Both need to be updated.

**File 1: The accounts index**

```bash
# Find and edit the accounts index
nano ~/.local/share/signal-cli/data/accounts.json
```

Find the line that says `"number" : "+1OLDNUMBER"` and change it to your new number. Save and exit.

**File 2: The account state file**

The accounts index points to a numbered file (like `836630`) in the same directory. Edit that file too:

```bash
# List the files to find the account state file (it's the one without an extension, not .d)
ls ~/.local/share/signal-cli/data/

# Edit it (replace 836630 with whatever your file is named)
nano ~/.local/share/signal-cli/data/836630
```

Find `"number" : "+1OLDNUMBER"` and change it to your new number. Save and exit.

### Step 4: Update the signal-cli service file

```bash
nano ~/.config/systemd/user/signal-cli.service
```

Find the `ExecStart` line and change the old number to the new one:

| What you want to do | What to change |
|---------------------|---------------|
| Update the number in the startup command | Change `-u +1OLDNUMBER` to `-u +1NEWNUMBER` |

Save and exit, then reload the service configuration:

```bash
systemctl --user daemon-reload
```

### Step 5: Update NanoClaw's environment

```bash
nano ~/NanoClaw/.env
```

| What you want to do | What to change |
|---------------------|---------------|
| Update the Signal phone number | Change `SIGNAL_PHONE_NUMBER=+1OLDNUMBER` to `SIGNAL_PHONE_NUMBER=+1NEWNUMBER` |

Save and exit.

### Step 6: Restart everything

```bash
systemctl --user start signal-cli
```

Wait a few seconds, then check that it's running:

```bash
systemctl --user status signal-cli
```

You should see `Active: active (running)` in green. If it shows `failed` or `exit-code`, check the troubleshooting section below.

Once signal-cli is running:

```bash
systemctl --user start nanoclaw
```

### Step 7: Test

Send your agent a message on Signal using the new number. It should respond normally. Your existing group registrations and conversation history carry over automatically because they're tied to your account UUID, not the phone number.

## Troubleshooting

| Problem | What it means | What to do |
|---------|--------------|------------|
| signal-cli fails with "Number in account file doesn't match expected number" | You updated one file but not the other | Check both `accounts.json` AND the numbered state file (e.g., `836630`) — both must have the new number |
| signal-cli fails with "No account found for number" | The accounts index doesn't have an entry for the new number | Edit `accounts.json` and make sure the `"number"` field matches what's in the service file |
| NanoClaw starts but doesn't respond to messages | signal-cli might still be starting up, or the .env wasn't updated | Wait 10 seconds, check `tail -20 ~/NanoClaw/logs/nanoclaw.log`, and verify `.env` has the correct `SIGNAL_PHONE_NUMBER` |
| Messages arrive on the phone but not in NanoClaw | signal-cli linked device might have been dropped | Check `signal-cli -a +1NEWNUMBER receive` manually — if it works, the service config might have the wrong number |

## What Prompt to Give Your Host AI

If you use Claude Code (or another AI coding assistant) to manage your NanoClaw install, you can paste this prompt to have it do the work for you:

> I just changed my NanoClaw agent's Signal number from +1OLDNUMBER to +1NEWNUMBER using the Signal app's "Change Phone Number" feature. Please update signal-cli and NanoClaw to use the new number. The files that need updating are:
> 1. `~/.local/share/signal-cli/data/accounts.json` — change the number field
> 2. `~/.local/share/signal-cli/data/<account-file>` — change the number field (find the right file from accounts.json)
> 3. `~/.config/systemd/user/signal-cli.service` — change -u flag in ExecStart
> 4. `~/NanoClaw/.env` — change SIGNAL_PHONE_NUMBER
> Then daemon-reload, restart signal-cli, restart nanoclaw, and verify both are running.

## Notes

- This process works because Signal's "Change Phone Number" feature updates the server-side association without invalidating linked devices. signal-cli stays linked — it just needs its local config files to reflect the new number.
- Your agent's UUID stays the same after a number change. Group registrations, message history, and contact associations all carry over.
- If you ever need to go back to the old number, the process is the same — change it in the Signal app first, then update the four config files.
