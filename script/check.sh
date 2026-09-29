#!/bin/zsh
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"

node --check "$ROOT_DIR/service-worker.js"
node --check "$ROOT_DIR/options.js"
node -e 'JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"))' "$ROOT_DIR/manifest.json"
zsh -n "$ROOT_DIR/native-host/install-native-host.sh"
node --test "$ROOT_DIR"/tests/*.test.js
swift build --package-path "$ROOT_DIR/native-host"
