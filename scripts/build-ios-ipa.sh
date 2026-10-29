#!/usr/bin/env bash
# Build an unsigned DEVICE IPA. No Apple account, provisioning or remote server.
set -euo pipefail
if [[ "$(uname -s)" != Darwin ]]; then
  printf '%s\n' 'This build requires macOS and Xcode 26. Other operating systems can inspect the source but cannot compile an iOS IPA.' >&2
  exit 1
fi
case "${1:-}" in
  '') smoke=0 ;;
  --smoke) smoke=1 ;;
  *) printf '%s\n' 'Usage: scripts/build-ios-ipa.sh [--smoke]' >&2; exit 2 ;;
esac
task_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
# Bundle the entire current web application before invoking Xcode.
(cd "$task_root" && node --test src/tooling/stageIosWeb.test.mjs && npm run build && node scripts/stage-ios-web.mjs)
output_root="$task_root/output/ios"
mkdir -p "$output_root"
build_root="$(mktemp -d "$output_root/build.XXXXXX")"
simulator_id=''
cleanup() {
  if [[ "$simulator_id" =~ ^[A-Fa-f0-9-]{36}$ ]]; then
    xcrun simctl shutdown "$simulator_id" >/dev/null 2>&1 || true
    xcrun simctl delete "$simulator_id" >/dev/null 2>&1 || true
  fi
  case "$build_root" in
    "$output_root"/build.*) rm -rf -- "$build_root" ;;
    *) printf '%s\n' 'Refusing cleanup outside the created build directory.' >&2 ;;
  esac
}
trap cleanup EXIT

toolchain="$(xcodebuild -version)"
if ! printf '%s\n' "$toolchain" | grep -Eq '^Xcode 26\.'; then
  printf '%s\n' 'Select an installed stable Xcode 26 using DEVELOPER_DIR before building.' >&2
  exit 1
fi
printf '%s\n' "$toolchain"
xcrun --sdk iphoneos --show-sdk-version
build_number="${GITHUB_RUN_NUMBER:-1}"
[[ "$build_number" =~ ^[0-9]+$ ]] || { printf '%s\n' 'Build number must be numeric.' >&2; exit 1; }
project="$task_root/ios/GEVTAK.xcodeproj"
bundle_id='uk.rebeltechoxford.gevtak'

# Pure Foundation policy tests compile without UIKit, packages or Node.
xcrun swiftc -parse-as-library -swift-version 5 \
  "$task_root/ios/GEVTAK/EndpointOrigin.swift" \
  "$task_root/ios/Tests/EndpointOriginTests.swift" \
  -o "$build_root/endpoint-policy-tests"
"$build_root/endpoint-policy-tests"
xcrun swiftc -parse-as-library -swift-version 5 \
  "$task_root/ios/GEVTAK/BundledAppServer.swift" \
  "$task_root/ios/Tests/BundledAppServerTests.swift" \
  -o "$build_root/bundled-server-tests"
"$build_root/bundled-server-tests"

xcodebuild -quiet -project "$project" -scheme GEVTAK -configuration Release \
  -sdk iphoneos -destination 'generic/platform=iOS' \
  -derivedDataPath "$build_root/DerivedData-device" \
  -archivePath "$build_root/GEVTAK.xcarchive" \
  CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO CODE_SIGN_IDENTITY='' \
  DEVELOPMENT_TEAM='' CURRENT_PROJECT_VERSION="$build_number" archive

app="$build_root/GEVTAK.xcarchive/Products/Applications/GEVTAK.app"
[[ -d "$app" && -f "$app/Info.plist" && -f "$app/GEVTAK" ]]
[[ ! -e "$app/embedded.mobileprovision" && ! -d "$app/_CodeSignature" ]]
architectures="$(xcrun lipo -archs "$app/GEVTAK")"
[[ "$architectures" == arm64 ]] || { printf '%s\n' 'Device archive is not arm64-only.' >&2; exit 1; }
xcrun vtool -show-build "$app/GEVTAK" > "$build_root/device-build.txt"
grep -Eq 'platform IOS$' "$build_root/device-build.txt"
python3 - "$app/Info.plist" "$bundle_id" <<'PY'
import plistlib, sys
with open(sys.argv[1], 'rb') as handle:
    info = plistlib.load(handle)
assert info['CFBundleIdentifier'] == sys.argv[2]
assert info['CFBundleExecutable'] == 'GEVTAK'
assert info['CFBundleSupportedPlatforms'] == ['iPhoneOS']
assert info.get('NSAppTransportSecurity') == {'NSAllowsLocalNetworking': True}, 'Only local networking may use HTTP; remote TLS remains verified'
for key in ['NSLocationWhenInUseUsageDescription', 'NSMicrophoneUsageDescription', 'NSCameraUsageDescription']:
    assert info.get(key), key
assert not info.get('UIBackgroundModes'), 'No background capability is claimed'
print('PASS: unsigned device archive, bundle identity, permissions and strict ATS')
PY

mkdir "$build_root/Payload"
/usr/bin/ditto "$app" "$build_root/Payload/GEVTAK.app"
ipa="$build_root/GEVTAK-unsigned.ipa"
/usr/bin/ditto -c -k --norsrc --keepParent "$build_root/Payload" "$ipa"
python3 - "$ipa" <<'PY'
import hashlib, json, plistlib, sys, zipfile
with zipfile.ZipFile(sys.argv[1]) as archive:
    names = archive.namelist()
    assert names and all(name.startswith('Payload/GEVTAK.app/') or name == 'Payload/' or name == 'Payload/GEVTAK.app/' for name in names)
    assert 'Payload/GEVTAK.app/GEVTAK' in names
    info = plistlib.loads(archive.read('Payload/GEVTAK.app/Info.plist'))
    assert info['CFBundleSupportedPlatforms'] == ['iPhoneOS']
    assert not any(name.endswith(('embedded.mobileprovision', '.pem', '.p12', '.pfx', '.key', '.env')) for name in names)
    assert not any('/../' in name or name.startswith('/') for name in names)
    manifest = json.loads(archive.read('Payload/GEVTAK.app/WebApp/bundle-manifest.json'))
    assert any(f['path'] == 'index.html' for f in manifest['files'])
    paths = [entry['path'] for entry in manifest['files']]
    assert len(paths) == len(set(paths)), 'Duplicate bundle manifest entries'
    assert all(not p.startswith('/') and '..' not in p.split('/') for p in paths)
    bundle_prefix = 'Payload/GEVTAK.app/WebApp/'
    actual = {name[len(bundle_prefix):] for name in names if name.startswith(bundle_prefix) and not name.endswith('/')}
    assert actual == set(paths) | {'bundle-manifest.json'}, 'Bundled files differ from the manifest'
    for entry in manifest['files']:
        assert hashlib.sha256(archive.read('Payload/GEVTAK.app/WebApp/' + entry['path'])).hexdigest() == entry['sha256']
    assert archive.testzip() is None
print('PASS: Payload IPA structure, device platform and archive integrity')
PY

if [[ "$smoke" == 1 ]]; then
  xcodebuild -quiet -project "$project" -scheme GEVTAK -configuration Debug \
    -sdk iphonesimulator -destination 'generic/platform=iOS Simulator' \
    -derivedDataPath "$build_root/DerivedData-simulator" \
    CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO CODE_SIGN_IDENTITY='' \
    DEVELOPMENT_TEAM='' CURRENT_PROJECT_VERSION="$build_number" build
  xcrun simctl list runtimes --json > "$build_root/runtimes.json"
  xcrun simctl list devicetypes --json > "$build_root/devicetypes.json"
  simulator_sdk="$(xcrun --sdk iphonesimulator --show-sdk-version)"
  read -r runtime_id device_type < <(python3 - "$build_root" "$simulator_sdk" <<'PY'
import json, pathlib, sys
root = pathlib.Path(sys.argv[1])
sdk_major = int(sys.argv[2].split('.')[0])
runtimes = [r for r in json.loads((root/'runtimes.json').read_text())['runtimes'] if r.get('isAvailable') and '.iOS-' in r['identifier'] and int(r['version'].split('.')[0]) == sdk_major]
assert runtimes, f'No available iOS runtime matches selected SDK major {sdk_major}'
runtime = max(runtimes, key=lambda r: tuple(map(int, r['version'].split('.'))))
phones = [d for d in json.loads((root/'devicetypes.json').read_text())['devicetypes'] if d['name'].startswith('iPhone')]
device = next((d for d in phones if d['name'] == 'iPhone 17'), phones[-1])
print(runtime['identifier'], device['identifier'])
PY
  )
  printf 'Selected simulator: %s / %s; SDK %s\n' "$runtime_id" "$device_type" "$simulator_sdk"
  simulator_id="$(xcrun simctl create 'GEV TAK build smoke' "$device_type" "$runtime_id")"
  [[ "$simulator_id" =~ ^[A-Fa-f0-9-]{36}$ ]]
  xcrun simctl boot "$simulator_id"
  developer_root="${DEVELOPER_DIR:-$(xcode-select -p)}"
  open -a "$developer_root/Applications/Simulator.app" --args -CurrentDeviceUDID "$simulator_id"
  python3 - "$simulator_id" "$build_root" <<'PY'
import pathlib, subprocess, sys
log = pathlib.Path(sys.argv[2])/'simulator-boot.log'
try:
    with log.open('w') as output:
        # A pristine runner can spend several minutes in CoreLocation migration.
        # This remains a real terminal-boot requirement, never a skipped smoke.
        subprocess.run(['xcrun', 'simctl', 'bootstatus', sys.argv[1], '-b'], check=True, timeout=600, stdout=output, stderr=subprocess.STDOUT)
except (subprocess.TimeoutExpired, subprocess.CalledProcessError):
    print('\n'.join(log.read_text().splitlines()[-40:]), file=sys.stderr)
    raise
print('PASS: simulator finished boot and system data migration')
PY
  simulator_app="$build_root/DerivedData-simulator/Build/Products/Debug-iphonesimulator/GEVTAK.app"
  xcrun simctl install "$simulator_id" "$simulator_app"
  launch_result="$(xcrun simctl launch "$simulator_id" "$bundle_id" --gev-smoke)"
  printf '%s\n' "$launch_result"
  app_pid="${launch_result##*: }"
  [[ "$app_pid" =~ ^[0-9]+$ ]]
  app_data="$(xcrun simctl get_app_container "$simulator_id" "$bundle_id" data)"
  python3 - "$app_data/Library/Caches/gev-startup-smoke.json" "$app_pid" "$build_root" <<'PYSMOKE'
import json, os, pathlib, sys, time
marker = pathlib.Path(sys.argv[1])
for _ in range(150):
    os.kill(int(sys.argv[2]), 0)
    if marker.exists():
        record = json.loads(marker.read_text())
        assert record.get('ready') is True, record
        assert record.get('layers', 0) >= 34, record
        (pathlib.Path(sys.argv[3])/'simulator-startup.json').write_text(json.dumps(record, indent=2)+'\n')
        break
    time.sleep(1)
else:
    raise RuntimeError('Bundled GEV did not initialize and render in the simulator')
print('PASS: bundled GEV initialized, retained its layers and rendered a Cesium frame')
PYSMOKE
  xcrun simctl io "$simulator_id" screenshot "$build_root/simulator-setup.png"
  printf '%s\n' 'PASS: simulator bundled-app startup and render smoke (no server configured)'
fi

python3 - "$task_root" "$ipa" "$architectures" "$smoke" "${runtime_id:-}" "${device_type:-}" <<'PY'
import datetime, hashlib, json, os, pathlib, subprocess, sys
root, ipa = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2])
sha = hashlib.sha256(ipa.read_bytes()).hexdigest()
def command(*args):
    return subprocess.check_output(args, cwd=root, text=True).strip()
provenance = {
    'format': 1, 'artifact': ipa.name, 'sha256': sha,
    'sourceCommit': command('git', 'rev-parse', 'HEAD'),
    'sourceDirty': bool(command('git', 'status', '--porcelain')),
    'builtAtUTC': datetime.datetime.now(datetime.timezone.utc).isoformat(),
    'toolchain': command('xcodebuild', '-version'),
    'deviceSDK': command('xcrun', '--sdk', 'iphoneos', '--show-sdk-version'),
    'architectures': sys.argv[3].split(), 'bundleIdentifier': 'uk.rebeltechoxford.gevtak',
    'platform': 'iPhoneOS', 'signing': 'unsigned; personal signing required',
    'deviceArchiveValidated': True, 'payloadValidated': True,
    'endpointPolicyTestsPassed': True, 'bundledServerTestsPassed': True,
    'simulatorLaunchSmokePassed': sys.argv[4] == '1', 'simulatorBundledRenderPassed': sys.argv[4] == '1',
    'simulatorRuntime': sys.argv[5] or None, 'simulatorDeviceType': sys.argv[6] or None,
    'physicalDeviceTested': False, 'privateEndpointConfigured': False,
    'liveTakPeerTested': False, 'bundledWebApp': True, 'standaloneDeviceAcceptancePassed': False,
    'directNativeTakTransportImplemented': False, 'offlineMapsImplemented': False,
    'githubRunID': os.environ.get('GITHUB_RUN_ID'),
}
(ipa.parent/'provenance.json').write_text(json.dumps(provenance, indent=2)+'\n')
(ipa.parent/'SHA256SUMS').write_text(f'{sha}  {ipa.name}\n')
print(f'Unsigned IPA ready: {ipa.name}; SHA-256 {sha}')
PY

# Publish only a fully validated artifact; a failed simulator check cannot leave
# an unverified new IPA under the final output filename.
mv "$ipa" "$build_root/provenance.json" "$build_root/SHA256SUMS" "$output_root/"
if [[ "$smoke" == 1 ]]; then
  mv "$build_root/simulator-setup.png" "$build_root/simulator-startup.json" "$output_root/"
fi
