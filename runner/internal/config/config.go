// Package config loads runner configuration from environment variables.
package config

import (
	"fmt"
	"os"
	"strconv"
	"time"
)

// Config holds all runtime configuration for the runner.
type Config struct {
	// CentralURL is the WebSocket URL of the central server, e.g.
	// "ws://localhost:3031/runner/connect".
	CentralURL string

	// RunnerName is the human-readable name registered via `ncl runners add`.
	RunnerName string

	// BootstrapToken is the one-time bootstrap token from NANOCLAW_RUNNER_BOOTSTRAP.
	// Used on first connect to exchange for a long-lived credential stored in keychain.
	BootstrapToken string

	// LegacyToken is a pre-bootstrap long-lived token from the deprecated
	// NANOCLAW_RUNNER_TOKEN env var. Migrated to keychain on first connect and logged
	// as deprecated. Will be removed in a future release.
	LegacyToken string

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

	// AutoUpdate enables the background self-update goroutine.
	AutoUpdate bool

	// UpdateInterval controls how often to poll for a new release.
	UpdateInterval time.Duration

	// RotationInterval controls how often the runner rotates its credential.
	RotationInterval time.Duration
}

// Load reads configuration from environment variables.
// Required vars: NANOCLAW_CENTRAL_URL, NANOCLAW_RUNNER_NAME.
// Auth: one of NANOCLAW_RUNNER_BOOTSTRAP (new), NANOCLAW_RUNNER_TOKEN (deprecated), or keychain.
func Load() (*Config, error) {
	centralURL := os.Getenv("NANOCLAW_CENTRAL_URL")
	if centralURL == "" {
		return nil, fmt.Errorf("NANOCLAW_CENTRAL_URL is required")
	}

	runnerName := os.Getenv("NANOCLAW_RUNNER_NAME")
	if runnerName == "" {
		return nil, fmt.Errorf("NANOCLAW_RUNNER_NAME is required")
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
	autoUpdate := envBool("NANOCLAW_RUNNER_AUTO_UPDATE", true)
	updateInterval := envDuration("NANOCLAW_RUNNER_UPDATE_INTERVAL", 5*time.Minute)
	rotationInterval := envDuration("NANOCLAW_RUNNER_ROTATION_INTERVAL", 24*time.Hour)

	return &Config{
		CentralURL:            centralURL,
		RunnerName:            runnerName,
		BootstrapToken:        os.Getenv("NANOCLAW_RUNNER_BOOTSTRAP"),
		LegacyToken:           os.Getenv("NANOCLAW_RUNNER_TOKEN"),
		RunnerType:            runnerType,
		RunnerVersion:         runnerVersion,
		HeartbeatIntervalSec:  heartbeatSec,
		ReconnectBaseDelaySec: reconnectBase,
		ReconnectMaxDelaySec:  reconnectMax,
		AutoUpdate:            autoUpdate,
		UpdateInterval:        updateInterval,
		RotationInterval:      rotationInterval,
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

func envBool(key string, defaultVal bool) bool {
	s := os.Getenv(key)
	if s == "" {
		return defaultVal
	}
	v, err := strconv.ParseBool(s)
	if err != nil {
		return defaultVal
	}
	return v
}

func envDuration(key string, defaultVal time.Duration) time.Duration {
	s := os.Getenv(key)
	if s == "" {
		return defaultVal
	}
	v, err := time.ParseDuration(s)
	if err != nil {
		return defaultVal
	}
	return v
}
