#!/usr/bin/env bash
# Promote staged skills/rules directly to a tile's GitHub repo.
# GHA handles skill review (85%), lint, and tessl publish.
#
# Usage:
#   promote-to-tile-repo.sh <staging-dir> <tile-name> [skill-name|all|--rules-only]
#
# Environment: GITHUB_TOKEN, TILE_OWNER (defaults to "jbaruch")
#
# Runs in both contexts:
#   - Inside orchestrator container (called by IPC handler)
#   - On host Mac (called by promote-from-host.sh wrapper)

set -euo pipefail

# Load nvm if available (NAS has tessl via nvm-managed npm)
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
if [ -s "$NVM_DIR/nvm.sh" ]; then
  . "$NVM_DIR/nvm.sh"
fi

STAGING_DIR="${1:?staging directory required}"
TILE_NAME="${2:?tile name required}"
MODE="${3:-all}"

TILE_OWNER="${TILE_OWNER:-jbaruch}"
TOKEN="${GITHUB_TOKEN:?GITHUB_TOKEN required}"
ASSISTANT_NAME="${ASSISTANT_NAME:-Agent}"

SKILLS_SRC="$STAGING_DIR/skills"
RULES_SRC="$STAGING_DIR/rules"

# Cross-tile duplicate check: look at registry-installed tiles
TESSL_TILES_DIR="${TESSL_TILES_DIR:-}"

# Read a single frontmatter field from a SKILL.md. Returns the normalised
# value on stdout (or empty if unset or no frontmatter block). Frontmatter
# is the block between the first two `---` markers at the top of the file.
#
# Robust against common YAML-ish variants:
# - `field: true`   (space after colon)
# - `field:true`    (no space after colon)
# - `field: true  ` (trailing whitespace)
# - `field: true # comment` (inline comment stripped)
# - `field: "true"` / `field: 'true'` (surrounding quotes stripped)
#
# Silent-fail would be dangerous here — an author who writes `skip-optimize:true`
# thinking the flag is set and then sees their skill still being auto-trimmed
# has no way to diagnose the mismatch. Normalise defensively.
read_frontmatter_field() {
  local file="$1"
  local field="$2"
  # Match is buffered and only emitted if we saw both opening AND closing
  # `---` markers. Without the closing check, a malformed SKILL.md that
  # opens with `---` but never closes it would let body-level `field:`
  # occurrences be parsed as frontmatter — which would let an attacker
  # smuggle `placement-admin-content-ok: true` into the body and bypass
  # validation.
  awk -v f="$field" '
    NR == 1 && $0 != "---" { exit }
    NR == 1 { in_fm = 1; next }
    in_fm && $0 == "---" { closed = 1; exit }
    in_fm && !found {
      prefix_re = "^[[:space:]]*" f "[[:space:]]*:"
      if ($0 !~ prefix_re) next
      line = $0
      sub(prefix_re, "", line)
      sub("^[[:space:]]+", "", line)   # strip leading ws after colon
      # Value begins with `#` after trimming — the entire line after the
      # colon is a comment, so the field has no value.
      if (substr(line, 1, 1) == "#") { matched = ""; found = 1; next }
      # Quoted values must be parsed BEFORE stripping `#` comments, because
      # in YAML `#` inside quotes is literal, not a comment.
      if (length(line) >= 2) {
        first = substr(line, 1, 1)
        if (first == "\"" || first == "\047") {
          # Find the rightmost matching quote (naive — does not handle
          # escaped quotes, but frontmatter boolean flags never need that).
          rest = substr(line, 2)
          for (i = length(rest); i >= 1; i--) {
            if (substr(rest, i, 1) == first) {
              matched = substr(rest, 1, i - 1)
              found = 1
              next
            }
          }
          # No closing quote — fall through to unquoted handling.
        }
      }
      # Unquoted value: strip `#` comments (must be preceded by whitespace,
      # per YAML), then strip trailing whitespace.
      sub("[[:space:]]+#.*$", "", line)
      sub("[[:space:]]+$", "", line)
      matched = line
      found = 1
    }
    END {
      if (closed && found) print matched
    }
  ' "$file"
}

# --- Tile placement validation ---
validate_placement() {
  local skill_file="$1"
  local tile="$2"
  local canonical="$3"

  if [ "$tile" = "nanoclaw-admin" ]; then return 0; fi

  # Explicit opt-in bypass for skills that legitimately document admin-level
  # names as reference content (e.g. scrub-list entries in `ship-code`).
  # Scope: this flag ONLY skips the admin-content regex checks — tile-
  # specific structural rules (like nanoclaw-core's trusted-workspace
  # reference block) still apply. The admin-content regex can't distinguish
  # "uses these handlers" from "warns you to scrub these handlers"; the
  # flag is the author's assertion that the mentions are intentional
  # reference material. Auditable — `grep -r 'placement-admin-content-ok: true' tiles/`
  # lists every skill that opts out.
  local skip_admin_regex=false
  if [ "$(read_frontmatter_field "$skill_file" 'placement-admin-content-ok')" = "true" ]; then
    echo "  placement check: admin-content regex bypassed by frontmatter flag for $canonical"
    skip_admin_regex=true
  fi

  if [ "$tile" = "nanoclaw-untrusted" ]; then
    if ! $skip_admin_regex && grep -qiE 'composio|gmail|calendar|tasks|schedule_task|promote|host_script' "$skill_file" 2>/dev/null; then
      echo "BLOCKED: $canonical has admin-level content but target is $tile"
      return 1
    fi
    return 0
  fi

  if ! $skip_admin_regex && grep -qiE 'composio|gmail|googlecalendar|googletasks|promote_staging|github_backup|register_group' "$skill_file" 2>/dev/null; then
    echo "BLOCKED: $canonical has admin-level content but target is $tile"
    return 1
  fi

  # nanoclaw-core's trusted-workspace check runs regardless of the
  # admin-content bypass — these are orthogonal concerns.
  if [ "$tile" = "nanoclaw-core" ]; then
    if grep -qiE '/workspace/trusted/|trusted.memory|cross.group' "$skill_file" 2>/dev/null; then
      echo "BLOCKED: $canonical references trusted workspace but target is core"
      return 1
    fi
  fi

  return 0
}

# --- Clone tile repo ---
TILE_REPO_URL="https://x-access-token:${TOKEN}@github.com/${TILE_OWNER}/${TILE_NAME}.git"
TILE_REPO_DIR="/tmp/promote-${TILE_NAME}-$$"

echo "Cloning ${TILE_OWNER}/${TILE_NAME}..."
rm -rf "$TILE_REPO_DIR"
git clone --depth 1 "$TILE_REPO_URL" "$TILE_REPO_DIR"

PROMOTED=0
BLOCKED=0
PROMOTED_SKILLS=""

# --- Pull skills into clone ---
if [ "$MODE" != "--rules-only" ]; then
  if [ "$MODE" = "all" ]; then
    SKILLS=$(ls "$SKILLS_SRC" 2>/dev/null || true)
  else
    SKILLS="$MODE"
  fi

  for skill_dir in $SKILLS; do
    [ -z "$skill_dir" ] && continue
    src="$SKILLS_SRC/$skill_dir"
    [ -d "$src" ] || continue
    [ -f "$src/SKILL.md" ] || continue

    canonical="${skill_dir#tessl__}"

    if ! validate_placement "$src/SKILL.md" "$TILE_NAME" "$canonical"; then
      BLOCKED=$((BLOCKED + 1))
      continue
    fi

    # Cross-tile duplicate check
    if [ -n "$TESSL_TILES_DIR" ]; then
      for other_tile_dir in "$TESSL_TILES_DIR"/nanoclaw-*/; do
        other_name=$(basename "$other_tile_dir")
        [ "$other_name" = "$TILE_NAME" ] && continue
        if [ -d "$other_tile_dir/skills/$canonical" ]; then
          echo "BLOCKED: $canonical already exists in $other_name"
          BLOCKED=$((BLOCKED + 1))
          continue 2
        fi
      done
    fi

    dst="$TILE_REPO_DIR/skills/$canonical"
    mkdir -p "$dst"
    cp -r "$src/." "$dst/"
    echo "pulled: $canonical"
    PROMOTED_SKILLS="$PROMOTED_SKILLS $canonical"

    # Update tile.json (add entry if new)
    python3 -c "
import json, sys
with open('$TILE_REPO_DIR/tile.json') as f:
    tile = json.load(f)
skills = tile.setdefault('skills', {})
if '$canonical' not in skills:
    skills['$canonical'] = {'path': 'skills/$canonical/SKILL.md'}
    print('  added: $canonical')
else:
    print('  exists: $canonical')
with open('$TILE_REPO_DIR/tile.json', 'w') as f:
    json.dump(tile, f, indent=2)
    f.write('\n')
"
    PROMOTED=$((PROMOTED + 1))
  done
fi

# --- Pull rules into clone ---
if [ "$MODE" = "all" ] || [ "$MODE" = "--rules-only" ]; then
  if [ -d "$RULES_SRC" ]; then
    for rule_file in "$RULES_SRC"/*.md; do
      [ -f "$rule_file" ] || continue
      name=$(basename "$rule_file" .md)
      mkdir -p "$TILE_REPO_DIR/rules"
      cp "$rule_file" "$TILE_REPO_DIR/rules/$name.md"
      echo "pulled rule: $name"

      python3 -c "
import json
with open('$TILE_REPO_DIR/tile.json') as f:
    tile = json.load(f)
rules = tile.setdefault('rules', {})
if '$name' not in rules:
    rules['$name'] = {'rules': 'rules/$name.md'}
    print('  added: $name')
else:
    print('  exists: $name')
with open('$TILE_REPO_DIR/tile.json', 'w') as f:
    json.dump(tile, f, indent=2)
    f.write('\n')
"
      PROMOTED=$((PROMOTED + 1))
    done
  fi
fi

if [ "$BLOCKED" -gt 0 ]; then
  echo ""
  echo "WARNING: $BLOCKED item(s) blocked by tile placement validation."
fi

if [ "$PROMOTED" -eq 0 ]; then
  echo "Nothing to promote."
  rm -rf "$TILE_REPO_DIR"
  exit 0
fi

# --- Skill review + optimize (shift-left: fix before CI) ---
# Skills can opt out of the auto-optimize pass with `skip-optimize: true` in
# frontmatter — useful when the skill is intentionally verbose (concrete
# examples, step-by-step narration) and auto-trimming would lose meaning.
# The review itself still runs remotely via GHA; this flag only skips the
# local auto-apply.
if [ -n "$PROMOTED_SKILLS" ] && command -v tessl >/dev/null 2>&1; then
  for skill_name in $PROMOTED_SKILLS; do
    skill_md="$TILE_REPO_DIR/skills/$skill_name/SKILL.md"
    if [ "$(read_frontmatter_field "$skill_md" 'skip-optimize')" = "true" ]; then
      echo "skipping optimize: $skill_name (frontmatter flag)"
      continue
    fi
    echo "reviewing: $skill_name"
    tessl skill review --optimize --yes "$TILE_REPO_DIR/skills/$skill_name"
  done
elif [ -n "$PROMOTED_SKILLS" ]; then
  echo "WARN: tessl not found, skipping local skill review"
fi

# --- Commit and push ---
cd "$TILE_REPO_DIR"
git config user.email "nanoclaw@bot.local"
git config user.name "$ASSISTANT_NAME"
git add -A
if git diff --cached --quiet; then
  echo "Tile repo already up to date."
else
  git commit -m "feat: promote $PROMOTED item(s) from $ASSISTANT_NAME staging"
  git push origin main
  echo "Pushed to ${TILE_OWNER}/${TILE_NAME} — GHA will review, lint, and publish."
fi

rm -rf "$TILE_REPO_DIR"
echo "Done! $PROMOTED promoted, $BLOCKED blocked."
