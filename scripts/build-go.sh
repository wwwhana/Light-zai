#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
OUT_DIR="${ROOT_DIR}/dist"
APP="light-zai-go"

mkdir -p "$OUT_DIR"

build() {
  local goos="$1" goarch="$2" goarm="$3" suffix="$4"
  echo "[build] ${goos}/${goarch}${goarm:+/v${goarm}} -> ${suffix}"
  if [[ -n "$goarm" ]]; then
    GOOS="$goos" GOARCH="$goarch" GOARM="$goarm" CGO_ENABLED=0 go build -trimpath -ldflags='-s -w' -o "$OUT_DIR/${APP}-${suffix}" ./cmd/light-zai
  else
    GOOS="$goos" GOARCH="$goarch" CGO_ENABLED=0 go build -trimpath -ldflags='-s -w' -o "$OUT_DIR/${APP}-${suffix}" ./cmd/light-zai
  fi
}

build linux amd64 "" linux-amd64
build linux arm 7 linux-armv7
build linux arm64 "" linux-arm64

ls -lh "$OUT_DIR"
