# nanoclaw-runner

`nanoclaw-runner` connects a remote machine to a NanoClaw central server, allowing agent groups to run locally instead of in the central container.

## Install

Download the latest binary for your platform from the [Releases](https://github.com/distillery-labs/nanoclaw/releases) page, or use `curl`:

**Linux / macOS:**
```bash
# Replace <version> and <os>_<arch> (e.g. linux_amd64, darwin_arm64)
curl -sSfL \
  https://github.com/distillery-labs/nanoclaw/releases/latest/download/nanoclaw-runner_<version>_<os>_<arch>.tar.gz \
  | tar -xz nanoclaw-runner
sudo mv nanoclaw-runner /usr/local/bin/
```

**Windows:** Download the `.zip` from the releases page and extract `nanoclaw-runner.exe`.

## Provisioning

On the central server, issue a bootstrap token:

```bash
ncl runners add --name my-runner
# → install_snippet: NANOCLAW_RUNNER_BOOTSTRAP=<token> ./nanoclaw-runner
# Token expires in 10 minutes and is single-use.
```

Start the runner on the remote machine with the bootstrap token:

```bash
export NANOCLAW_CENTRAL_URL=wss://your-nanoclaw-host/runner/connect
export NANOCLAW_RUNNER_NAME=my-runner
NANOCLAW_RUNNER_BOOTSTRAP=<token from ncl runners add> nanoclaw-runner
```

On first connect the runner exchanges the bootstrap token for a long-lived credential, which is stored in the platform credential directory (see below). Subsequent restarts use the saved credential — no token in the environment.

## Credential storage

Credentials are stored as a `0600`-mode plaintext file. The directory is:

| Platform | Path |
|---|---|
| macOS | `~/Library/Application Support/nanoclaw-runner/` |
| Linux | `$XDG_CONFIG_HOME/nanoclaw-runner/` or `~/.config/nanoclaw-runner/` |
| Windows | `%APPDATA%\nanoclaw-runner\` |

Override with `NANOCLAW_RUNNER_CREDENTIAL_DIR`.

**Threat model:** File permissions protect against other local users. If the runner account is compromised, the credential is exposed — so is everything else owned by that user. The real defence for lost-device scenarios is `ncl runners revoke --name <name>` on central, which invalidates the credential server-side and pushes a `TOKEN_INVALIDATE` to any live connection.

### Docker deployments

Mount a persistent volume so the credential survives container restarts:

```bash
docker run --rm \
  -v /host/nanoclaw-creds:/root/.config/nanoclaw-runner \
  -e NANOCLAW_CENTRAL_URL=wss://your-nanoclaw-host/runner/connect \
  -e NANOCLAW_RUNNER_NAME=my-runner \
  -e NANOCLAW_RUNNER_BOOTSTRAP=<token> \
  nanoclaw-runner:latest
```

Or set `NANOCLAW_RUNNER_CREDENTIAL_DIR` to a mounted path.

## Configuration

All configuration is via environment variables. `NANOCLAW_CENTRAL_URL` and `NANOCLAW_RUNNER_NAME` are required.

| Variable | Required | Default | Description |
|---|---|---|---|
| `NANOCLAW_CENTRAL_URL` | ✓ | — | WebSocket URL of the central server, e.g. `wss://example.com/runner/connect` |
| `NANOCLAW_RUNNER_NAME` | ✓ | — | Runner name as registered with `ncl runners add` |
| `NANOCLAW_RUNNER_BOOTSTRAP` | | — | One-time bootstrap token from `ncl runners add` (used once, then discarded) |
| `NANOCLAW_RUNNER_CREDENTIAL_DIR` | | platform default | Override credential storage directory |
| `NANOCLAW_RUNNER_TYPE` | | `persistent` | `persistent` or `ephemeral` |
| `NANOCLAW_RUNNER_VERSION` | | `dev` | Version string reported to central |
| `NANOCLAW_HEARTBEAT_INTERVAL_SEC` | | `30` | How often to send heartbeat frames |
| `NANOCLAW_RECONNECT_BASE_DELAY_SEC` | | `2` | Initial reconnect backoff delay |
| `NANOCLAW_RECONNECT_MAX_DELAY_SEC` | | `60` | Maximum reconnect backoff delay |
| `NANOCLAW_RUNNER_AUTO_UPDATE` | | `true` | Poll GitHub releases and self-update |
| `NANOCLAW_RUNNER_UPDATE_INTERVAL` | | `5m` | How often to poll for a new release |
| `NANOCLAW_RUNNER_ROTATION_INTERVAL` | | `24h` | How often to rotate the long-lived credential |

> **Deprecated:** `NANOCLAW_RUNNER_TOKEN` (static long-lived token). Still accepted for backward compatibility — migrated to the credential store on first connect, with a deprecation warning. Will be removed in a future release.

## Credential lifecycle

```
Admin                   Central                  Runner
  │                       │                        │
  │  ncl runners add      │                        │
  │──────────────────────►│                        │
  │  ← bootstrap token    │                        │
  │  (10 min, single use) │                        │
  │                       │                        │
  │       NANOCLAW_RUNNER_BOOTSTRAP=<token>        │
  │───────────────────────────────────────────────►│
  │                       │  RUNNER_REGISTER       │
  │                       │  (auth_type=bootstrap) │
  │                       │◄───────────────────────│
  │                       │  RUNNER_ACK+credential │
  │                       │───────────────────────►│
  │                       │         (saves to disk)│
  │                       │                        │
  │                       │  TOKEN_ROTATE_REQUEST  │ ← every 24h
  │                       │◄───────────────────────│
  │                       │  TOKEN_ROTATE_ACK      │
  │                       │  + new_credential      │
  │                       │───────────────────────►│
  │                       │         (saves to disk)│
  │                       │                        │
  │  ncl runners revoke   │                        │
  │──────────────────────►│  TOKEN_INVALIDATE      │
  │                       │───────────────────────►│
  │                       │       (deletes cred,   │
  │                       │        exits nonzero)  │
```

## Revoking a runner

```bash
ncl runners revoke --name my-runner
# → clears credential server-side, pushes TOKEN_INVALIDATE to live connection
```

After revocation, issue a new bootstrap token and restart the runner.

## Building from source

```bash
git clone https://github.com/distillery-labs/nanoclaw.git
cd nanoclaw/runner
go build -o nanoclaw-runner ./cmd/nanoclaw-runner
```

Requires Go 1.19+.
