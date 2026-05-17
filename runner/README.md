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

Verify:
```bash
nanoclaw-runner --version   # not yet wired; check startup log
```

## Configuration

All configuration is via environment variables. `NANOCLAW_CENTRAL_URL`, `NANOCLAW_RUNNER_NAME`, and `NANOCLAW_RUNNER_TOKEN` are required.

| Variable | Required | Default | Description |
|---|---|---|---|
| `NANOCLAW_CENTRAL_URL` | ✓ | — | WebSocket URL of the central server, e.g. `wss://example.com/runner/connect` |
| `NANOCLAW_RUNNER_NAME` | ✓ | — | Runner name as registered with `ncl runners add` |
| `NANOCLAW_RUNNER_TOKEN` | ✓ | — | Token returned by `ncl runners add` (shown once at creation) |
| `NANOCLAW_RUNNER_TYPE` | | `persistent` | `persistent` or `ephemeral` |
| `NANOCLAW_RUNNER_VERSION` | | `dev` | Version string reported to central |
| `NANOCLAW_HEARTBEAT_INTERVAL_SEC` | | `30` | How often to send heartbeat frames |
| `NANOCLAW_RECONNECT_BASE_DELAY_SEC` | | `2` | Initial reconnect backoff delay |
| `NANOCLAW_RECONNECT_MAX_DELAY_SEC` | | `60` | Maximum reconnect backoff delay |

## Running

```bash
export NANOCLAW_CENTRAL_URL=wss://your-nanoclaw-host/runner/connect
export NANOCLAW_RUNNER_NAME=my-runner
export NANOCLAW_RUNNER_TOKEN=<token from ncl runners add>

nanoclaw-runner
```

The runner connects, performs the REGISTER → ACK handshake, and then sends periodic heartbeats. It reconnects automatically with exponential backoff if the connection drops.

## Docker

```bash
docker run --rm \
  -e NANOCLAW_CENTRAL_URL=wss://your-nanoclaw-host/runner/connect \
  -e NANOCLAW_RUNNER_NAME=my-runner \
  -e NANOCLAW_RUNNER_TOKEN=<token> \
  nanoclaw-runner:latest
```

Build the image:
```bash
docker build -t nanoclaw-runner:latest .
```

## Registering a runner

On the central server, add a runner record and get a token:

```bash
ncl runners add --name my-runner
# → Runner token: <hex token>  (shown once — save it)
```

Then start `nanoclaw-runner` with that token. Once connected, `ncl runners list` will show `status: connected`.

## Building from source

```bash
git clone https://github.com/distillery-labs/nanoclaw.git
cd nanoclaw/runner
go build -o nanoclaw-runner ./cmd/nanoclaw-runner
```

Requires Go 1.19+.
