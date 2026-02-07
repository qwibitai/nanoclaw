#!/bin/bash
# Development mode helper script
# Allows testing skills without rebuilding the container

set -e

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

MODE="${1:-run}"

case "$MODE" in
  build)
    echo -e "${GREEN}Building development container...${NC}"
    ./build.sh dev Dockerfile.skills
    ;;

  run)
    echo -e "${GREEN}Starting development container with live skills mount...${NC}"
    docker compose -f docker-compose.dev.yml up
    ;;

  test)
    SKILL="${2:-calculator}"
    echo -e "${GREEN}Testing skill: $SKILL${NC}"

    TEST_PROMPT="Test the $SKILL skill"
    TEST_JSON=$(cat <<EOF
{
  "prompt": "$TEST_PROMPT",
  "groupFolder": "test-dev",
  "chatId": "dev@test.com",
  "isMain": true
}
EOF
)

    echo "$TEST_JSON" | docker compose -f docker-compose.dev.yml run --rm agent-dev
    ;;

  shell)
    echo -e "${GREEN}Opening shell in development container...${NC}"
    docker compose -f docker-compose.dev.yml run --rm agent-dev /bin/bash
    ;;

  validate)
    echo -e "${GREEN}Validating skills configuration...${NC}"
    docker compose -f docker-compose.dev.yml run --rm agent-dev node /app/validate-skills.js
    ;;

  stop)
    echo -e "${YELLOW}Stopping development container...${NC}"
    docker compose -f docker-compose.dev.yml down
    ;;

  logs)
    docker compose -f docker-compose.dev.yml logs -f
    ;;

  *)
    echo -e "${RED}Unknown mode: $MODE${NC}"
    echo ""
    echo "Usage: ./dev.sh [mode] [options]"
    echo ""
    echo "Modes:"
    echo "  build    - Build development container"
    echo "  run      - Run development container with live skills mount"
    echo "  test     - Test a specific skill"
    echo "  shell    - Open shell in container"
    echo "  validate - Validate skills configuration"
    echo "  stop     - Stop development container"
    echo "  logs     - Show container logs"
    echo ""
    echo "Examples:"
    echo "  ./dev.sh build           # Build dev container"
    echo "  ./dev.sh run             # Start with live skills"
    echo "  ./dev.sh test calculator # Test calculator skill"
    echo "  ./dev.sh shell           # Debug in container"
    exit 1
    ;;
esac