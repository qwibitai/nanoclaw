// Package config loads runner configuration from environment variables.
package config

import (
	"fmt"
	"os"
	"strconv"
)

// Config holds all runtime configuration for the runner.
type Config struct {
	// CentralURL is the WebSocket URL of the central server, e.g.
	// "ws://localhost:3031/runner/connect".
	CentralURL string

	// RunnerName is the human-readable name registered via `ncl runners add`.
	RunnerName string

	// RunnerToken is the plaintext bearer token (hashed on central).
	RunnerToken string

	// RunnerType is "persistent" or "ephemeral".
	RunnerType string

	// RunnerVersion is the version string reported in heartbeats.
	RunnerVersion string

	// HeartbeatIntervalSec is how often to send HEARTBEAT frames (seconds).
	HeartbeatIntervalSec int

	// ReconnectBaseDelaySec is the initial backoff delay on disconnect.
	ReconnectBaseDelaySec int

	// ReconnectMaxDelaySec caps the exponential backoff.
	ReconnectMaxDelaySec int
}

// Load reads configuration from environment variables.
// Required vars: NANOCLAW_CENTRAL_URL, NANOCLAW_RUNNER_NAME, NANOCLAW_RUNNER_TOKEN.
func Load() (*Config, error) {
	centralURL := os.Getenv("NANOCLAW_CENTRAL_URL")
	if centralURL == "" {
		return nil, fmt.Errorf("NANOCLAW_CENTRAL_URL is required")
	}

	runnerName := os.Getenv("NANOCLAW_RUNNER_NAME")
	if runnerName == "" {
		return nil, fmt.Errorf("NANOCLAW_RUNNER_NAME is required")
	}

	runnerToken := os.Getenv("NANOCLAW_RUNNER_TOKEN")
	if runnerToken == "" {
		return nil, fmt.Errorf("NANOCLAW_RUNNER_TOKEN is required")
	}

	runnerType := os.Getenv("NANOCLAW_RUNNER_TYPE")
	if runnerType == "" {
		runnerType = "persistent"
	}

	runnerVersion := os.Getenv("NANOCLAW_RUNNER_VERSION")
	if runnerVersion == "" {
		runnerVersion = "0.1.0"
	}

	heartbeatSec := envInt("NANOCLAW_HEARTBEAT_INTERVAL_SEC", 30)
	reconnectBase := envInt("NANOCLAW_RECONNECT_BASE_DELAY_SEC", 2)
	reconnectMax := envInt("NANOCLAW_RECONNECT_MAX_DELAY_SEC", 60)

	return &Config{
		CentralURL:            centralURL,
		RunnerName:            runnerName,
		RunnerToken:           runnerToken,
		RunnerType:            runnerType,
		RunnerVersion:         runnerVersion,
		HeartbeatIntervalSec:  heartbeatSec,
		ReconnectBaseDelaySec: reconnectBase,
		ReconnectMaxDelaySec:  reconnectMax,
	}, nil
}

func envInt(key string, defaultVal int) int {
	s := os.Getenv(key)
	if s == "" {
		return defaultVal
	}
	v, err := strconv.Atoi(s)
	if err != nil {
		return defaultVal
	}
	return v
}
