#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."
if [[ -e apps/mobile/ios ]]; then
  echo "Run the native smoke build from a checkout without a generated apps/mobile/ios directory." >&2
  exit 1
fi

export CI=true EXPO_NO_TELEMETRY=1 EXPO_PUBLIC_KINLILO_LOCATION_HARNESS=0
build_dir=$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/kinlilo-ios.XXXXXX")

pnpm --filter @kinlilo/mobile exec expo prebuild --platform ios --no-install
(cd apps/mobile/ios && pod install)
xcodebuild -quiet \
  -workspace apps/mobile/ios/Kinlilo.xcworkspace \
  -scheme Kinlilo \
  -configuration Release \
  -destination 'generic/platform=iOS Simulator' \
  -derivedDataPath "$build_dir" \
  "ARCHS=$(uname -m)" ONLY_ACTIVE_ARCH=YES CODE_SIGNING_ALLOWED=NO COMPILER_INDEX_STORE_ENABLE=NO \
  build

app="$build_dir/Build/Products/Release-iphonesimulator/Kinlilo.app"
test -s "$app/main.jsbundle"
grep -q -- '-DSQLITE_HAS_CODEC=1' 'apps/mobile/ios/Pods/Local Podspecs/ExpoSQLite.podspec.json'
/usr/libexec/PlistBuddy -c 'Print :UIBackgroundModes' "$app/Info.plist" |
  grep -Eq '^[[:space:]]+location$'
echo "Kinlilo iOS Simulator release build, JavaScript bundle, and location configuration verified."
