#!/bin/bash
# Start Tailscale in userspace networking mode (no root or /dev/net/tun needed)
if [ -n "$TAILSCALE_AUTH_KEY" ]; then
    tailscaled --state=mem: --tun=userspace-networking --socket=/tmp/tailscale.sock 2>/tmp/tailscaled.log &
    # Wait for daemon socket to appear (up to 10 s)
    for i in $(seq 1 10); do
        tailscale --socket=/tmp/tailscale.sock status >/dev/null 2>&1 && break
        sleep 1
    done
    TS_UP_ARGS="--auth-key=$TAILSCALE_AUTH_KEY --accept-routes --timeout=10s"
    if [ -n "$TAILSCALE_HOSTNAME" ]; then
        TS_UP_ARGS="$TS_UP_ARGS --hostname=$TAILSCALE_HOSTNAME"
    fi
    mkdir -p /var/run/tailscale
    ln -sf /tmp/tailscale.sock /var/run/tailscale/tailscaled.sock
    tailscale --socket=/tmp/tailscale.sock up $TS_UP_ARGS || true
    # Serve port 8088 over HTTPS on the tailnet
    tailscale --socket=/tmp/tailscale.sock serve --bg 8088 2>/tmp/tailscale-serve.log || true
    echo "[tailscale] Setup complete"
fi
