#!/bin/bash
# Ensures audio server (PulseAudio or PipeWire) is running on the host
# Called during auto-deployment to fix missing audio dependencies
# Exit 0 = audio available, Exit 1 = failed to fix, Exit 2 = not needed (headless)

set -e

USER_ID=${SUDO_USER:-$USER}
XDG_RUNTIME_DIR="/run/user/$(id -u "$USER_ID")"
PULSE_SOCKET="$XDG_RUNTIME_DIR/pulse/native"
PIPEWIRE_SOCKET="$XDG_RUNTIME_DIR/pipewire-0"

echo "Checking audio server availability for user $USER_ID..."

# Check if audio sockets already exist
if [ -S "$PULSE_SOCKET" ]; then
    echo "✓ PulseAudio socket found at $PULSE_SOCKET"
    exit 0
fi

if [ -S "$PIPEWIRE_SOCKET" ]; then
    echo "✓ PipeWire socket found at $PIPEWIRE_SOCKET"
    exit 0
fi

echo "⚠ No audio server socket found"

# Check if we're in a headless/server environment (no X11/Wayland)
if [ -z "$DISPLAY" ] && [ -z "$WAYLAND_DISPLAY" ]; then
    echo "ℹ Headless environment detected - audio not required"
    exit 2
fi

# Try to detect which audio system should be used
if command -v pipewire &> /dev/null; then
    echo "Attempting to start PipeWire..."
    if systemctl --user is-active --quiet pipewire.socket; then
        systemctl --user restart pipewire.socket pipewire.service
    else
        systemctl --user start pipewire.socket pipewire.service
    fi
    sleep 2

    if [ -S "$PIPEWIRE_SOCKET" ]; then
        echo "✓ PipeWire started successfully"
        exit 0
    fi
fi

if command -v pulseaudio &> /dev/null; then
    echo "Attempting to start PulseAudio..."
    if systemctl --user is-active --quiet pulseaudio.socket; then
        systemctl --user restart pulseaudio.socket pulseaudio.service
    else
        systemctl --user start pulseaudio.socket pulseaudio.service
    fi
    sleep 2

    if [ -S "$PULSE_SOCKET" ]; then
        echo "✓ PulseAudio started successfully"
        exit 0
    fi
fi

# Last resort: try installing PulseAudio if we have package manager access
if command -v apt-get &> /dev/null && [ "$EUID" -eq 0 ]; then
    echo "Installing PulseAudio..."
    apt-get update -qq
    apt-get install -y pulseaudio
    systemctl --user start pulseaudio.socket pulseaudio.service
    sleep 2

    if [ -S "$PULSE_SOCKET" ]; then
        echo "✓ PulseAudio installed and started"
        exit 0
    fi
fi

echo "✗ Failed to start or install audio server"
exit 1
