#!/bin/zsh
# Build ~/Applications/TermWeave.app (native window for http://127.0.0.1:7317/).
set -euo pipefail
here=${0:A:h}
app="${1:-$HOME/Applications/TermWeave.app}"
icon="$HOME/Applications/Chromium Apps.localized/herdr web ui.app/Contents/Resources/app.icns"

rm -rf "$app"
mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources"
swiftc -O -o "$app/Contents/MacOS/TermWeave" "$here/main.swift"
[[ -f "$icon" ]] && cp "$icon" "$app/Contents/Resources/app.icns"
cat > "$app/Contents/Info.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
 <key>CFBundleName</key><string>TermWeave</string>
 <key>CFBundleDisplayName</key><string>TermWeave</string>
 <key>CFBundleIdentifier</key><string>kr.voidlight.termweave</string>
 <key>CFBundleExecutable</key><string>TermWeave</string>
 <key>CFBundleIconFile</key><string>app.icns</string>
 <key>CFBundlePackageType</key><string>APPL</string>
 <key>CFBundleShortVersionString</key><string>1.0</string>
 <key>LSMinimumSystemVersion</key><string>13.0</string>
 <key>NSHighResolutionCapable</key><true/>
 <key>NSAppTransportSecurity</key><dict><key>NSAllowsLocalNetworking</key><true/></dict>
</dict></plist>
EOF
codesign --force --sign - "$app"
echo "built $app"
