#!/bin/bash
# Builds "Train Alert.app" — a menu bar app that talks to ../src/menubar-cli.js.
set -euo pipefail
cd "$(dirname "$0")"

APP_NAME="Train Alert"
BUILD_DIR="$(pwd)/build"
APP_DIR="$BUILD_DIR/$APP_NAME.app"
CONTENTS="$APP_DIR/Contents"

rm -rf "$APP_DIR"
mkdir -p "$CONTENTS/MacOS" "$CONTENTS/Resources"

echo "==> Writing build configuration"
PROJECT_DIR="$(cd .. && pwd)"
NODE_PATH="${NODE_PATH:-$(command -v node)}"
cat > "$BUILD_DIR/BuildConfig.swift" <<SWIFT
enum BuildConfig {
    static let projectDir = "$PROJECT_DIR"
    static let nodePath = "$NODE_PATH"
}
SWIFT

echo "==> Compiling Swift sources"
swiftc -swift-version 5 -O -parse-as-library \
  Sources/main.swift "$BUILD_DIR/BuildConfig.swift" \
  -o "$CONTENTS/MacOS/$APP_NAME"

echo "==> Generating icon"
ICON_PNG="$BUILD_DIR/icon-1024.png"
swift tools/make_icon.swift "$ICON_PNG"

ICONSET="$BUILD_DIR/AppIcon.iconset"
rm -rf "$ICONSET"
mkdir -p "$ICONSET"
sips -z 16 16   "$ICON_PNG" --out "$ICONSET/icon_16x16.png" >/dev/null
sips -z 32 32   "$ICON_PNG" --out "$ICONSET/icon_16x16@2x.png" >/dev/null
sips -z 32 32   "$ICON_PNG" --out "$ICONSET/icon_32x32.png" >/dev/null
sips -z 64 64   "$ICON_PNG" --out "$ICONSET/icon_32x32@2x.png" >/dev/null
sips -z 128 128 "$ICON_PNG" --out "$ICONSET/icon_128x128.png" >/dev/null
sips -z 256 256 "$ICON_PNG" --out "$ICONSET/icon_128x128@2x.png" >/dev/null
sips -z 256 256 "$ICON_PNG" --out "$ICONSET/icon_256x256.png" >/dev/null
sips -z 512 512 "$ICON_PNG" --out "$ICONSET/icon_256x256@2x.png" >/dev/null
sips -z 512 512 "$ICON_PNG" --out "$ICONSET/icon_512x512.png" >/dev/null
cp "$ICON_PNG" "$ICONSET/icon_512x512@2x.png"
iconutil -c icns "$ICONSET" -o "$CONTENTS/Resources/AppIcon.icns"

echo "==> Writing Info.plist"
cat > "$CONTENTS/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleName</key>
    <string>$APP_NAME</string>
    <key>CFBundleDisplayName</key>
    <string>$APP_NAME</string>
    <key>CFBundleIdentifier</key>
    <string>com.trainalert.menubar</string>
    <key>CFBundleExecutable</key>
    <string>$APP_NAME</string>
    <key>CFBundleIconFile</key>
    <string>AppIcon</string>
    <key>CFBundlePackageType</key>
    <string>APPL</string>
    <key>CFBundleShortVersionString</key>
    <string>1.0</string>
    <key>CFBundleVersion</key>
    <string>1</string>
    <key>LSMinimumSystemVersion</key>
    <string>13.0</string>
    <key>LSUIElement</key>
    <true/>
    <key>NSHumanReadableCopyright</key>
    <string>Personal use</string>
</dict>
</plist>
PLIST

echo "==> Ad-hoc signing"
codesign --force --deep --sign - "$APP_DIR"

echo "==> Done: $APP_DIR"
