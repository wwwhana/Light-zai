#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
OUT_DIR="${ROOT_DIR}/dist"
APP="light-zai-go"
HOST_BIN="${ROOT_DIR}/light-zai"

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
build darwin amd64 "" darwin-amd64
build darwin arm64 "" darwin-arm64

# Keep ./light-zai aligned with the current host build to avoid running stale binaries.
host_goos="$(go env GOOS)"
host_goarch="$(go env GOARCH)"
host_goarm="$(go env GOARM)"
host_suffix=""
case "${host_goos}/${host_goarch}" in
  linux/amd64) host_suffix="linux-amd64" ;;
  linux/arm64) host_suffix="linux-arm64" ;;
  linux/arm)
    if [[ "${host_goarm}" == "7" ]]; then
      host_suffix="linux-armv7"
    fi
    ;;
  darwin/amd64) host_suffix="darwin-amd64" ;;
  darwin/arm64) host_suffix="darwin-arm64" ;;
esac

if [[ -n "${host_suffix}" && -f "${OUT_DIR}/${APP}-${host_suffix}" ]]; then
  cp "${OUT_DIR}/${APP}-${host_suffix}" "${HOST_BIN}"
  chmod +x "${HOST_BIN}"
  echo "[host] synced ${HOST_BIN} <- ${APP}-${host_suffix}"
else
  echo "[host] skipped host sync for ${host_goos}/${host_goarch}${host_goarm:+/v${host_goarm}}"
fi

ls -lh "$OUT_DIR"
