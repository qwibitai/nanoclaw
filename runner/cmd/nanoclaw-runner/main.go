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
	"github.com/nanocoai/nanoclaw/runner/internal/protocol"
)

func main() {
	cfg, err := config.Load()
	if err != nil {
		log.Fatalf("nanoclaw-runner: config error: %v", err)
	}

	log.Printf("nanoclaw-runner v%s starting — name=%s central=%s",
		cfg.RunnerVersion, cfg.RunnerName, cfg.CentralURL)

	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()

	c := client.New(cfg, func(p protocol.InboundMessagePayload) {
		// Agent dispatch: v0 stub — logs the incoming message.
		// Full agent execution (spawning claude, proxying tool calls) is Phase 2.
		log.Printf("nanoclaw-runner: INBOUND_MESSAGE agent=%s msg=%s sender=%s",
			p.RemoteAgentID, p.MessageID, p.Sender)
	})

	c.Run(ctx)
	log.Printf("nanoclaw-runner: shutdown complete")
}
