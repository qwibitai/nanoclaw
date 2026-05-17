// Command nanoclaw-runner is the NanoClaw remote agent runner.
// It connects to a NanoClaw central server via WebSocket and executes
// agent turns for assigned agent groups on the local machine.
package main

import (
	"context"
	"log"
	"os"
	"os/signal"
	"syscall"

	"github.com/nanocoai/nanoclaw/runner/internal/client"
	"github.com/nanocoai/nanoclaw/runner/internal/config"
	"github.com/nanocoai/nanoclaw/runner/internal/keychain"
	"github.com/nanocoai/nanoclaw/runner/internal/protocol"
	"github.com/nanocoai/nanoclaw/runner/internal/updater"
)

// Set by goreleaser at build time via -ldflags.
var (
	version = "dev"
	commit  = "none"
	date    = "unknown"
)

func main() {
	cfg, err := config.Load()
	if err != nil {
		log.Fatalf("nanoclaw-runner: config error: %v", err)
	}

	log.Printf("nanoclaw-runner version=%s commit=%s date=%s starting — name=%s central=%s",
		version, commit, date, cfg.RunnerName, cfg.CentralURL)

	kc, err := keychain.New()
	if err != nil {
		log.Fatalf("nanoclaw-runner: cannot initialise credential store: %v\n"+
			"  Set NANOCLAW_RUNNER_CREDENTIAL_DIR to a writable directory.", err)
	}

	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()

	if cfg.AutoUpdate {
		u := updater.New(version, cfg.UpdateInterval)
		go u.Run(ctx)
		log.Printf("nanoclaw-runner: auto-update enabled (interval=%s)", cfg.UpdateInterval)
	} else {
		log.Printf("nanoclaw-runner: auto-update disabled")
	}

	c := client.New(cfg, kc, func(p protocol.InboundMessagePayload) {
		// Agent dispatch: v0 stub — logs the incoming message.
		// Full agent execution (spawning claude, proxying tool calls) is Phase 2.
		log.Printf("nanoclaw-runner: INBOUND_MESSAGE agent=%s msg=%s sender=%s",
			p.RemoteAgentID, p.MessageID, p.Sender)
	})

	c.Run(ctx)
	log.Printf("nanoclaw-runner: shutdown complete")
}
