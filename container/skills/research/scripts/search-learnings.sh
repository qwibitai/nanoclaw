#!/usr/bin/env bash
# search-learnings.sh - Search local docs/solutions/ for past learnings
#
# Usage:
#   search-learnings.sh [options] <query>
#
# Options:
#   -d, --dir <path>     Directory to search (default: ./docs/solutions)
#   -c, --category <cat> Filter by category
#   -t, --tag <tag>      Filter by tag
#   -l, --limit <n>      Max results (default: 10)
#   -f, --format <fmt>   Output format: full|summary|json (default: summary)
#   -h, --help           Show help
#
# Examples:
#   search-learnings.sh "tokio runtime"
#   search-learnings.sh -c build-errors "async panic"
#   search-learnings.sh -t rust -t async "block_on"

set -euo pipefail

# Defaults
SEARCH_DIR="./docs/solutions"
CATEGORY=""
TAGS=()
LIMIT=10
FORMAT="summary"
QUERY=""

# Colors (if terminal supports it)
if [[ -t 1 ]]; then
    BOLD='\033[1m'
    GREEN='\033[0;32m'
    YELLOW='\033[0;33m'
    CYAN='\033[0;36m'
    RESET='\033[0m'
else
    BOLD=''
    GREEN=''
    YELLOW=''
    CYAN=''
    RESET=''
fi

usage() {
    cat <<EOF
Usage: search-learnings.sh [options] <query>

Search local docs/solutions/ for past learnings.

Options:
  -d, --dir <path>     Directory to search (default: ./docs/solutions)
  -c, --category <cat> Filter by category (e.g., build-errors, performance-issues)
  -t, --tag <tag>      Filter by tag (can be used multiple times)
  -l, --limit <n>      Max results (default: 10)
  -f, --format <fmt>   Output format: full|summary|json (default: summary)
  -h, --help           Show help

Examples:
  search-learnings.sh "tokio runtime"
  search-learnings.sh -c build-errors "async panic"
  search-learnings.sh -t rust -t async "block_on"

Categories:
  build-errors, performance-issues, security-fixes, testing-patterns,
  debugging-sessions, architecture-decisions, api-integrations,
  dependency-issues, deployment-fixes, database-migrations,
  ui-patterns, tooling-setup
EOF
}

# Parse arguments
while [[ $# -gt 0 ]]; do
    case $1 in
        -d|--dir)
            SEARCH_DIR="$2"
            shift 2
            ;;
        -c|--category)
            CATEGORY="$2"
            shift 2
            ;;
        -t|--tag)
            TAGS+=("$2")
            shift 2
            ;;
        -l|--limit)
            LIMIT="$2"
            shift 2
            ;;
        -f|--format)
            FORMAT="$2"
            shift 2
            ;;
        -h|--help)
            usage
            exit 0
            ;;
        -*)
            echo "Unknown option: $1" >&2
            usage
            exit 1
            ;;
        *)
            QUERY="$1"
            shift
            ;;
    esac
done

if [[ -z "$QUERY" ]]; then
    echo "Error: Query is required" >&2
    usage
    exit 1
fi

if [[ ! -d "$SEARCH_DIR" ]]; then
    echo "Warning: Directory not found: $SEARCH_DIR" >&2
    echo "No local learnings available." >&2
    exit 0
fi

# Build search path
if [[ -n "$CATEGORY" ]]; then
    SEARCH_PATH="$SEARCH_DIR/$CATEGORY"
    if [[ ! -d "$SEARCH_PATH" ]]; then
        echo "Warning: Category not found: $CATEGORY" >&2
        exit 0
    fi
else
    SEARCH_PATH="$SEARCH_DIR"
fi

# Extract YAML frontmatter from a file
extract_frontmatter() {
    local file="$1"
    # Extract content between first --- and second ---
    awk '/^---$/{p=!p; if(p) next; else exit} p' "$file"
}

# Get specific YAML field
get_yaml_field() {
    local file="$1"
    local field="$2"
    extract_frontmatter "$file" | grep "^${field}:" 2>/dev/null | sed "s/^${field}:[[:space:]]*//" || echo ""
}

# Get YAML array field (returns one item per line)
# Handles both [a, b, c] inline format and multi-line format
get_yaml_array() {
    local file="$1"
    local field="$2"
    local value

    # First try to get inline array format: field: [a, b, c]
    value=$(extract_frontmatter "$file" | grep "^${field}:" | sed "s/^${field}:[[:space:]]*//" || echo "")

    if [[ "$value" =~ ^\[.*\]$ ]]; then
        # Inline array format - extract and split
        echo "$value" | tr -d '[]"' | tr ',' '\n' | sed 's/^[[:space:]]*//;s/[[:space:]]*$//'
    else
        # Multi-line array format
        extract_frontmatter "$file" | awk -v field="$field" '
            /^'"$field"':/ { infield=1; next }
            infield && /^  - / { gsub(/^  - /, ""); gsub(/"/, ""); print }
            infield && /^[a-z]/ { exit }
        '
    fi
}

# Check if file matches tag filter
matches_tags() {
    local file="$1"
    if [[ ${#TAGS[@]} -eq 0 ]]; then
        return 0  # No filter
    fi

    local file_tags
    file_tags=$(get_yaml_array "$file" "tags" | tr '\n' ' ')

    for tag in "${TAGS[@]}"; do
        if [[ ! "$file_tags" =~ $tag ]]; then
            return 1
        fi
    done
    return 0
}

# Search and rank results
search_files() {
    local tmpfile
    tmpfile=$(mktemp)

    # Find all markdown files and score them
    while IFS= read -r -d '' file; do
        # Skip README and schema
        [[ "$(basename "$file")" == "README.md" ]] && continue
        [[ "$(basename "$file")" == "schema.yaml" ]] && continue
        [[ "$(basename "$file")" == ".gitkeep" ]] && continue

        # Check tag filter
        if ! matches_tags "$file"; then
            continue
        fi

        # Calculate relevance score
        local score=0

        # Check title (high weight)
        local title
        title=$(get_yaml_field "$file" "title")
        if echo "$title" | grep -qi "$QUERY" 2>/dev/null; then
            score=$((score + 100))
        fi

        # Check symptoms (high weight)
        local symptoms
        symptoms=$(get_yaml_array "$file" "symptoms" | tr '\n' ' ')
        if echo "$symptoms" | grep -qi "$QUERY" 2>/dev/null; then
            score=$((score + 80))
        fi

        # Check key_insight (medium weight)
        local key_insight
        key_insight=$(get_yaml_field "$file" "key_insight")
        if echo "$key_insight" | grep -qi "$QUERY" 2>/dev/null; then
            score=$((score + 60))
        fi

        # Check tags (medium weight)
        local tags
        tags=$(get_yaml_array "$file" "tags" | tr '\n' ' ')
        if echo "$tags" | grep -qi "$QUERY" 2>/dev/null; then
            score=$((score + 40))
        fi

        # Check full content (low weight)
        if grep -qi "$QUERY" "$file" 2>/dev/null; then
            score=$((score + 20))
        fi

        # Only include if:
        # 1. Some match found
        # 2. File has proper frontmatter (has title field)
        if [[ $score -gt 0 && -n "$title" ]]; then
            echo "$score $file" >> "$tmpfile"
        fi
    done < <(find "$SEARCH_PATH" -name "*.md" -type f -print0 2>/dev/null)

    # Sort by score (descending), limit, and output file paths
    if [[ -s "$tmpfile" ]]; then
        sort -rn "$tmpfile" | head -n "$LIMIT" | awk '{print $2}'
    fi

    rm -f "$tmpfile"
}

# Output a single result
output_result() {
    local file="$1"
    local title category key_insight root_cause tags symptoms confidence

    title=$(get_yaml_field "$file" "title")
    category=$(get_yaml_field "$file" "category")
    key_insight=$(get_yaml_field "$file" "key_insight")
    root_cause=$(get_yaml_field "$file" "root_cause")
    tags=$(get_yaml_array "$file" "tags" | tr '\n' ', ' | sed 's/, $//')
    symptoms=$(get_yaml_array "$file" "symptoms" | head -1)
    confidence=$(get_yaml_field "$file" "confidence")

    case "$FORMAT" in
        full)
            echo -e "${BOLD}═══════════════════════════════════════════════════════════${RESET}"
            echo -e "${BOLD}File:${RESET} $file"
            echo -e "${BOLD}Title:${RESET} $title"
            echo -e "${BOLD}Category:${RESET} $category"
            echo -e "${BOLD}Tags:${RESET} $tags"
            echo -e "${BOLD}Confidence:${RESET} $confidence"
            echo ""
            echo -e "${YELLOW}Symptom:${RESET} $symptoms"
            echo -e "${CYAN}Root Cause:${RESET} $root_cause"
            echo ""
            echo -e "${GREEN}KEY INSIGHT:${RESET}"
            echo -e "${GREEN}$key_insight${RESET}"
            echo ""
            ;;
        summary)
            echo -e "${BOLD}• $title${RESET} [$category]"
            echo -e "  ${GREEN}Key:${RESET} $key_insight"
            echo -e "  ${CYAN}File:${RESET} $file"
            echo ""
            ;;
        json)
            cat <<EOF
{
  "file": "$file",
  "title": "$title",
  "category": "$category",
  "tags": "$tags",
  "key_insight": "$key_insight",
  "root_cause": "$root_cause",
  "confidence": "$confidence"
}
EOF
            ;;
    esac
}

# Main
main() {
    local count=0

    if [[ "$FORMAT" != "json" ]]; then
        echo -e "${BOLD}Searching learnings for:${RESET} $QUERY"
        [[ -n "$CATEGORY" ]] && echo -e "${BOLD}Category:${RESET} $CATEGORY"
        [[ ${#TAGS[@]} -gt 0 ]] && echo -e "${BOLD}Tags:${RESET} ${TAGS[*]}"
        echo ""
    fi

    while IFS= read -r file; do
        [[ -z "$file" ]] && continue
        output_result "$file"
        count=$((count + 1))
    done < <(search_files)

    if [[ $count -eq 0 ]]; then
        if [[ "$FORMAT" != "json" ]]; then
            echo "No local learnings found matching: $QUERY"
        fi
    else
        if [[ "$FORMAT" != "json" ]]; then
            echo -e "${BOLD}Found $count local learning(s)${RESET}"
        fi
    fi

    # Also search global learnings if CLI is available
    local GLOBAL_CLI="${HOME}/.claude/global-learnings/cli/learnings"
    if [[ -x "$GLOBAL_CLI" ]]; then
        if [[ "$FORMAT" != "json" ]]; then
            echo ""
            echo -e "${BOLD}Searching global learnings (GraphRAG)...${RESET}"
        fi

        # Try graph-based search first, fall back to vector-only
        local global_format="simple"
        [[ "$FORMAT" == "json" ]] && global_format="json"

        if "$GLOBAL_CLI" search "$QUERY" --mode local --format "$global_format" 2>/dev/null; then
            : # Success with graph search
        elif "$GLOBAL_CLI" search "$QUERY" --mode naive --format "$global_format" 2>/dev/null; then
            : # Fallback to vector-only search
        else
            if [[ "$FORMAT" != "json" ]]; then
                echo -e "${YELLOW}(Global search unavailable - run 'learnings reindex' to initialize)${RESET}"
            fi
        fi
    fi
}

main
