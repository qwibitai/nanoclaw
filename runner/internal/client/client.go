// Package client implements the NanoClaw runner protocol client.
// It connects to central, handles registration/heartbeat, and dispatches
// INBOUND_MESSAGE frames to registered agent handlers.
package client

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"math"
	"sync"
	"sync/atomic"
	"time"

	"nhooyr.io/websocket"
	"nhooyr.io/websocket/wsjson"

	"github.com/nanocoai/nanoclaw/runner/internal/config"
	"github.com/nanocoai/nanoclaw/runner/internal/protocol"
)

// InboundHandler is called when central sends an INBOUND_MESSAGE.
type InboundHandler func(payload protocol.InboundMessagePayload)

// Client manages the WebSocket connection to central.
type Client struct {
	cfg            *config.Config
	startTime      time.Time
	inboundHandler InboundHandler

	// seq is the monotonic counter for frames we send.
	seq atomic.Int64
	// lastCentralSeq is the last seq we received from central.
	lastCentralSeq atomic.Int64
	// sessionID is set after successful registration.
	sessionID string

	// mu protects conn and sessionID.
	mu   sync.Mutex
	conn *websocket.Conn
}

// New creates a new Client. Call Run to connect and start the event loop.
func New(cfg *config.Config, handler InboundHandler) *Client {
	return &Client{
		cfg:            cfg,
		startTime:      time.Now(),
		inboundHandler: handler,
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
			// Successful connection ended (central closed or we disconnected).
			log.Printf("runner: disconnected — reconnecting in %s", delay)
		}

		select {
		case <-ctx.Done():
			return
		case <-time.After(delay):
		}

		// Exponential backoff.
		delay = time.Duration(math.Min(float64(delay*2), float64(maxDelay)))
	}
}

// connect establishes a single WebSocket connection, registers, and runs the
// heartbeat + read loops until the connection closes.
func (c *Client) connect(ctx context.Context) error {
	conn, _, err := websocket.Dial(ctx, c.cfg.CentralURL, nil)
	if err != nil {
		return fmt.Errorf("dial: %w", err)
	}
	defer conn.Close(websocket.StatusNormalClosure, "runner disconnecting")

	c.mu.Lock()
	c.conn = conn
	c.mu.Unlock()

	log.Printf("runner: connected to %s", c.cfg.CentralURL)

	// Send RUNNER_REGISTER.
	registerPayload := protocol.RunnerRegisterPayload{
		RunnerToken:     c.cfg.RunnerToken,
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

	// Wait for RUNNER_ACK.
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

	// Start heartbeat loop.
	hbCtx, hbCancel := context.WithCancel(ctx)
	defer hbCancel()
	go c.heartbeatLoop(hbCtx, conn)

	// Main read loop.
	return c.readLoop(ctx, conn)
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
		// Acknowledge receipt.
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
	// drain_and_restart and force_restart: the process manager should restart us.
	// For v0, we just log — a production runner would gracefully drain.
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
