// Package updater polls GitHub releases and self-updates the runner binary.
package updater

import (
	"archive/tar"
	"archive/zip"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"syscall"
	"time"
)

const (
	releaseAPI = "https://api.github.com/repos/distillery-labs/nanoclaw/releases/latest"
	releaseURL = "https://github.com/distillery-labs/nanoclaw/releases/download"
)

// Updater polls for new releases and replaces the running binary when one is found.
type Updater struct {
	currentVersion string
	interval       time.Duration
	etag           string
	client         *http.Client
}

// New creates an Updater. currentVersion should be the value baked in via ldflags (e.g. "0.1.0").
func New(currentVersion string, interval time.Duration) *Updater {
	return &Updater{
		currentVersion: currentVersion,
		interval:       interval,
		client:         &http.Client{Timeout: 30 * time.Second},
	}
}

// Run starts the poll loop. It blocks until ctx is cancelled.
func (u *Updater) Run(ctx context.Context) {
	ticker := time.NewTicker(u.interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			u.poll(ctx)
		}
	}
}

// poll checks for a newer release and applies it if found.
func (u *Updater) poll(ctx context.Context) {
	log.Printf("updater: polling for updates (current: v%s)", u.currentVersion)

	tag, err := u.latestTag(ctx)
	if err != nil {
		log.Printf("updater: poll failed: %v", err)
		return
	}
	if tag == "" {
		// 304 Not Modified
		log.Printf("updater: no update (not modified)")
		return
	}

	remote := strings.TrimPrefix(tag, "v")
	if !isNewer(remote, u.currentVersion) {
		log.Printf("updater: no update (latest=%s current=%s)", tag, u.currentVersion)
		return
	}

	log.Printf("updater: update found — latest=%s current=v%s", tag, u.currentVersion)
	if err := u.apply(ctx, tag); err != nil {
		log.Printf("updater: update failed: %v", err)
	}
}

// latestTag returns the tag_name of the latest release, or "" on 304.
func (u *Updater) latestTag(ctx context.Context) (string, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, releaseAPI, nil)
	if err != nil {
		return "", err
	}
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("X-GitHub-Api-Version", "2022-11-28")
	if u.etag != "" {
		req.Header.Set("If-None-Match", u.etag)
	}

	resp, err := u.client.Do(req)
	if err != nil {
		return "", fmt.Errorf("http get: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode == http.StatusNotModified {
		return "", nil
	}
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("unexpected status %d", resp.StatusCode)
	}

	if etag := resp.Header.Get("ETag"); etag != "" {
		u.etag = etag
	}

	var payload struct {
		TagName string `json:"tag_name"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&payload); err != nil {
		return "", fmt.Errorf("decode: %w", err)
	}
	return payload.TagName, nil
}

// apply downloads, verifies, and installs the release identified by tag.
func (u *Updater) apply(ctx context.Context, tag string) error {
	version := strings.TrimPrefix(tag, "v")
	archiveName := archiveFilename(version)
	archiveURL := fmt.Sprintf("%s/%s/%s", releaseURL, tag, archiveName)
	checksumURL := fmt.Sprintf("%s/%s/checksums.txt", releaseURL, tag)

	log.Printf("updater: downloading %s", archiveName)

	// Download archive to temp file.
	tmpArchive, err := os.CreateTemp("", "nanoclaw-runner-update-*")
	if err != nil {
		return fmt.Errorf("create temp archive: %w", err)
	}
	defer os.Remove(tmpArchive.Name())

	if err := downloadTo(ctx, u.client, archiveURL, tmpArchive); err != nil {
		tmpArchive.Close()
		return fmt.Errorf("download archive: %w", err)
	}
	tmpArchive.Close()

	log.Printf("updater: verifying checksum")

	// Download and parse checksums.
	checksumData, err := downloadBytes(ctx, u.client, checksumURL)
	if err != nil {
		return fmt.Errorf("download checksums: %w", err)
	}
	expected, ok := parseChecksums(checksumData)[archiveName]
	if !ok {
		return fmt.Errorf("checksum not found for %s", archiveName)
	}
	got, err := sha256File(tmpArchive.Name())
	if err != nil {
		return fmt.Errorf("sha256 archive: %w", err)
	}
	if got != expected {
		return fmt.Errorf("checksum mismatch: got %s want %s", got, expected)
	}

	log.Printf("updater: checksum OK — extracting binary")

	// Extract binary to a temp file in the same dir as the current executable.
	exePath, err := resolvedExe()
	if err != nil {
		return fmt.Errorf("resolve exe path: %w", err)
	}
	tmpBin := exePath + ".new"

	if err := extractBinary(tmpArchive.Name(), tmpBin); err != nil {
		os.Remove(tmpBin)
		return fmt.Errorf("extract: %w", err)
	}

	// macOS: strip quarantine xattr (best-effort).
	if runtime.GOOS == "darwin" {
		exec.Command("xattr", "-d", "com.apple.quarantine", tmpBin).Run() //nolint:errcheck
	}

	log.Printf("updater: swapping binary %s → %s", tmpBin, exePath)

	if err := os.Rename(tmpBin, exePath); err != nil {
		os.Remove(tmpBin)
		if os.IsPermission(err) {
			return fmt.Errorf("permission denied replacing %s — try running as root or granting write access", exePath)
		}
		return fmt.Errorf("rename: %w", err)
	}

	log.Printf("updater: update to %s complete — re-execing", tag)
	return reexec()
}

// reexec replaces the current process image with the (now updated) binary.
func reexec() error {
	exe, err := resolvedExe()
	if err != nil {
		return fmt.Errorf("resolve exe for re-exec: %w", err)
	}
	return syscall.Exec(exe, os.Args, os.Environ())
}

// resolvedExe returns the absolute path to the running binary with symlinks resolved.
func resolvedExe() (string, error) {
	exe, err := os.Executable()
	if err != nil {
		return "", err
	}
	return filepath.EvalSymlinks(exe)
}

// archiveFilename builds the release archive filename for the current platform.
func archiveFilename(version string) string {
	ext := ".tar.gz"
	if runtime.GOOS == "windows" {
		ext = ".zip"
	}
	return fmt.Sprintf("nanoclaw-runner_%s_%s_%s%s", version, runtime.GOOS, runtime.GOARCH, ext)
}

// extractBinary extracts the runner binary from a tar.gz or zip archive into dst.
func extractBinary(archivePath, dst string) error {
	if strings.HasSuffix(archivePath, ".zip") || runtime.GOOS == "windows" {
		return extractZip(archivePath, dst)
	}
	return extractTarGz(archivePath, dst)
}

func extractTarGz(archivePath, dst string) error {
	f, err := os.Open(archivePath)
	if err != nil {
		return err
	}
	defer f.Close()

	gz, err := gzip.NewReader(f)
	if err != nil {
		return err
	}
	defer gz.Close()

	tr := tar.NewReader(gz)
	for {
		hdr, err := tr.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			return err
		}
		if hdr.Name == "nanoclaw-runner" || filepath.Base(hdr.Name) == "nanoclaw-runner" {
			return writeFile(tr, dst, 0755)
		}
	}
	return fmt.Errorf("nanoclaw-runner not found in archive")
}

func extractZip(archivePath, dst string) error {
	zr, err := zip.OpenReader(archivePath)
	if err != nil {
		return err
	}
	defer zr.Close()

	for _, f := range zr.File {
		name := filepath.Base(f.Name)
		if name == "nanoclaw-runner" || name == "nanoclaw-runner.exe" {
			rc, err := f.Open()
			if err != nil {
				return err
			}
			err = writeFile(rc, dst, 0755)
			rc.Close()
			return err
		}
	}
	return fmt.Errorf("nanoclaw-runner not found in zip")
}

func writeFile(r io.Reader, dst string, mode os.FileMode) error {
	f, err := os.OpenFile(dst, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, mode)
	if err != nil {
		if os.IsPermission(err) {
			return fmt.Errorf("permission denied writing to %s", dst)
		}
		return err
	}
	_, err = io.Copy(f, r)
	cerr := f.Close()
	if err != nil {
		return err
	}
	return cerr
}

// downloadTo streams a GET response body into w.
func downloadTo(ctx context.Context, client *http.Client, url string, w io.Writer) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return err
	}
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("http %d", resp.StatusCode)
	}
	_, err = io.Copy(w, resp.Body)
	return err
}

// downloadBytes fetches a URL and returns the response body.
func downloadBytes(ctx context.Context, client *http.Client, url string) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("http %d", resp.StatusCode)
	}
	return io.ReadAll(resp.Body)
}

// sha256File returns the lowercase hex SHA-256 of the file at path.
func sha256File(path string) (string, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer f.Close()
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return "", err
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

// parseChecksums parses a goreleaser checksums.txt file into filename→hash map.
func parseChecksums(data []byte) map[string]string {
	m := make(map[string]string)
	for _, line := range strings.Split(string(data), "\n") {
		fields := strings.Fields(line)
		if len(fields) == 2 {
			m[fields[1]] = fields[0]
		}
	}
	return m
}

// isNewer reports whether remote semver is strictly greater than current.
func isNewer(remote, current string) bool {
	r := parseSemver(remote)
	c := parseSemver(current)
	if r.major != c.major {
		return r.major > c.major
	}
	if r.minor != c.minor {
		return r.minor > c.minor
	}
	return r.patch > c.patch
}

type semver struct{ major, minor, patch int }

func parseSemver(s string) semver {
	// Strip pre-release/build suffix (e.g. "0.1.0-SNAPSHOT-abc" → "0.1.0")
	s = strings.SplitN(s, "-", 2)[0]
	parts := strings.SplitN(s, ".", 3)
	if len(parts) != 3 {
		return semver{}
	}
	return semver{
		major: atoi(parts[0]),
		minor: atoi(parts[1]),
		patch: atoi(parts[2]),
	}
}

func atoi(s string) int {
	v, _ := strconv.Atoi(s)
	return v
}
