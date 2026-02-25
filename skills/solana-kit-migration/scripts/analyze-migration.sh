#!/bin/bash

# Solana Kit Migration Analyzer
# Analyzes a codebase to determine migration complexity from @solana/web3.js to @solana/kit

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Default to current directory if no path provided
PROJECT_PATH="${1:-.}"

echo -e "${BLUE}========================================${NC}"
echo -e "${BLUE}  Solana Kit Migration Analyzer${NC}"
echo -e "${BLUE}========================================${NC}"
echo ""
echo -e "Analyzing: ${GREEN}$PROJECT_PATH${NC}"
echo ""

# Check if directory exists
if [ ! -d "$PROJECT_PATH" ]; then
    echo -e "${RED}Error: Directory not found: $PROJECT_PATH${NC}"
    exit 1
fi

# Check for package.json
if [ ! -f "$PROJECT_PATH/package.json" ]; then
    echo -e "${YELLOW}Warning: No package.json found. Limited analysis available.${NC}"
fi

echo -e "${BLUE}--- SDK Detection ---${NC}"
echo ""

# Detect current SDK usage
V1_INSTALLED=false
KIT_INSTALLED=false
ANCHOR_INSTALLED=false

if [ -f "$PROJECT_PATH/package.json" ]; then
    if grep -q '"@solana/web3.js"' "$PROJECT_PATH/package.json" 2>/dev/null; then
        V1_VERSION=$(grep -o '"@solana/web3.js"[[:space:]]*:[[:space:]]*"[^"]*"' "$PROJECT_PATH/package.json" | cut -d'"' -f4)
        echo -e "${GREEN}✓${NC} @solana/web3.js detected: $V1_VERSION"
        V1_INSTALLED=true
    fi

    if grep -q '"@solana/kit"' "$PROJECT_PATH/package.json" 2>/dev/null; then
        KIT_VERSION=$(grep -o '"@solana/kit"[[:space:]]*:[[:space:]]*"[^"]*"' "$PROJECT_PATH/package.json" | cut -d'"' -f4)
        echo -e "${GREEN}✓${NC} @solana/kit detected: $KIT_VERSION"
        KIT_INSTALLED=true
    fi

    if grep -qE '"@coral-xyz/anchor"|"@project-serum/anchor"' "$PROJECT_PATH/package.json" 2>/dev/null; then
        echo -e "${YELLOW}⚠${NC} Anchor detected - Kit migration NOT recommended until Anchor supports Kit"
        ANCHOR_INSTALLED=true
    fi

    if grep -q '"@solana/compat"' "$PROJECT_PATH/package.json" 2>/dev/null; then
        echo -e "${GREEN}✓${NC} @solana/compat detected - hybrid approach in use"
    fi
fi

if [ "$V1_INSTALLED" = false ] && [ "$KIT_INSTALLED" = false ]; then
    echo -e "${YELLOW}No Solana SDK detected in package.json${NC}"
fi

echo ""
echo -e "${BLUE}--- Pattern Analysis ---${NC}"
echo ""

# Count migration patterns
count_pattern() {
    local pattern="$1"
    local label="$2"
    local count=0

    if command -v rg &> /dev/null; then
        count=$(rg -c "$pattern" --type ts --type js "$PROJECT_PATH" 2>/dev/null | awk -F: '{sum+=$2} END {print sum+0}')
    else
        count=$(grep -r "$pattern" --include="*.ts" --include="*.js" --include="*.tsx" --include="*.jsx" "$PROJECT_PATH" 2>/dev/null | wc -l | tr -d ' ')
    fi

    echo "$count"
}

# v1 Patterns to migrate
echo "Patterns requiring migration (v1 → Kit):"
echo ""

CONNECTION_COUNT=$(count_pattern "new Connection\(" "Connection instances")
echo -e "  new Connection(...)           : ${YELLOW}$CONNECTION_COUNT${NC}"

KEYPAIR_COUNT=$(count_pattern "Keypair\.(generate|fromSecretKey|fromSeed)" "Keypair usage")
echo -e "  Keypair.generate/fromSecret   : ${YELLOW}$KEYPAIR_COUNT${NC}"

PUBKEY_COUNT=$(count_pattern "new PublicKey\(" "PublicKey instances")
echo -e "  new PublicKey(...)            : ${YELLOW}$PUBKEY_COUNT${NC}"

TX_COUNT=$(count_pattern "new Transaction\(" "Transaction instances")
echo -e "  new Transaction(...)          : ${YELLOW}$TX_COUNT${NC}"

VERSIONED_TX_COUNT=$(count_pattern "new VersionedTransaction\(" "VersionedTransaction")
echo -e "  new VersionedTransaction(...) : ${YELLOW}$VERSIONED_TX_COUNT${NC}"

SYSTEM_PROGRAM_COUNT=$(count_pattern "SystemProgram\." "SystemProgram usage")
echo -e "  SystemProgram.*               : ${YELLOW}$SYSTEM_PROGRAM_COUNT${NC}"

SPL_TOKEN_COUNT=$(count_pattern "@solana/spl-token" "SPL Token imports")
echo -e "  @solana/spl-token imports     : ${YELLOW}$SPL_TOKEN_COUNT${NC}"

SUBSCRIPTION_COUNT=$(count_pattern "connection\.on(AccountChange|ProgramAccountChange|Signature)" "Subscriptions")
echo -e "  Subscription listeners        : ${YELLOW}$SUBSCRIPTION_COUNT${NC}"

# Calculate total
TOTAL=$((CONNECTION_COUNT + KEYPAIR_COUNT + PUBKEY_COUNT + TX_COUNT + VERSIONED_TX_COUNT + SYSTEM_PROGRAM_COUNT + SPL_TOKEN_COUNT + SUBSCRIPTION_COUNT))

echo ""
echo -e "${BLUE}--- Summary ---${NC}"
echo ""
echo -e "Total migration points: ${YELLOW}$TOTAL${NC}"
echo ""

# Recommendations
echo -e "${BLUE}--- Recommendations ---${NC}"
echo ""

if [ "$ANCHOR_INSTALLED" = true ]; then
    echo -e "${RED}⛔ WAIT: Anchor does not support @solana/kit yet.${NC}"
    echo "   Options:"
    echo "   1. Wait for Anchor Kit support"
    echo "   2. Use Codama to generate Kit-compatible clients"
    echo "   3. Keep non-Anchor code on v1"
    echo ""
elif [ $TOTAL -eq 0 ]; then
    echo -e "${GREEN}✓ No migration needed or already using Kit!${NC}"
elif [ $TOTAL -lt 50 ]; then
    echo -e "${GREEN}✓ LOW complexity - Full migration recommended${NC}"
    echo "   Estimated: Small refactoring effort"
elif [ $TOTAL -lt 200 ]; then
    echo -e "${YELLOW}⚠ MEDIUM complexity - Consider gradual migration${NC}"
    echo "   Recommended: Use @solana/compat for interoperability"
    echo "   Migrate module by module"
else
    echo -e "${RED}⚠ HIGH complexity - Evaluate migration ROI${NC}"
    echo "   Consider:"
    echo "   1. Is bundle size/performance critical?"
    echo "   2. Hybrid approach with @solana/compat"
    echo "   3. Migrate only hot paths"
fi

echo ""
echo -e "${BLUE}--- Blocking Dependencies ---${NC}"
echo ""

# Check for other blocking dependencies
if [ -f "$PROJECT_PATH/package.json" ]; then
    BLOCKERS=0

    if grep -q '"@metaplex-foundation/js"' "$PROJECT_PATH/package.json" 2>/dev/null; then
        echo -e "${YELLOW}⚠${NC} @metaplex-foundation/js - Check migration status"
        BLOCKERS=$((BLOCKERS + 1))
    fi

    if grep -q '"@raydium-io"' "$PROJECT_PATH/package.json" 2>/dev/null; then
        echo -e "${YELLOW}⚠${NC} Raydium SDK - May not support Kit yet"
        BLOCKERS=$((BLOCKERS + 1))
    fi

    if grep -q '"@jup-ag"' "$PROJECT_PATH/package.json" 2>/dev/null; then
        echo -e "${YELLOW}⚠${NC} Jupiter SDK - Check latest version for Kit support"
        BLOCKERS=$((BLOCKERS + 1))
    fi

    if [ $BLOCKERS -eq 0 ]; then
        echo -e "${GREEN}✓ No known blocking dependencies found${NC}"
    fi
fi

echo ""
echo -e "${BLUE}--- Files to Review ---${NC}"
echo ""

# Find files with most migration points
echo "Top files with v1 patterns:"
if command -v rg &> /dev/null; then
    rg -c "(new Connection|new PublicKey|new Transaction|Keypair\.)" --type ts --type js "$PROJECT_PATH" 2>/dev/null | sort -t: -k2 -nr | head -10
else
    grep -rc "new Connection\|new PublicKey\|new Transaction\|Keypair\." --include="*.ts" --include="*.js" "$PROJECT_PATH" 2>/dev/null | sort -t: -k2 -nr | head -10
fi

echo ""
echo -e "${BLUE}========================================${NC}"
echo -e "${BLUE}  Analysis Complete${NC}"
echo -e "${BLUE}========================================${NC}"
echo ""
echo "For detailed migration guidance, see:"
echo "  - resources/api-mappings.md"
echo "  - resources/compatibility-matrix.md"
echo "  - docs/edge-cases.md"
