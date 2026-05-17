package updater

import (
	"testing"
)

func TestIsNewer(t *testing.T) {
	cases := []struct {
		remote, current string
		want            bool
	}{
		{"0.2.0", "0.1.0", true},
		{"0.1.0", "0.1.0", false},
		{"0.1.0", "0.2.0", false},
		{"1.0.0", "0.9.9", true},
		{"0.1.1", "0.1.0", true},
		{"0.1.0", "0.1.1", false},
		{"2.0.0", "1.99.99", true},
		{"0.0.0", "0.0.0", false},
	}
	for _, c := range cases {
		got := isNewer(c.remote, c.current)
		if got != c.want {
			t.Errorf("isNewer(%q, %q) = %v, want %v", c.remote, c.current, got, c.want)
		}
	}
}

func TestParseSemver(t *testing.T) {
	cases := []struct {
		input         string
		major, minor, patch int
	}{
		{"0.1.0", 0, 1, 0},
		{"1.2.3", 1, 2, 3},
		{"0.1.0-SNAPSHOT-abc123", 0, 1, 0},
		{"2.0.0-beta.1", 2, 0, 0},
		{"invalid", 0, 0, 0},
		{"", 0, 0, 0},
	}
	for _, c := range cases {
		sv := parseSemver(c.input)
		if sv.major != c.major || sv.minor != c.minor || sv.patch != c.patch {
			t.Errorf("parseSemver(%q) = %+v, want {%d %d %d}", c.input, sv, c.major, c.minor, c.patch)
		}
	}
}

func TestParseChecksums(t *testing.T) {
	data := []byte(
		"abc123  nanoclaw-runner_0.2.0_linux_amd64.tar.gz\n" +
			"def456  nanoclaw-runner_0.2.0_darwin_arm64.tar.gz\n" +
			"\n" +
			"ghi789  nanoclaw-runner_0.2.0_windows_amd64.zip\n",
	)
	m := parseChecksums(data)
	if m["nanoclaw-runner_0.2.0_linux_amd64.tar.gz"] != "abc123" {
		t.Errorf("linux amd64 checksum wrong: %q", m["nanoclaw-runner_0.2.0_linux_amd64.tar.gz"])
	}
	if m["nanoclaw-runner_0.2.0_darwin_arm64.tar.gz"] != "def456" {
		t.Errorf("darwin arm64 checksum wrong: %q", m["nanoclaw-runner_0.2.0_darwin_arm64.tar.gz"])
	}
	if m["nanoclaw-runner_0.2.0_windows_amd64.zip"] != "ghi789" {
		t.Errorf("windows amd64 checksum wrong: %q", m["nanoclaw-runner_0.2.0_windows_amd64.zip"])
	}
	if _, ok := m["nonexistent"]; ok {
		t.Error("nonexistent key should not be present")
	}
}

func TestArchiveFilename(t *testing.T) {
	name := archiveFilename("0.2.0")
	if name == "" {
		t.Fatal("archiveFilename returned empty string")
	}
	// Should contain version and not start with "v"
	if name[0] == 'v' {
		t.Errorf("archiveFilename should not start with 'v': %q", name)
	}
	// Should contain the version
	if got := name; len(got) < 10 {
		t.Errorf("archiveFilename too short: %q", got)
	}
}
