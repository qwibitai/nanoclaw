// Package client implements the NanoClaw runner protocol client.
// It connects to central, handles registration/heartbeat, and dispatches
// INBOUND_MESSAGE frames to registered agent handlers.
package client

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"math"
	"os"
	"sync"
	"sync/atomic"
	"time"

	"nhooyr.io/websocket"
	"nhooyr.io/websocket/wsjson"

	"github.com/nanocoai/nanoclaw/runner/internal/config"
	"github.com/nanocoai/nanoclaw/runner/internal/executor"
	"github.com/nanocoai/nanoclaw/runner/internal/keychain"
	"github.com/nanocoai/nanoclaw/runner/internal/protocol"
)

// InboundHandler is called when central sends an INBOUND_MESSAGE.
type InboundHandler func(payload protocol.InboundMessagePayload)

// Client manages the WebSocket connection to central.
type Client struct {
	cfg            *config.Config
	kc             *keychain.Keychain
	startTime      time.Time
	inboundHandler InboundHandler
	exec           *executor.Executor

	// seq is the monotonic counter for frames we send.
	seq atomic.Int64
	// lastCentralSeq is the last seq we received from central.
	lastCentralSeq atomic.Int64
	// sessionID is set after successful registration.
	sessionID string

	// mu protects conn, sessionID, and credential.
	mu         sync.Mutex
	conn       *websocket.Conn
	credential string // in-memory copy of active credential; updated on rotation
}

// New creates a new Client. Call Run to connect and start the event loop.
// kc may be nil (credential stored only in memory; not persisted across restarts).
func New(cfg *config.Config, kc *keychain.Keychain, handler InboundHandler) *Client {
	return &Client{
		cfg:            cfg,
		kc:             kc,
		startTime:      time.Now(),
		inboundHandler: handler,
		exec:           executor.New(),
	}
}

// Run connects to central and runs the read/write loop, reconnecting on
// disconnect using exponential backoff. Blocks until ctx is cancelled.
func (c *Client) Run(ctx context.Context) {
	delay := time.Duration(c.cfg.ReconnectBaseDelaySec) * time.Second
	maxDelay := time.Duration(c.cfg.ReconnectMaxDelaySec) * time.Second

	for {
		if err := c.connect(ctx); err != nil {
			if ctx.Err() != nil {
				return
			}
			log.Printf("runner: connection error: %v — retrying in %s", err, delay)
		} else {
			log.Printf("runner: disconnected — reconnecting in %s", delay)
		}

		select {
		case <-ctx.Done():
			return
		case <-time.After(delay):
		}

		delay = time.Duration(math.Min(float64(delay*2), float64(maxDelay)))
	}
}

// connect establishes a single WebSocket connection, authenticates, and runs
// the heartbeat, rotation, and read loops until the connection closes.
func (c *Client) connect(ctx context.Context) error {
	token, authType, err := c.resolveToken()
	if err != nil {
		return err
	}

	conn, _, err := websocket.Dial(ctx, c.cfg.CentralURL, nil)
	if err != nil {
		return fmt.Errorf("dial: %w", err)
	}
	defer conn.Close(websocket.StatusNormalClosure, "runner disconnecting")

	c.mu.Lock()
	c.conn = conn
	c.mu.Unlock()

	log.Printf("runner: connected to %s (auth=%s)", c.cfg.CentralURL, authType)

	registerPayload := protocol.RunnerRegisterPayload{
		RunnerToken:     token,
		AuthType:        authType,
		RunnerName:      c.cfg.RunnerName,
		RunnerType:      c.cfg.RunnerType,
		RunnerVersion:   c.cfg.RunnerVersion,
		ProtocolVersion: protocol.ProtocolVersion,
		LastInboundSeq:  c.lastCentralSeq.Load(),
		LastOutboundSeq: c.seq.Load(),
		LocalMCPs:       []protocol.LocalMCP{},
	}
	if err := c.sendFrame(ctx, conn, protocol.TypeRunnerRegister, registerPayload); err != nil {
		return fmt.Errorf("RUNNER_REGISTER: %w", err)
	}

	ackFrame, err := c.readFrame(ctx, conn)
	if err != nil {
		return fmt.Errorf("waiting for RUNNER_ACK: %w", err)
	}

	switch ackFrame.Type {
	case protocol.TypeRunnerAck:
		var ack protocol.RunnerAckPayload
		if err := json.Unmarshal(ackFrame.Payload, &ack); err != nil {
			return fmt.Errorf("decode RUNNER_ACK: %w", err)
		}
		c.mu.Lock()
		c.sessionID = ack.SessionID
		c.mu.Unlock()

		if ack.Credential != "" {
			// Bootstrap flow succeeded — persist the minted credential.
			if c.kc != nil {
				if err := c.kc.SaveCredential(ack.Credential); err != nil {
					log.Printf("runner: WARNING: failed to save credential to keychain: %v", err)
				} else {
					_ = c.kc.DeleteBootstrap()
					log.Printf("runner: bootstrap consumed; credential saved")
				}
			}
			c.mu.Lock()
			c.credential = ack.Credential
			c.mu.Unlock()
		}

		log.Printf("runner: registered — id=%s session=%s agents=%d",
			ack.RunnerID, ack.SessionID, len(ack.ConfigSnapshot.RemoteAgents))

	case protocol.TypeError:
		var errPay protocol.ErrorPayload
		if err := json.Unmarshal(ackFrame.Payload, &errPay); err != nil {
			return fmt.Errorf("auth error (unparseable): %w", err)
		}
		return fmt.Errorf("central rejected registration: %s — %s", errPay.Code, errPay.Message)

	default:
		return fmt.Errorf("unexpected frame type after RUNNER_REGISTER: %s", ackFrame.Type)
	}

	hbCtx, hbCancel := context.WithCancel(ctx)
	defer hbCancel()
	go c.heartbeatLoop(hbCtx, conn)
	go c.rotationLoop(hbCtx, conn)

	return c.readLoop(ctx, conn)
}

// resolveToken loads the token to use for the next RUNNER_REGISTER, in priority order:
//  1. In-memory credential (set after bootstrap or rotation).
//  2. Keychain credential.
//  3. Legacy NANOCLAW_RUNNER_TOKEN (deprecated — migrated to keychain on first use).
//  4. Keychain bootstrap token.
//  5. NANOCLAW_RUNNER_BOOTSTRAP env var.
func (c *Client) resolveToken() (token, authType string, err error) {
	// 1. In-memory credential (post-bootstrap or post-rotation state).
	c.mu.Lock()
	mem := c.credential
	c.mu.Unlock()
	if mem != "" {
		return mem, "credential", nil
	}

	// 2. Keychain credential.
	if c.kc != nil {
		if cred, err := c.kc.LoadCredential(); err == nil {
			c.mu.Lock()
			c.credential = cred
			c.mu.Unlock()
			return cred, "credential", nil
		}
	}

	// 3. Legacy NANOCLAW_RUNNER_TOKEN (deprecated).
	if c.cfg.LegacyToken != "" {
		log.Printf("runner: WARNING: NANOCLAW_RUNNER_TOKEN is deprecated; " +
			"re-provision with ncl runners add and use NANOCLAW_RUNNER_BOOTSTRAP")
		if c.kc != nil {
			_ = c.kc.SaveCredential(c.cfg.LegacyToken)
		}
		c.mu.Lock()
		c.credential = c.cfg.LegacyToken
		c.mu.Unlock()
		return c.cfg.LegacyToken, "credential", nil
	}

	// 4. Keychain bootstrap.
	if c.kc != nil {
		if boot, err := c.kc.LoadBootstrap(); err == nil {
			return boot, "bootstrap", nil
		}
	}

	// 5. NANOCLAW_RUNNER_BOOTSTRAP env var.
	if c.cfg.BootstrapToken != "" {
		return c.cfg.BootstrapToken, "bootstrap", nil
	}

	return "", "", fmt.Errorf(
		"no credential or bootstrap token found; " +
			"run 'ncl runners add --name %s' on central and set NANOCLAW_RUNNER_BOOTSTRAP",
		c.cfg.RunnerName,
	)
}

// readLoop reads frames from central and dispatches them.
func (c *Client) readLoop(ctx context.Context, conn *websocket.Conn) error {
	for {
		frame, err := c.readFrame(ctx, conn)
		if err != nil {
			return err
		}
		c.lastCentralSeq.Store(frame.Seq)
		c.dispatch(ctx, conn, frame)
	}
}

// dispatch routes an inbound frame to the appropriate handler.
func (c *Client) dispatch(ctx context.Context, conn *websocket.Conn, frame *protocol.RawFrame) {
	switch frame.Type {
	case protocol.TypeInboundMessage:
		var p protocol.InboundMessagePayload
		if err := json.Unmarshal(frame.Payload, &p); err != nil {
			log.Printf("runner: decode INBOUND_MESSAGE: %v", err)
			return
		}
		ack := protocol.MessageAckPayload{
			MessageID:     p.MessageID,
			RemoteAgentID: p.RemoteAgentID,
			Status:        "received",
		}
		if err := c.sendFrame(ctx, conn, protocol.TypeMessageAck, ack); err != nil {
			log.Printf("runner: send MESSAGE_ACK: %v", err)
		}
		if c.inboundHandler != nil {
			c.inboundHandler(p)
		}

	case protocol.TypeHeartbeatAck:
		// Normal — nothing to do.

	case protocol.TypeTokenRotateAck:
		var p protocol.TokenRotateAckPayload
		if err := json.Unmarshal(frame.Payload, &p); err != nil {
			log.Printf("runner: decode TOKEN_ROTATE_ACK: %v", err)
			return
		}
		if c.kc != nil {
			if err := c.kc.SaveCredential(p.NewCredential); err != nil {
				log.Printf("runner: WARNING: failed to save rotated credential: %v", err)
			}
		}
		c.mu.Lock()
		c.credential = p.NewCredential
		c.mu.Unlock()
		log.Printf("runner: credential rotated and saved")

	case protocol.TypeTokenInvalidate:
		var p protocol.TokenInvalidatePayload
		if err := json.Unmarshal(frame.Payload, &p); err != nil {
			log.Printf("runner: decode TOKEN_INVALIDATE: %v", err)
		} else {
			log.Printf("runner: TOKEN_INVALIDATE received — reason=%s %s", p.Reason, p.Message)
		}
		if c.kc != nil {
			_ = c.kc.DeleteCredential()
		}
		c.mu.Lock()
		c.credential = ""
		c.mu.Unlock()
		log.Printf("runner: credential cleared; run 'ncl runners add --name %s' to re-provision", c.cfg.RunnerName)
		os.Exit(2)

	case protocol.TypeLifecycle:
		var p protocol.LifecyclePayload
		if err := json.Unmarshal(frame.Payload, &p); err != nil {
			log.Printf("runner: decode LIFECYCLE: %v", err)
			return
		}
		c.handleLifecycle(p)

	case protocol.TypeReplayEnd:
		log.Printf("runner: replay complete")

	case protocol.TypeGapNotice:
		var p protocol.GapNoticePayload
		if err := json.Unmarshal(frame.Payload, &p); err != nil {
			log.Printf("runner: decode GAP_NOTICE: %v", err)
			return
		}
		log.Printf("runner: gap notice — dropped=%d first_available=%d", p.DroppedCount, p.FirstAvailableSeq)

	case protocol.TypeClaudeInvoke:
		var p protocol.ClaudeInvokePayload
		if err := json.Unmarshal(frame.Payload, &p); err != nil {
			log.Printf("runner: decode CLAUDE_INVOKE: %v", err)
			return
		}
		go c.handleClaudeInvoke(ctx, conn, p)

	case protocol.TypeError:
		var p protocol.ErrorPayload
		if err := json.Unmarshal(frame.Payload, &p); err != nil {
			log.Printf("runner: ERROR frame (unparseable): %v", err)
			return
		}
		log.Printf("runner: ERROR from central: code=%s message=%s fatal=%v", p.Code, p.Message, p.Fatal)

	default:
		log.Printf("runner: unknown frame type: %s", frame.Type)
	}
}

// handleLifecycle processes a LIFECYCLE frame from central.
func (c *Client) handleLifecycle(p protocol.LifecyclePayload) {
	log.Printf("runner: LIFECYCLE action=%s", p.Action)
}

// handleClaudeInvoke executes claude --print for a CLAUDE_INVOKE frame and sends CLAUDE_RESULT.
func (c *Client) handleClaudeInvoke(ctx context.Context, conn *websocket.Conn, p protocol.ClaudeInvokePayload) {
	log.Printf("runner: CLAUDE_INVOKE correlation=%s cwd=%s resume=%q",
		p.CorrelationID, p.CWD, p.ResumeSessionID)

	result := c.exec.Invoke(ctx, p.CWD, p.Prompt, p.ResumeSessionID)

	payload := protocol.ClaudeResultPayload{
		CorrelationID: p.CorrelationID,
		Stdout:        result.Stdout,
		SessionID:     result.SessionID,
		ExitCode:      result.ExitCode,
		Error:         result.Error,
	}
	if err := c.sendFrame(ctx, conn, protocol.TypeClaudeResult, payload); err != nil {
		log.Printf("runner: send CLAUDE_RESULT correlation=%s: %v", p.CorrelationID, err)
		return
	}
	log.Printf("runner: CLAUDE_RESULT sent correlation=%s exit=%d", p.CorrelationID, result.ExitCode)
}

// heartbeatLoop sends HEARTBEAT frames at the configured interval.
func (c *Client) heartbeatLoop(ctx context.Context, conn *websocket.Conn) {
	ticker := time.NewTicker(time.Duration(c.cfg.HeartbeatIntervalSec) * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			payload := protocol.HeartbeatPayload{
				RunnerVersion: c.cfg.RunnerVersion,
				SourcesActive: []string{},
				AgentsRunning: 0,
				Errors:        []protocol.RunnerError{},
				UptimeSeconds: int64(time.Since(c.startTime).Seconds()),
			}
			if err := c.sendFrame(ctx, conn, protocol.TypeHeartbeat, payload); err != nil {
				log.Printf("runner: heartbeat send error: %v", err)
				return
			}
		}
	}
}

// rotationLoop sends TOKEN_ROTATE_REQUEST every RotationInterval.
func (c *Client) rotationLoop(ctx context.Context, conn *websocket.Conn) {
	ticker := time.NewTicker(c.cfg.RotationInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			if err := c.sendFrame(ctx, conn, protocol.TypeTokenRotateRequest, struct{}{}); err != nil {
				if !errors.Is(err, context.Canceled) {
					log.Printf("runner: TOKEN_ROTATE_REQUEST send error: %v", err)
				}
				return
			}
			log.Printf("runner: credential rotation requested")
		}
	}
}

// sendFrame serializes and sends a frame with the next seq number.
func (c *Client) sendFrame(ctx context.Context, conn *websocket.Conn, msgType protocol.MessageType, payload interface{}) error {
	seq := c.seq.Add(1)
	c.mu.Lock()
	sessionID := c.sessionID
	c.mu.Unlock()

	frame := protocol.Frame{
		Type:         msgType,
		Seq:          seq,
		LastAckedSeq: c.lastCentralSeq.Load(),
		SessionID:    sessionID,
		Payload:      payload,
	}
	return wsjson.Write(ctx, conn, frame)
}

// readFrame reads one frame from the WebSocket.
func (c *Client) readFrame(ctx context.Context, conn *websocket.Conn) (*protocol.RawFrame, error) {
	var frame protocol.RawFrame
	if err := wsjson.Read(ctx, conn, &frame); err != nil {
		return nil, err
	}
	return &frame, nil
}
