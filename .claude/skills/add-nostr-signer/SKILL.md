---
name: add-nostr-signer
description: "Nostr signing daemon — keeps private key in kernel keyring, signs events via Unix socket. Required by add-nostr-dm, add-whitenoise, and add-nwc-wallet skills."
---

*Synthesized by Jorgenclaw (AI agent) and Claude Code (host AI), with direct feedback and verification from Scott Jorgensen*

# Add Nostr Signing Daemon

This skill installs a signing daemon that holds your Nostr private key securely in memory. Other NanoClaw skills (Nostr DM, White Noise, NWC wallet) use this daemon to sign events without ever seeing the private key.

> **Feeling stuck?** Don't be afraid to ask Claude directly where you are in the process and what to do next.

## What You're Setting Up

| Component | What it does |
|-----------|-------------|
| **Signing daemon** (`tools/nostr-signer/index.js`) | A background service that reads your private key from the Linux keyring at startup and signs Nostr events on request |
| **clawstr-post** (`tools/nostr-signer/clawstr-post.js`) | A command-line tool that lets the agent post to Nostr relays by delegating signing to the daemon |
| **Unix socket** | The daemon listens on a socket file — other programs connect to it to request signatures |
| **Kernel keyring** | A secure area of Linux memory where your private key is stored — it never touches disk |

## Phase 1: Pre-flight

### Check if already installed

Check if `tools/nostr-signer/index.js` exists. If it does, skip to Phase 3 (Setup). The code is already in place.

### Ask the user

Use `AskUserQuestion`:

AskUserQuestion: Do you have a Nostr private key (nsec), or do you need to generate one?

**If they have one:** Collect it (starts with `nsec1...`). Keep it in memory only — never write it to a file or log it.

**If they need one:** We'll generate one in Phase 3.

## Phase 2: Apply Code Changes

### Add the signing daemon files

Copy these files into the project:

| Source | Destination |
|--------|-------------|
| `tools/nostr-signer/index.js` | Signing daemon — the main service |
| `tools/nostr-signer/clawstr-post.js` | Nostr posting CLI tool |
| `tools/nostr-signer/package.json` | Node.js dependencies for the daemon |

### Install daemon dependencies

```bash
cd tools/nostr-signer && npm install && cd ../..
```

### Update container-runner.ts

Add two mounts in the `buildVolumeMounts()` function (or equivalent mount-building section) so containers can access the signing daemon:

1. **Signer socket mount** — Mount the host's signing daemon socket into the container:
   - Host path: `$XDG_RUNTIME_DIR/nostr-signer.sock` (typically `/run/user/1000/nostr-signer.sock`)
   - Container path: `/run/nostr/signer.sock`
   - Read-only: yes
   - The container env var `NOSTR_SIGNER_SOCKET` should be set to `/run/nostr/signer.sock`

2. **clawstr-post mount** — Mount the posting tool so containers can publish to Nostr:
   - Host path: `tools/nostr-signer/clawstr-post.js`
   - Container path: `/usr/local/lib/nostr-signer/clawstr-post.js`
   - Read-only: yes

Also add `-e NOSTR_SIGNER_SOCKET=/run/nostr/signer.sock` to the container environment variables.

### Validate

```bash
npm run build
```

Build must be clean before proceeding.

## Phase 3: Setup

### Generate a key (if needed)

If the user doesn't have an nsec, generate one:

```bash
cd tools/nostr-signer && node -e "
  const { generateSecretKey } = await import('nostr-tools/pure');
  const { nsecEncode } = await import('nostr-tools/nip19');
  const sk = generateSecretKey();
  console.log(nsecEncode(sk));
" && cd ../..
```

**Important:** Show the nsec to the user exactly once and tell them to save it in their password manager. It will never be shown again.

### Store key in kernel keyring

The keyring keeps the key in memory only — it never touches disk:

```bash
echo -n "nsec1..." | keyctl padd user wn_nsec @u
```

Replace `nsec1...` with the actual key. The `wn_nsec` name is what the daemon searches for at startup.

**Verify it's stored:**

```bash
keyctl search @u user wn_nsec
```

This should print a key ID number. If it says "not found", the key wasn't stored correctly.

> **Note:** The kernel keyring is cleared on reboot. You'll need to re-add the key after each restart (or add the `keyctl` command to a startup script).

### Create systemd service

Create `~/.config/systemd/user/nostr-signer.service`:

```ini
[Unit]
Description=Nostr Signing Daemon
After=network.target

[Service]
Type=simple
ExecStart=/usr/bin/env node /path/to/NanoClaw/tools/nostr-signer/index.js
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
```

Replace `/path/to/NanoClaw` with the actual project path.

### Start the service

```bash
systemctl --user daemon-reload
systemctl --user enable nostr-signer
systemctl --user start nostr-signer
```

### Add to .env

```
NOSTR_SIGNER_SOCKET=/run/user/1000/nostr-signer.sock
```

Adjust the path if your `XDG_RUNTIME_DIR` is different (check with `echo $XDG_RUNTIME_DIR`).

## Phase 4: Verify

### Check the service is running

```bash
systemctl --user status nostr-signer
```

You should see `Active: active (running)` in green.

### Test signing via socket

```bash
echo '{"method":"get_public_key"}' | socat - UNIX-CONNECT:$XDG_RUNTIME_DIR/nostr-signer.sock
```

This should return a JSON response with your public key (hex format). If it does, the daemon is working.

### Test clawstr-post

```bash
node tools/nostr-signer/clawstr-post.js pubkey
```

This should print the same public key.

## Phase 5: Troubleshooting

| Problem | What it means | What to do |
|---------|--------------|------------|
| "Failed to load key from keyring" | The nsec isn't in the kernel keyring | Run the `keyctl padd` command from Phase 3 again |
| Socket not found | The daemon isn't running or socket path is wrong | Check `systemctl --user status nostr-signer` and verify the socket path |
| Permission denied on socket | Socket has wrong permissions | The daemon sets `chmod 600` automatically — make sure you're running as the same user |
| Key lost after reboot | Kernel keyring is cleared on reboot | Re-add the key with `keyctl padd` and restart the daemon |
| "EADDRINUSE" error | Old socket file wasn't cleaned up | Delete the stale socket: `rm $XDG_RUNTIME_DIR/nostr-signer.sock` and restart |

## Removal

To remove the signing daemon:

1. Stop and disable the service: `systemctl --user stop nostr-signer && systemctl --user disable nostr-signer`
2. Remove the service file: `rm ~/.config/systemd/user/nostr-signer.service`
3. Remove from keyring: `keyctl unlink $(keyctl search @u user wn_nsec) @u`
4. Delete daemon files: `rm -rf tools/nostr-signer/`
5. Remove `NOSTR_SIGNER_SOCKET` from `.env`
6. Revert the container-runner.ts changes (remove socket and clawstr-post mounts)
7. Rebuild: `npm run build`
