#!/usr/bin/env bash
set -e
IMAGE_NAME="nanoclaw-worker"
TAG="${1:-latest}"
CONTAINER_RUNTIME="${CONTAINER_RUNTIME:-container}"
cd "$(dirname "$0")"
${CONTAINER_RUNTIME} build -t "${IMAGE_NAME}:${TAG}" .
echo "Built ${IMAGE_NAME}:${TAG}"
