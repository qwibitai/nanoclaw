#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [ -f "$HOME/export-esp.sh" ]; then
  # Provides LIBCLANG_PATH + xtensa toolchain PATH from espup.
  # shellcheck source=/dev/null
  source "$HOME/export-esp.sh"
fi

export ESP_IDF_VERSION=${ESP_IDF_VERSION:-release/v5.1}
export RUSTFLAGS="${RUSTFLAGS:-} --cfg espidf_time64"
export CARGO_BUILD_TARGET=${CARGO_BUILD_TARGET:-xtensa-esp32s3-espidf}
export CARGO_UNSTABLE_BUILD_STD=${CARGO_UNSTABLE_BUILD_STD:-std,panic_abort}

cd "$ROOT"
cargo +esp check -p microclaw-device --features esp
