#!/bin/bash
# Build the NanoClaw agent container image with optional skills support

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$SCRIPT_DIR"

IMAGE_NAME="nanoclaw-agent"
TAG="${1:-latest}"
DOCKERFILE="${2:-Dockerfile.skills}"

# Use original Dockerfile if --original flag is passed
if [[ "$1" == "--original" ]]; then
  DOCKERFILE="Dockerfile"
  TAG="latest"
  echo -e "${YELLOW}Using original Dockerfile (without skills system)${NC}"
fi

echo -e "${GREEN}=== NanoClaw Agent Container Builder ===${NC}"
echo "Project root: $PROJECT_ROOT"
echo "Dockerfile: $DOCKERFILE"
echo ""

# Function to validate package names (security)
validate_package_name() {
  local package="$1"
  # Allow letters, numbers, dots, hyphens, underscores, @, /
  if [[ ! "$package" =~ ^[a-zA-Z0-9._/@-]+$ ]]; then
    echo -e "${RED}ERROR: Invalid package name: $package${NC}"
    echo "Package names can only contain letters, numbers, dots, hyphens, underscores, @, and /"
    exit 1
  fi
}

# Function to check if a command exists
command_exists() {
  command -v "$1" >/dev/null 2>&1
}

# Check for jq
if ! command_exists jq; then
  echo -e "${YELLOW}WARNING: jq is not installed, using basic parsing${NC}"
  USE_JQ=false
else
  USE_JQ=true
fi

# Initialize skill flags
ENABLE_TODOIST=false
ENABLE_X_INTEGRATION=false
ENABLE_CALCULATOR=false
ENABLE_ADD_GMAIL=false
ENABLE_ADD_VOICE_TRANSCRIPTION=false

# Only detect skills if using skills Dockerfile
if [[ "$DOCKERFILE" == "Dockerfile.skills" ]]; then
  echo -e "${GREEN}Detecting enabled skills...${NC}"

  SKILLS_DIR="$PROJECT_ROOT/skills"

  if [[ ! -d "$SKILLS_DIR" ]]; then
    echo -e "${YELLOW}WARNING: Skills directory not found at $SKILLS_DIR${NC}"
    echo "Creating skills directory..."
    mkdir -p "$SKILLS_DIR"
  fi

  # Process each skill directory
  for skill_dir in "$SKILLS_DIR"/*/; do
    if [[ ! -d "$skill_dir" ]]; then
      continue
    fi

    skill_name=$(basename "$skill_dir")
    deps_file="${skill_dir}deps.json"

    if [[ -f "$deps_file" ]]; then
      if [[ "$USE_JQ" == true ]]; then
        # Use jq for proper JSON parsing
        enabled=$(jq -r '.enabled // false' "$deps_file" 2>/dev/null || echo "false")
        version=$(jq -r '.version // "unknown"' "$deps_file" 2>/dev/null || echo "unknown")

        # Validate system packages if present
        if jq -e '.dependencies.system[]?.packages[]?' "$deps_file" >/dev/null 2>&1; then
          while IFS= read -r package; do
            validate_package_name "$package"
          done < <(jq -r '.dependencies.system[].packages[]' "$deps_file")
        fi
      else
        # Fallback to grep for basic parsing
        enabled=$(grep -o '"enabled"[[:space:]]*:[[:space:]]*[^,}]*' "$deps_file" | grep -o 'true\|false' || echo "false")
        version="unknown"
      fi

      if [[ "$enabled" == "true" ]]; then
        echo -e "  ${GREEN}✓${NC} $skill_name (v$version) - enabled"

        # Set corresponding build argument
        case "$skill_name" in
          todoist)
            ENABLE_TODOIST=true
            ;;
          x-integration)
            ENABLE_X_INTEGRATION=true
            ;;
          calculator)
            ENABLE_CALCULATOR=true
            ;;
          add-gmail)
            ENABLE_ADD_GMAIL=true
            ;;
          add-voice-transcription)
            ENABLE_ADD_VOICE_TRANSCRIPTION=true
            ;;
          *)
            echo -e "    ${YELLOW}Note: $skill_name has no specific dependencies${NC}"
            ;;
        esac
      else
        echo -e "  ${RED}✗${NC} $skill_name - disabled"
      fi
    else
      echo -e "  ${YELLOW}⚠${NC} $skill_name - no deps.json found"
    fi
  done

  echo ""
  echo -e "${GREEN}Build configuration:${NC}"
  echo "  Todoist CLI:          $([ "$ENABLE_TODOIST" = true ] && echo "✓ Yes" || echo "✗ No")"
  echo "  X Integration:        $([ "$ENABLE_X_INTEGRATION" = true ] && echo "✓ Yes" || echo "✗ No")"
  echo "  Calculator:           $([ "$ENABLE_CALCULATOR" = true ] && echo "✓ Yes" || echo "✗ No")"
  echo "  Gmail:                $([ "$ENABLE_ADD_GMAIL" = true ] && echo "✓ Yes" || echo "✗ No")"
  echo "  Voice Transcription:  $([ "$ENABLE_ADD_VOICE_TRANSCRIPTION" = true ] && echo "✓ Yes" || echo "✗ No")"
fi

echo ""
echo -e "${GREEN}Building container image...${NC}"
echo "Image: ${IMAGE_NAME}:${TAG}"

# Build with conditional dependencies
if [[ "$DOCKERFILE" == "Dockerfile.skills" ]]; then
  # Build with skills system
  docker build \
    -f "$DOCKERFILE" \
    --build-arg ENABLE_TODOIST="$ENABLE_TODOIST" \
    --build-arg ENABLE_X_INTEGRATION="$ENABLE_X_INTEGRATION" \
    --build-arg ENABLE_CALCULATOR="$ENABLE_CALCULATOR" \
    --build-arg ENABLE_ADD_GMAIL="$ENABLE_ADD_GMAIL" \
    --build-arg ENABLE_ADD_VOICE_TRANSCRIPTION="$ENABLE_ADD_VOICE_TRANSCRIPTION" \
    -t "${IMAGE_NAME}:${TAG}" \
    .
else
  # Build with original Dockerfile
  docker build \
    -f "$DOCKERFILE" \
    -t "${IMAGE_NAME}:${TAG}" \
    .
fi

BUILD_STATUS=$?

if [[ $BUILD_STATUS -eq 0 ]]; then
  echo ""
  echo -e "${GREEN}=== Build completed successfully! ===${NC}"
  echo ""

  # Show image info
  IMAGE_SIZE=$(docker images --format "{{.Size}}" "${IMAGE_NAME}:${TAG}")
  echo "Image size: ${IMAGE_SIZE}"
  echo ""

  echo "Test with:"
  echo "  cd $PROJECT_ROOT"
  echo "  echo '{\"prompt\":\"What is 2+2?\",\"groupFolder\":\"test\",\"chatId\":\"test\",\"isMain\":true}' | \\"
  echo "  docker run -i \\"
  echo "    -v \"\$PWD/skills:/workspace/shared-skills:ro\" \\"
  echo "    -v \"\$PWD/groups:/workspace/groups:rw\" \\"
  echo "    -v \"\$PWD/data/env:/workspace/env-dir:ro\" \\"
  echo "    ${IMAGE_NAME}:${TAG}"
  echo ""
  echo "  Or use the test script: ./test-container.sh"
else
  echo ""
  echo -e "${RED}=== Build failed! ===${NC}"
  exit 1
fi
