#!/bin/zsh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
USER_HOME="${HOME:?HOME is not set}"
PRODUCT_NAME="web-pair-switcher-global-hotkey"
INSTALL_DIR="$USER_HOME/Library/Application Support/WebPairSwitcher"
HOST_DIR="$USER_HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"
BUILD_DIR="$USER_HOME/Library/Caches/WebPairSwitcher/SwiftBuild"
HOST_NAME="com.aaronfang.web_pair_switcher"

echo "Building macOS global hotkey helper..."
mkdir -p "$BUILD_DIR"
swift build --package-path "$SCRIPT_DIR" --scratch-path "$BUILD_DIR" -c release
BIN_DIR="$(swift build --package-path "$SCRIPT_DIR" --scratch-path "$BUILD_DIR" -c release --show-bin-path)"

mkdir -p "$INSTALL_DIR" "$HOST_DIR"
cp "$BIN_DIR/$PRODUCT_NAME" "$INSTALL_DIR/$PRODUCT_NAME"
chmod 755 "$INSTALL_DIR/$PRODUCT_NAME"
# Swift's linker signature can be rejected after the executable is copied to
# Application Support on newer macOS releases. Re-sign the installed file so
# taskgated validates the bytes at their final path.
codesign --force --sign - "$INSTALL_DIR/$PRODUCT_NAME"

HOST_PATH="$INSTALL_DIR/$PRODUCT_NAME"
HOST_PATH_JSON="$(printf '%s' "$HOST_PATH" | sed 's/\\/\\\\/g; s/"/\\"/g')"
printf '{\n  "name": "%s",\n  "description": "Global hotkey bridge for the page switcher",\n  "path": "%s",\n  "type": "stdio",\n  "allowed_origins": ["chrome-extension://fganjnbgeilndeipfihllihcepimeejn/"]\n}\n' \
  "$HOST_NAME" "$HOST_PATH_JSON" > "$HOST_DIR/$HOST_NAME.json"

python3 -m json.tool "$HOST_DIR/$HOST_NAME.json" >/dev/null
test -x "$HOST_PATH"
echo "Installed: $HOST_DIR/$HOST_NAME.json"
echo "Native host installation verified. Reload the extension from chrome://extensions."
