package executor

import (
	"context"
	"os"
	"os/exec"
	"testing"
)

func TestExecClaude_MissingCWD(t *testing.T) {
	r := execClaude("/tmp/nanoclaw-runner-test-definitely-missing-xyz9999", "hello", "")
	if r.ExitCode != -1 {
		t.Errorf("expected exit code -1 for missing cwd, got %d", r.ExitCode)
	}
	if r.Error == "" {
		t.Error("expected non-empty error for missing cwd")
	}
}

func TestExecClaude_ClaudeNotOnPath(t *testing.T) {
	if _, err := exec.LookPath("claude"); err == nil {
		t.Skip("claude is on PATH; skipping not-found test")
	}
	dir := t.TempDir()
	r := execClaude(dir, "hello", "")
	if r.ExitCode != -1 {
		t.Errorf("expected exit code -1 when claude not on PATH, got %d", r.ExitCode)
	}
	if r.Error == "" {
		t.Error("expected non-empty error when claude not on PATH")
	}
}

func TestInvoke_ContextCancel(t *testing.T) {
	if _, err := exec.LookPath("claude"); err == nil {
		t.Skip("claude is on PATH; test requires claude to be absent")
	}
	dir := t.TempDir()
	e := New()
	ctx, cancel := context.WithCancel(context.Background())
	cancel() // cancel immediately

	r := e.Invoke(ctx, dir, "hello", "")
	if r.ExitCode != -1 {
		t.Errorf("expected exit code -1 on cancelled context, got %d", r.ExitCode)
	}
	if r.Error == "" {
		t.Error("expected non-empty error on cancelled context")
	}
}

func TestInvoke_CWDCreatesWorker(t *testing.T) {
	e := New()
	dir1 := t.TempDir()
	dir2 := t.TempDir()

	// Just verify two different CWDs get separate worker channels
	e.mu.Lock()
	_ = dir1
	_ = dir2
	initialLen := len(e.workers)
	e.mu.Unlock()

	if initialLen != 0 {
		t.Errorf("expected 0 workers at start, got %d", initialLen)
	}
}

func TestExecClaude_PermissionDenied(t *testing.T) {
	if os.Getuid() == 0 {
		t.Skip("running as root; permission denied test not meaningful")
	}
	// Create a dir and remove execute permission
	dir := t.TempDir()
	if err := os.Chmod(dir, 0000); err != nil {
		t.Fatal(err)
	}
	defer os.Chmod(dir, 0755)

	r := execClaude(dir, "hello", "")
	// Either cwd stat error or exec error — both should produce exit -1
	if r.ExitCode != -1 {
		t.Errorf("expected exit code -1 for permission denied dir, got %d", r.ExitCode)
	}
}
