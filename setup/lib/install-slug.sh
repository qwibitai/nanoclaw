# install-slug.sh — shell mirror of setup/lib/install-slug.ts.
#
# Source this file after $PROJECT_ROOT is set:
#
#   source "$PROJECT_ROOT/setup/lib/install-slug.sh"
#   label=$(launchd_label)        # com.nanoclaw-v2-<slug>
#   unit=$(systemd_unit)          # nanoclaw-v2-<slug>
#   image=$(container_image_base) # nanoclaw-agent-v2-<slug>
#
# Slug is sha1(PROJECT_ROOT)[:8] — must match the TS helper exactly so both
# halves of setup name things consistently.

_nanoclaw_install_slug() {
  local root="${NANOCLAW_PROJECT_ROOT:-${PROJECT_ROOT:-$PWD}}"
  if command -v shasum >/dev/null 2>&1; then
    printf '%s' "$root" | shasum | cut -c 1-8
  elif command -v sha1sum >/dev/null 2>&1; then
    printf '%s' "$root" | sha1sum | cut -c 1-8
  else
    # Fallback: hash the path with something deterministic-ish. Not ideal —
    # but shasum is present on every modern macOS/Linux, so this is just
    # belt-and-braces against a truly minimal system.
    printf '%s' "$root" | od -An -tx1 | tr -d ' \n' | cut -c 1-8
  fi
}

launchd_label() {
  printf 'com.nanoclaw-v2-%s' "$(_nanoclaw_install_slug)"
}

systemd_unit() {
  printf 'nanoclaw-v2-%s' "$(_nanoclaw_install_slug)"
}

container_image_base() {
  printf 'nanoclaw-agent-v2-%s' "$(_nanoclaw_install_slug)"
}
