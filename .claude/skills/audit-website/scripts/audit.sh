#!/usr/bin/env bash
# audit-website composite runner
#
# Usage: audit.sh <url> [--quick] [--out <dir>]
#
# Runs:
#   - lighthouse        (perf / a11y / SEO / best-practices + Core Web Vitals)
#   - axe-core CLI      (deep a11y violations)              [skipped with --quick]
#   - linkinator        (broken link scan)                  [skipped with --quick]
#   - curl + jq         (security headers, robots, sitemap)
#   - node + cheerio    (meta tag / OG / canonical / JSON-LD presence)
#
# Emits an LLM-optimized Markdown report on stdout and writes raw artifacts
# under --out (default: /tmp/audit-<host>-<epoch>).
#
# Exit codes:
#   0 — audit completed (issues may still exist; check the report)
#   2 — usage error
#   3 — lighthouse failed (treated as fatal; the rest depend on a reachable URL)

set -euo pipefail

URL=""
QUICK=0
OUT=""

while [[ $# -gt 0 ]]; do
    case "$1" in
        --quick) QUICK=1; shift ;;
        --out)   OUT="$2"; shift 2 ;;
        -h|--help)
            sed -n '2,15p' "$0"; exit 0 ;;
        *)
            if [[ -z "$URL" ]]; then URL="$1"; shift
            else echo "unknown arg: $1" >&2; exit 2
            fi ;;
    esac
done

if [[ -z "$URL" ]]; then
    echo "usage: audit.sh <url> [--quick] [--out <dir>]" >&2
    exit 2
fi

# Resolve host for the artifact directory name.
HOST="$(node -e 'try { process.stdout.write(new URL(process.argv[1]).host) } catch { process.stdout.write("invalid") }' "$URL")"
if [[ "$HOST" == "invalid" || -z "$HOST" ]]; then
    echo "invalid url: $URL" >&2
    exit 2
fi

OUT="${OUT:-/tmp/audit-${HOST}-$(date +%s)}"
mkdir -p "$OUT"

log() { printf '[audit] %s\n' "$*" >&2; }

# ---- 1. Lighthouse ---------------------------------------------------------
log "running lighthouse..."
LH_JSON="$OUT/lighthouse.json"
LH_LOG="$OUT/lighthouse.log"

# Chrome flags: headless, no sandbox (works inside Docker as non-root).
if ! lighthouse "$URL" \
        --quiet \
        --output=json \
        --output-path="$LH_JSON" \
        --chrome-flags="--headless=new --no-sandbox --disable-dev-shm-usage" \
        --only-categories=performance,accessibility,seo,best-practices \
        --max-wait-for-load=45000 \
        > "$LH_LOG" 2>&1; then
    echo "lighthouse failed — see $LH_LOG" >&2
    sed -n '1,40p' "$LH_LOG" >&2
    exit 3
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
AXE_JSON="$OUT/axe.json"
LINK_JSON="$OUT/linkinator.json"
HEADERS_TXT="$OUT/headers.txt"
ROBOTS_TXT="$OUT/robots.txt"
SITEMAP_XML="$OUT/sitemap.xml"
META_JSON="$OUT/meta.json"
ROBOTS_STATUS_FILE="$OUT/.robots-status"
SITEMAP_STATUS_FILE="$OUT/.sitemap-status"

# ---- 2-5. Run remaining tools in parallel ----------------------------------
# All inputs are the same URL — no inter-tool dependencies. Lighthouse
# already finished (it's the hard gate); the rest fan out.
log "running axe, linkinator, header/robots/sitemap fetches, meta parse in parallel..."

# axe-core (skipped with --quick). Non-zero exit means "violations found" — data, not error.
if (( QUICK == 0 )); then
    (axe "$URL" \
        --stdout \
        --chromium-path /usr/bin/chromium \
        --chrome-options="no-sandbox,disable-dev-shm-usage,headless=new" \
        > "$AXE_JSON" 2>"$OUT/axe.log" || true) &
    AXE_PID=$!
else
    echo '[]' > "$AXE_JSON"
    AXE_PID=""
fi

# linkinator (skipped with --quick). --recurse stays inside the origin.
if (( QUICK == 0 )); then
    (linkinator "$URL" \
        --recurse \
        --silent \
        --format JSON \
        --timeout 15000 \
        > "$LINK_JSON" 2>"$OUT/linkinator.log" || true) &
    LINK_PID=$!
else
    echo '{"links":[],"passed":true,"skipped":true}' > "$LINK_JSON"
    LINK_PID=""
fi

# curl fetches (headers + robots + sitemap)
(curl -sIL --max-time 15 "$URL" -o "$HEADERS_TXT" || true) &
HEADERS_PID=$!
(curl -sL --max-time 10 -o "$ROBOTS_TXT" -w '%{http_code}' "${URL%/}/robots.txt" > "$ROBOTS_STATUS_FILE" 2>/dev/null || echo 000 > "$ROBOTS_STATUS_FILE") &
ROBOTS_PID=$!
(curl -sL --max-time 10 -o "$SITEMAP_XML" -w '%{http_code}' "${URL%/}/sitemap.xml" > "$SITEMAP_STATUS_FILE" 2>/dev/null || echo 000 > "$SITEMAP_STATUS_FILE") &
SITEMAP_PID=$!

# Meta / OG / canonical / JSON-LD via regex parse (node, no DOM dep)
(node "$SCRIPT_DIR/meta-check.mjs" "$URL" > "$META_JSON" 2>"$OUT/meta.log" || echo '{"error":"meta check failed"}' > "$META_JSON") &
META_PID=$!

# Wait for all background jobs
for pid in $AXE_PID $LINK_PID $HEADERS_PID $ROBOTS_PID $SITEMAP_PID $META_PID; do
    wait "$pid" || true
done

# axe / linkinator empty-output fallbacks
[[ ! -s "$AXE_JSON" ]] && echo '[]' > "$AXE_JSON"
[[ ! -s "$LINK_JSON" ]] && echo '{"links":[],"passed":true}' > "$LINK_JSON"

ROBOTS_STATUS="$(cat "$ROBOTS_STATUS_FILE" 2>/dev/null || echo 000)"
SITEMAP_STATUS="$(cat "$SITEMAP_STATUS_FILE" 2>/dev/null || echo 000)"

# ---- 6. Aggregate into Markdown -------------------------------------------
log "aggregating..."
node "$SCRIPT_DIR/aggregate.mjs" \
    --url "$URL" \
    --lighthouse "$LH_JSON" \
    --axe "$AXE_JSON" \
    --linkinator "$LINK_JSON" \
    --headers "$HEADERS_TXT" \
    --robots-status "$ROBOTS_STATUS" \
    --sitemap-status "$SITEMAP_STATUS" \
    --meta "$META_JSON" \
    $([[ $QUICK -eq 1 ]] && echo "--quick")

log "raw artifacts: $OUT"
