#!/bin/zsh
# Build Basecamp.app from the AppleScript launcher + icon and install it to
# ~/Applications (user-writable; Launchpad and Spotlight pick it up).
#
#   ./macos/build-app.sh
#
# Rebuild any time the launcher script or icon changes. The .app itself is a
# build product and is not committed — this script is the source of truth.
set -euo pipefail
cd "$(dirname "$0")"

APP_NAME="Basecamp"
# /Applications so the app shows up where every other app lives (Finder's
# sidebar favorite, Launchpad, Spotlight); admin-group writable, no sudo
DEST="/Applications/$APP_NAME.app"
ICON_PNG="icon-1024.png"

[ -f "$ICON_PNG" ] || { echo "missing $ICON_PNG — render macos/icon.html at 1024x1024 first"; exit 1; }

# 1. compile the stay-open applet (-s = stay open after run handler)
BUILD_DIR="$(mktemp -d)"
trap 'rm -rf "$BUILD_DIR"' EXIT
osacompile -s -o "$BUILD_DIR/$APP_NAME.app" Basecamp.applescript

# 1b. kill osacompile's baked-in icon pipeline: modern macOS resolves the
# icon via CFBundleIconName -> Assets.car (which ships the generic scroll
# applet icon) and IGNORES CFBundleIconFile while they exist. Removing both
# makes the system fall back to our icns.
rm -f "$BUILD_DIR/$APP_NAME.app/Contents/Resources/Assets.car"
/usr/libexec/PlistBuddy -c "Delete :CFBundleIconName" "$BUILD_DIR/$APP_NAME.app/Contents/Info.plist" 2>/dev/null || true

# 2. icns from the 1024 master (iconutil wants the full size ladder)
ICONSET="$BUILD_DIR/icon.iconset"
mkdir "$ICONSET"
for size in 16 32 128 256 512; do
  sips -z $size $size "$ICON_PNG" --out "$ICONSET/icon_${size}x${size}.png" >/dev/null
  retina=$((size * 2))
  sips -z $retina $retina "$ICON_PNG" --out "$ICONSET/icon_${size}x${size}@2x.png" >/dev/null
done
iconutil -c icns "$ICONSET" -o "$BUILD_DIR/$APP_NAME.app/Contents/Resources/applet.icns"

# 3. identity in the bundle plist (osacompile leaves generic applet values)
PLIST="$BUILD_DIR/$APP_NAME.app/Contents/Info.plist"
/usr/libexec/PlistBuddy -c "Set :CFBundleName $APP_NAME" "$PLIST"
/usr/libexec/PlistBuddy -c "Add :NSAppleEventsUsageDescription string Basecamp starts and stops its dashboard server in an iTerm window." "$PLIST" 2>/dev/null || true
/usr/libexec/PlistBuddy -c "Add :CFBundleDisplayName string $APP_NAME" "$PLIST" 2>/dev/null \
  || /usr/libexec/PlistBuddy -c "Set :CFBundleDisplayName $APP_NAME" "$PLIST"
/usr/libexec/PlistBuddy -c "Add :CFBundleIdentifier string com.scalefreegan.basecamp" "$PLIST" 2>/dev/null \
  || /usr/libexec/PlistBuddy -c "Set :CFBundleIdentifier com.scalefreegan.basecamp" "$PLIST"

# 3b. helper app: "Basecamp Server.app" — a faceless bundle whose executable
# is a shell script that keeps the dev server as its child. Empirically the
# only helper shape whose Documents access survives on this machine (a
# compiled-applet variant of the same bundle id was silently denied).
HELPER="Basecamp Server"
HELPER_APP="$BUILD_DIR/$APP_NAME.app/Contents/Helpers/$HELPER.app"
mkdir -p "$HELPER_APP/Contents/MacOS" "$HELPER_APP/Contents/Resources"
cp server-runner.sh "$HELPER_APP/Contents/MacOS/BasecampServer"
chmod +x "$HELPER_APP/Contents/MacOS/BasecampServer"
cp "$BUILD_DIR/$APP_NAME.app/Contents/Resources/applet.icns" "$HELPER_APP/Contents/Resources/helper.icns"
cat > "$HELPER_APP/Contents/Info.plist" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleName</key><string>$HELPER</string>
  <key>CFBundleDisplayName</key><string>$HELPER</string>
  <key>CFBundleIdentifier</key><string>com.scalefreegan.basecamp.server</string>
  <key>CFBundleExecutable</key><string>BasecampServer</string>
  <key>CFBundleIconFile</key><string>helper</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>LSUIElement</key><true/>
</dict></plist>
PLIST_EOF

# 4. install (replace wholesale — a half-old bundle confuses LaunchServices)
# Re-sign AFTER every modification: swapping the icns and editing the plist
# breaks osacompile's seal, and Finder shows a broken-seal bundle with the
# generic icon instead of its own.
codesign --force --deep --sign - "$BUILD_DIR/$APP_NAME.app"

# clean up every previous install location, including the old ~/Applications
# era and the briefly flat-installed helper
rm -rf "$DEST" "$HOME/Applications/$APP_NAME.app" "$HOME/Applications/$HELPER.app"
cp -R "$BUILD_DIR/$APP_NAME.app" "$DEST"
# refresh the LaunchServices registration so the icon updates immediately
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f "$DEST" 2>/dev/null || true
touch "$DEST"
# the Dock caches app icons aggressively; restart it (instant) so the fresh
# icon shows without a logout
killall Dock 2>/dev/null || true

echo "installed $DEST"
echo "launch:  open -a $APP_NAME     quit: right-click the Dock icon → Quit (stops the server)"
