#!/bin/bash
# NanoClaw agent container entrypoint.
#
# The host passes initial session parameters via stdin as a single JSON blob,
# then the agent-runner opens the session DBs at /workspace/{inbound,outbound}.db
# and enters its poll loop. All further IO flows through those DBs.
#
# We capture stdin to a file first so /tmp/input.json is available for
# post-mortem inspection if the container exits unexpectedly, then exec bun
# so that bun becomes PID 1's direct child (under tini) and receives signals.

set -e

# OneCLI gateway MITMs HTTPS via a self-signed CA mounted at
# /tmp/onecli-gateway-ca.pem. Node trusts it via NODE_EXTRA_CA_CERTS, but
# native binaries (gh, curl, git, Go-based tools) need a CA bundle that
# combines the system roots with the gateway CA. The OneCLI SDK tries to
# build that bundle host-side but bails on Windows because it can't find
# the system CA path; so we build it here in the container instead.
GATEWAY_CA="/tmp/onecli-gateway-ca.pem"
SYSTEM_CA="/etc/ssl/certs/ca-certificates.crt"
COMBINED_CA="/tmp/onecli-combined-ca.pem"
if [ -r "$GATEWAY_CA" ] && [ -r "$SYSTEM_CA" ] && [ ! -f "$COMBINED_CA" ]; then
  cat "$SYSTEM_CA" "$GATEWAY_CA" > "$COMBINED_CA" 2>/dev/null || true
fi
if [ -f "$COMBINED_CA" ]; then
  # Go (gh CLI), curl, git, Python requests — all read these.
  export SSL_CERT_FILE="$COMBINED_CA"
  export CURL_CA_BUNDLE="$COMBINED_CA"
  export GIT_SSL_CAINFO="$COMBINED_CA"
  export REQUESTS_CA_BUNDLE="$COMBINED_CA"
fi

cat > /tmp/input.json

exec bun run /app/src/index.ts < /tmp/input.json
