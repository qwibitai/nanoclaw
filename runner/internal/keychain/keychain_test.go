package keychain

import (
	"os"
	"testing"
)

func TestKeychain(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("NANOCLAW_RUNNER_CREDENTIAL_DIR", dir)

	k, err := New()
	if err != nil {
		t.Fatalf("New: %v", err)
	}

	// ErrNotFound before any write.
	if _, err := k.LoadCredential(); err != ErrNotFound {
		t.Errorf("LoadCredential before write: got %v, want ErrNotFound", err)
	}
	if _, err := k.LoadBootstrap(); err != ErrNotFound {
		t.Errorf("LoadBootstrap before write: got %v, want ErrNotFound", err)
	}

	// Save and load credential.
	const cred = "deadbeef1234"
	if err := k.SaveCredential(cred); err != nil {
		t.Fatalf("SaveCredential: %v", err)
	}
	got, err := k.LoadCredential()
	if err != nil {
		t.Fatalf("LoadCredential after save: %v", err)
	}
	if got != cred {
		t.Errorf("LoadCredential = %q, want %q", got, cred)
	}

	// File mode should be 0600.
	info, _ := os.Stat(k.dir + "/credential")
	if info != nil && (info.Mode().Perm()&0077) != 0 {
		t.Errorf("credential file mode = %o, want 0600", info.Mode().Perm())
	}

	// Delete credential.
	if err := k.DeleteCredential(); err != nil {
		t.Fatalf("DeleteCredential: %v", err)
	}
	if _, err := k.LoadCredential(); err != ErrNotFound {
		t.Errorf("after delete: got %v, want ErrNotFound", err)
	}

	// Double-delete is a no-op.
	if err := k.DeleteCredential(); err != nil {
		t.Errorf("double DeleteCredential: %v", err)
	}

	// Bootstrap token round-trip.
	const boot = "bootstrap-abc"
	if err := k.SaveBootstrap(boot); err != nil {
		t.Fatalf("SaveBootstrap: %v", err)
	}
	got, err = k.LoadBootstrap()
	if err != nil {
		t.Fatalf("LoadBootstrap: %v", err)
	}
	if got != boot {
		t.Errorf("LoadBootstrap = %q, want %q", got, boot)
	}
	if err := k.DeleteBootstrap(); err != nil {
		t.Fatalf("DeleteBootstrap: %v", err)
	}
	if _, err := k.LoadBootstrap(); err != ErrNotFound {
		t.Errorf("after DeleteBootstrap: got %v, want ErrNotFound", err)
	}
}
