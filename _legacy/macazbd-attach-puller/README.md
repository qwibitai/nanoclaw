# macazbd attachment puller

Bridges `/workspace/attachments/<file>` from jibotmac → macazbd so the
`amplifier-remote` agent (which runs the agent loop on macazbd, not in
jibotmac's container) can `Read` files the user attached to chats.

## Why this exists

The container on jibotmac has `/workspace/attachments/` bind-mounted from
`~/nanoclaw/data/attachments/`. Most providers (Claude SDK, OpenCode, Codex)
run in that container and Read those files locally. `amplifier-remote`
forwards the prompt over a reverse tunnel to amplifierd on macazbd — so
the actual `Read` tool runs on macazbd's filesystem, where
`/workspace/attachments/` doesn't exist.

This puller plugs that gap. The container-side hook in
`container/agent-runner/src/providers/amplifier-remote.ts` scans each
prompt for `/workspace/attachments/<file>` references and POSTs to this
service before forwarding the prompt to amplifierd. We block on each
fetch — small files are fast, and rsync is idempotent so the second turn
referencing the same attachment is essentially free.

## Topology

```
[ jibotmac container ]
   |  AMPLIFIERD_ATTACH_PULL_URL = http://host.docker.internal:9091/sync
   v
[ jibotmac host:9091 ]   <-- reverse-forwarded by macazbd's existing ssh tunnel
   |  ssh -R 9091:localhost:9091
   v
[ macazbd:9091 (this puller) ]
   |  rsync jibotmac:nanoclaw/data/attachments/<file>  (using macazbd's outbound ssh)
   v
[ ATTACH_DEST on macazbd ]   <-- symlinked into amplifierd working_dir/workspace/attachments
```

## Install on macazbd

1. **Drop the script and plist:**
   ```bash
   mkdir -p ~/.local/share/nanoclaw-attach-puller
   cp puller.py ~/.local/share/nanoclaw-attach-puller/puller.py
   chmod +x ~/.local/share/nanoclaw-attach-puller/puller.py
   ```

2. **Customize the plist** — open
   `com.macazbd.nanoclaw-attach-puller.plist` and replace every
   `/Users/REPLACE_ME/` with your actual home dir. Then:
   ```bash
   cp com.macazbd.nanoclaw-attach-puller.plist \
      ~/Library/LaunchAgents/com.macazbd.nanoclaw-attach-puller.plist
   launchctl load ~/Library/LaunchAgents/com.macazbd.nanoclaw-attach-puller.plist
   ```

3. **Verify it's listening:**
   ```bash
   curl -fsS -X POST http://127.0.0.1:9091/sync \
     -H "Content-Type: application/json" \
     -d '{"file":"nonsense.bin"}'
   # Expect HTTP 503 with detail "rsync exit 23: ..." (file missing) — proves
   # the daemon is up and ssh runs. Returning 400 means basename validation
   # is fine; 200 is a hit.
   ```

4. **Symlink into amplifierd's working_dir.** Find the bundle's
   working_dir (on Joi's macazbd: `/Users/joi/workspaces/jibot`):
   ```bash
   ln -snf ~/.local/share/nanoclaw-attachments \
       <AMPLIFIERD_WORKING_DIR>/workspace/attachments
   ```
   Note the **relative** path. The container-side provider rewrites
   `/workspace/attachments/<file>` (absolute) → `workspace/attachments/<file>`
   (relative) before sending the prompt, because amplifierd's Read tool
   only prefixes RELATIVE paths with the working_dir; absolute paths are
   taken literally and `/workspace` doesn't exist at root on macazbd.

## Extend the existing macazbd → jibotmac ssh tunnel

The reverse tunnel for amplifierd's port already exists on macazbd. Add
a `RemoteForward` so jibotmac:9091 reaches macazbd:9091 (the puller).

If the tunnel is set up as a launchd-managed `ssh` command, edit the
plist's `ProgramArguments` to add:

```
-o ExitOnForwardFailure=yes
-R 9091:127.0.0.1:9091
```

…alongside the existing `-R 8410:127.0.0.1:8410` (or whichever port
amplifierd uses).

If it's set up via `~/.ssh/config`:

```
Host jibotmac-tunnel
  HostName jibotmac
  RemoteForward 8410 127.0.0.1:8410
  RemoteForward 9091 127.0.0.1:9091     # ← add
  ServerAliveInterval 30
  ExitOnForwardFailure yes
```

Bounce the tunnel after editing.

## Wire jibotmac side

On jibotmac, add to `~/.config/amplifierd/credentials.env`:

```
AMPLIFIERD_ATTACH_PULL_URL=http://host.docker.internal:9091/sync
```

The host-side `src/providers/amplifier-remote.ts` already forwards this
key into the container env. Restart any in-flight container so the new
env takes effect:

```bash
docker ps --format '{{.Names}}' | grep '^nanoclaw-v2-' | xargs -r docker rm -f
```

## Verification

1. From jibotmac container, sanity-check the path through the tunnel:
   ```bash
   docker exec <container> sh -c \
     'curl -fsS -X POST http://host.docker.internal:9091/sync \
        -H "Content-Type: application/json" -d "{\"file\":\"nonsense.bin\"}"'
   # 503 with rsync stderr → end-to-end path works.
   ```

2. Send a fresh PDF to `joi-dm` via LINE. On macazbd:
   ```bash
   tail -f ~/.local/share/nanoclaw-attach-puller/puller.log
   ls -la ~/.local/share/nanoclaw-attachments/
   ```

3. The agent should `Read` the file successfully without
   complaining about hosts.

## Failure modes

- **400 from puller** — basename failed validation. Channel adapter
  produced an unusual filename. Fix the adapter, not the puller.
- **503 from puller** — rsync failed. Common causes:
  - macazbd's ssh key for jibotmac is missing or expired.
  - File hasn't landed on jibotmac yet (race — should self-heal on retry).
  - `JIBOTMAC_ATTACH_DIR` points at the old `nanoclaw-merge` path. Fix
    the plist's `EnvironmentVariables`.
- **Container error "attachment-puller network error"** — tunnel isn't
  forwarding. Verify the `-R 9091:...` was added on macazbd's ssh and
  that the daemon is actually bound on macazbd:9091.
