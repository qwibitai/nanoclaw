// Package keychain stores runner credentials in a 0600-mode plaintext file.
//
// Threat model:
//   - Untrusted users on the same host: covered by 0600 file permissions.
//   - Compromised user account: credential exposed (same as any secret owned by that user).
//   - Lost device: mitigated by server-side revocation — ncl runners revoke kills the credential
//     regardless of local state, and the 24 h rotation window bounds blast radius.
//
// OS-keychain storage (macOS Keychain / libsecret) is a future enhancement tracked separately;
// it is blocked on enabling CGO for the release targets.
package keychain

import (
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
)

const (
	dirMode  = 0700
	fileMode = 0600
	dirName  = "nanoclaw-runner"
)

// ErrNotFound is returned when no credential or bootstrap token is stored.
var ErrNotFound = errors.New("keychain: not found")

// Keychain manages credential and bootstrap token storage.
type Keychain struct {
	dir string
}

// New creates a Keychain rooted at the platform credential directory.
// Override with NANOCLAW_RUNNER_CREDENTIAL_DIR for Docker volume mounts.
func New() (*Keychain, error) {
	dir, err := credDir()
	if err != nil {
		return nil, err
	}
	if err := os.MkdirAll(dir, dirMode); err != nil {
		return nil, err
	}
	return &Keychain{dir: dir}, nil
}

func credDir() (string, error) {
	if override := os.Getenv("NANOCLAW_RUNNER_CREDENTIAL_DIR"); override != "" {
		return override, nil
	}
	switch runtime.GOOS {
	case "windows":
		appdata := os.Getenv("APPDATA")
		if appdata == "" {
			return "", errors.New("keychain: APPDATA not set")
		}
		return filepath.Join(appdata, dirName), nil
	case "darwin":
		home, err := os.UserHomeDir()
		if err != nil {
			return "", err
		}
		return filepath.Join(home, "Library", "Application Support", dirName), nil
	default:
		// Linux / BSD: respect XDG_CONFIG_HOME
		if xdg := os.Getenv("XDG_CONFIG_HOME"); xdg != "" {
			return filepath.Join(xdg, dirName), nil
		}
		home, err := os.UserHomeDir()
		if err != nil {
			return "", err
		}
		return filepath.Join(home, ".config", dirName), nil
	}
}

func (k *Keychain) read(name string) (string, error) {
	data, err := os.ReadFile(filepath.Join(k.dir, name))
	if os.IsNotExist(err) {
		return "", ErrNotFound
	}
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(string(data)), nil
}

func (k *Keychain) write(name, value string) error {
	path := filepath.Join(k.dir, name)
	return os.WriteFile(path, []byte(value+"\n"), fileMode)
}

func (k *Keychain) delete(name string) error {
	err := os.Remove(filepath.Join(k.dir, name))
	if os.IsNotExist(err) {
		return nil
	}
	return err
}

// LoadCredential returns the stored long-lived credential, or ErrNotFound.
func (k *Keychain) LoadCredential() (string, error) {
	return k.read("credential")
}

// SaveCredential persists the long-lived credential (mode 0600).
func (k *Keychain) SaveCredential(token string) error {
	return k.write("credential", token)
}

// DeleteCredential removes the stored credential. Safe to call when absent.
func (k *Keychain) DeleteCredential() error {
	return k.delete("credential")
}

// LoadBootstrap returns the stored bootstrap token, or ErrNotFound.
func (k *Keychain) LoadBootstrap() (string, error) {
	return k.read("bootstrap")
}

// SaveBootstrap persists a bootstrap token (mode 0600).
func (k *Keychain) SaveBootstrap(token string) error {
	return k.write("bootstrap", token)
}

// DeleteBootstrap removes the stored bootstrap token. Safe to call when absent.
func (k *Keychain) DeleteBootstrap() error {
	return k.delete("bootstrap")
}
