#!/bin/bash
set -euo pipefail

# SolClaw Complete Setup Script
# Runs all setup steps in order

echo "🦀 SolClaw Setup"
echo ""
echo "This will configure:"
echo "  • Container runtime"
echo "  • WhatsApp authentication"
echo "  • Solana wallet (MANDATORY)"
echo "  • Background service"
echo ""

# Steps to run
steps=(
  "environment"
  "container"
  "whatsapp-auth"
  "groups"
  "register"
  "mounts"
  "solana"
  "service"
  "verify"
)

# Run each step
for step in "${steps[@]}"; do
  echo ""
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo "Step: $step"
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo ""

  npx tsx setup/index.ts --step "$step"

  if [ $? -ne 0 ]; then
    echo ""
    echo "❌ Setup failed at step: $step"
    echo ""
    echo "To retry this step:"
    echo "  npx tsx setup/index.ts --step $step"
    echo ""
    exit 1
  fi

  echo ""
  echo "✅ Step $step complete"
done

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "✅ Setup Complete!"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "Next steps:"
echo "  1. Build:  npm run build"
echo "  2. Test:   npm run test:solana"
echo "  3. Start:  npm start"
echo ""
