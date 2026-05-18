// Package executor runs claude --print invocations, serializing calls per working directory.
// Calls for different CWDs execute concurrently; calls for the same CWD are serialized
// (one at a time, FIFO) to avoid interleaved claude sessions on shared state.
package executor

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"sync"
)

// Result holds the outcome of a claude --print invocation.
type Result struct {
	Stdout    string
	SessionID string
	ExitCode  int
	Error     string // non-empty on exec or validation error; ExitCode is -1 in those cases
}

type request struct {
	prompt          string
	resumeSessionID string
	done            chan Result
}

// Executor serializes claude invocations per working directory.
type Executor struct {
	mu      sync.Mutex
	workers map[string]chan request
}

// New creates a new Executor.
func New() *Executor {
	return &Executor{workers: make(map[string]chan request)}
}

// Invoke runs claude --print in cwd with the given prompt.
// If resumeSessionID is non-empty, --resume <id> is passed.
// Blocks until the invocation completes or ctx is cancelled.
func (e *Executor) Invoke(ctx context.Context, cwd, prompt, resumeSessionID string) Result {
	e.mu.Lock()
	ch, ok := e.workers[cwd]
	if !ok {
		ch = make(chan request, 16)
		e.workers[cwd] = ch
		go runWorker(cwd, ch)
	}
	e.mu.Unlock()

	done := make(chan Result, 1)
	select {
	case ch <- request{prompt: prompt, resumeSessionID: resumeSessionID, done: done}:
	case <-ctx.Done():
		return Result{Error: "context cancelled before dispatch", ExitCode: -1}
	}

	select {
	case r := <-done:
		return r
	case <-ctx.Done():
		return Result{Error: "context cancelled while waiting for claude result", ExitCode: -1}
	}
}

func runWorker(cwd string, ch chan request) {
	for req := range ch {
		req.done <- execClaude(cwd, req.prompt, req.resumeSessionID)
	}
}

// claudeJSONOutput is the JSON structure produced by claude --output-format json.
type claudeJSONOutput struct {
	Type      string `json:"type"`
	Result    string `json:"result"`
	SessionID string `json:"session_id"`
}

func execClaude(cwd, prompt, resumeSessionID string) Result {
	if _, err := os.Stat(cwd); os.IsNotExist(err) {
		return Result{Error: fmt.Sprintf("cwd does not exist: %s", cwd), ExitCode: -1}
	}

	claudePath, err := exec.LookPath("claude")
	if err != nil {
		return Result{
			Error:    "claude is not on PATH; install the Claude CLI on this runner host",
			ExitCode: -1,
		}
	}

	args := []string{"--print", "-p", prompt, "--output-format", "json"}
	if resumeSessionID != "" {
		args = append(args, "--resume", resumeSessionID)
	}

	cmd := exec.Command(claudePath, args...)
	cmd.Dir = cwd

	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr

	runErr := cmd.Run()
	exitCode := 0
	if runErr != nil {
		if exitErr, ok := runErr.(*exec.ExitError); ok {
			exitCode = exitErr.ExitCode()
		} else {
			return Result{Error: fmt.Sprintf("exec error: %v", runErr), ExitCode: -1}
		}
	}

	rawOut := stdout.String()
	var out claudeJSONOutput
	if jsonErr := json.Unmarshal([]byte(rawOut), &out); jsonErr != nil {
		return Result{Stdout: rawOut, ExitCode: exitCode}
	}

	return Result{
		Stdout:    out.Result,
		SessionID: out.SessionID,
		ExitCode:  exitCode,
	}
}
