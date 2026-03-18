#!/bin/bash
# Sync marketplace plugin skills into container/skills-catalog/plugins/
# Reads installed_plugins.json to find active versions, copies their skills.
# Safe to run when no plugins are installed (produces empty plugins dir).

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CATALOG_DIR="$SCRIPT_DIR/skills-catalog/plugins"
PLUGINS_DIR="${CLAUDE_PLUGINS_DIR:-$HOME/.claude/plugins}"
INSTALLED_FILE="$PLUGINS_DIR/installed_plugins.json"

# Clean previous sync
rm -rf "$CATALOG_DIR"
mkdir -p "$CATALOG_DIR"

# If no plugins installed, exit cleanly
if [ ! -f "$INSTALLED_FILE" ]; then
  echo "No installed_plugins.json found at $INSTALLED_FILE — skipping plugin sync"
  exit 0
fi

# Parse installed_plugins.json to get active install paths
# Format: { "plugins": { "name@marketplace": [{ "installPath": "..." }] } }
INSTALL_PATHS=$(node -e "
  const data = require('$INSTALLED_FILE');
  const plugins = data.plugins || {};
  for (const [key, entries] of Object.entries(plugins)) {
    if (!Array.isArray(entries) || entries.length === 0) continue;
    // Use the first entry (active install)
    const entry = entries[0];
    if (entry.installPath) {
      // Extract plugin name (before @)
      const name = key.split('@')[0];
      console.log(name + '\t' + entry.installPath);
    }
  }
")

if [ -z "$INSTALL_PATHS" ]; then
  echo "No plugins found in installed_plugins.json"
  exit 0
fi

echo "$INSTALL_PATHS" | while IFS=$'\t' read -r PLUGIN_NAME INSTALL_PATH; do
  SKILLS_DIR="$INSTALL_PATH/skills"
  if [ ! -d "$SKILLS_DIR" ]; then
    echo "  Plugin '$PLUGIN_NAME' has no skills/ directory — skipping"
    continue
  fi

  echo "  Syncing plugin: $PLUGIN_NAME from $INSTALL_PATH"
  DEST="$CATALOG_DIR/$PLUGIN_NAME"
  mkdir -p "$DEST"

  # Copy each skill directory (contains SKILL.md + optional support files)
  for SKILL_DIR in "$SKILLS_DIR"/*/; do
    [ -d "$SKILL_DIR" ] || continue
    SKILL_NAME=$(basename "$SKILL_DIR")
    cp -r "$SKILL_DIR" "$DEST/$SKILL_NAME"
    echo "    Copied skill: $SKILL_NAME"
  done
done

echo "Plugin sync complete."
