# ToDo After a Reboot

The reboot wipes the kernel keyring, which breaks `nostr-signer` and `wnd`. Everything else auto-recovers (including `pass-cli`, which uses the filesystem key provider).

## Step 1: Re-add Nostr nsec to the kernel keyring

```bash
keyctl add user wn_nsec "YOUR_NSEC1_KEY_HERE" @u
```

Replace with your actual `nsec1...` string (stored in Proton Pass).

**Security note:** Close the terminal window (or run `clear && history -c`) after entering this command so your nsec isn't left in the scrollback buffer.

## Step 2: Delete stale WND MLS database

The desktop keyring loses wnd's encryption key on reboot, making the old database unreadable.

```bash
rm -rf ~/.local/share/whitenoise-cli/release/mls/*
```

## Step 3: Rebuild and restart services

If any code was changed before the reboot, the compiled `dist/` may be stale. Rebuild first so services (especially the paid MCP server on port 3002) start correctly.

```bash
cd ~/NanoClaw && npm run build && systemctl --user restart nostr-signer wnd nanoclaw
```

## Step 4: Re-login to White Noise

```bash
wn login --socket ~/.local/share/whitenoise-cli/release/wnd.sock
```

This will prompt for your nsec. **Close the terminal window after logging in** so the key isn't left in the scrollback.

Then restart wnd to pick up the new account:

```bash
systemctl --user restart wnd
```

## Step 5: Recreate White Noise groups

Old MLS groups are gone after reset. Recreate from the White Noise app, then update the group JID in `store/messages.db` if the MLS group ID changed.

## Step 6: Verify everything is running

```bash
systemctl --user status signal-cli wnd nostr-signer nanoclaw
```

All four should show `active (running)`.

Quick check that pass-cli works (should survive reboots automatically):

```bash
PROTON_PASS_KEY_PROVIDER=fs pass-cli test
```

Should print `Connection successful`. If not, re-login:

```bash
PROTON_PASS_KEY_PROVIDER=fs pass-cli login
```
