# iOS Host (zero-native)

Native iOS shell for ZK Poker: UIKit + WKWebView frontend with Zig bridge to libzkcasino.

## Prerequisites

- Xcode 15+ with iOS SDK
- Zig (same version as desktop app)
- Built desktop witness libs (`cd ../libzkcasino && zig build`)
- Frontend production build (`npm --prefix ../frontend run build`)

### iOS witness libraries

macOS witness binaries cannot be bundled on iOS. Build static GMP, then cross-compile poker witness libs:

```bash
chmod +x scripts/build-ios-gmp.sh
./scripts/build-ios-gmp.sh iphonesimulator
cd ../libzkcasino
zig build -Dtarget=aarch64-ios-simulator -Dcircuit-set=poker -Dwitness-link=dynamic
cd ../app
zig build ios-lib -Dios-target=aarch64-ios-simulator
```

## Build native library

From `app/`:

```bash
npm --prefix frontend run build
zig build ios-lib -Dios-target=aarch64-ios-simulator
```

This produces:

- `ios/Libraries/libapp.a` — static library (poker app + zero-native embed + rapidsnark)
- `ios/ZeroNativeIOSExample/zero_native.h` — C ABI header (via `zig-out/include/`)
- `ios/Frameworks/*.dylib` — witness libraries copied for bundle embedding

For device builds:

```bash
zig build ios-lib -Dios-target=aarch64-ios
```

## Run in Simulator (interactive)

Build, install, and launch ZKPoker **without** E2E flags (the app stays open):

```bash
chmod +x app/scripts/run-ios-simulator.sh
./app/scripts/run-ios-simulator.sh
```

Or from repo root:

```bash
npm run ios:simulator
```

Rebuild after frontend changes:

```bash
npm run ios:simulator
```

Skip rebuild if already built:

```bash
SKIP_IOS_BUILD=1 ./app/scripts/run-ios-simulator.sh
```

With a remote game server baked into the frontend:

```bash
VITE_API_BASE=http://192.168.1.10:3847 ./app/scripts/run-ios-simulator.sh
```

You can also open `ios/ZeroNativeIOSExample.xcodeproj` in Xcode and press Run (⌘R) on an iPhone simulator.

**Note:** `npm run test:ios:simulator` runs automated E2E (`-e2e_automation`) and the app exits after the smoke test. Use `npm run ios:simulator` for normal use.

## Xcode

1. Open `ios/ZeroNativeIOSExample.xcodeproj`
2. Add bundle resources to the **ZKPoker** target (Copy Bundle Resources):
   - `frontend/dist/**`
   - `Frameworks/*.dylib`
   - `zkey/register_main_0001.zkey` (start with register circuit; add poker zkeys as needed)
3. Run on simulator or device

## Remote game server

iOS cannot spawn the Bun server. Set `VITE_API_BASE` when building the frontend:

```bash
VITE_API_BASE=http://192.168.1.10:3847 npm --prefix frontend run build
```

Or save a custom URL at runtime via `saveApiBase()` in the frontend.

## Architecture

- **Swift** owns WKWebView, `zero://` asset scheme, and bridge script transport
- **libapp.a** exports `zero_native_app_*` + `zero_native_app_bridge_dispatch`
- **Svelte** calls `window.zero.invoke('zk.prove', ...)` as on desktop
- **ZK witness libs** ship as embedded `.dylib` in `Frameworks/` (duplicate C symbols prevent single static archive)
- **rapidsnark** is statically linked into `libapp.a`

## Simulator E2E tests

The default runner launches ZKPoker via `simctl` with `-e2e_automation`, runs `zk.ping`
in the WebView, writes `Documents/e2e-results.json`, and exits. The host script polls
that file (no XCUITest accessibility polling loop).

### Run from CLI

```bash
chmod +x app/scripts/run-ios-simulator-e2e.sh
./app/scripts/run-ios-simulator-e2e.sh
```

Or via Bun:

```bash
bun test test/ios/simulator-e2e
```

Environment variables:

| Variable | Default | Purpose |
|----------|---------|---------|
| `IOS_SIMULATOR_DEST` | `platform=iOS Simulator,OS=26.5,name=iPhone 17 Pro` | xcodebuild destination |
| `IOS_SIMULATOR_NAME` | `iPhone 17 Pro` | simctl device name |
| `IOS_E2E_POLL_SECONDS` | `45` | Max wait for results file |
| `IOS_E2E_USE_XCUITEST` | `0` | Use `xcodebuild test` instead of simctl |
| `SKIP_IOS_E2E_BUILD` | `0` | Skip frontend + ios-lib rebuild |
| `SKIP_IOS_E2E` | — | Skip Bun wrapper entirely |
| `IOS_E2E_PROVE` | — | Enable slow prove test (future) |
| `E2E_API_BASE` | — | Enable remote server health test (future) |

Optional XCUITest path (Xcode UI only; smoke test is skipped by default):

```bash
IOS_E2E_USE_XCUITEST=1 ./app/scripts/run-ios-simulator-e2e.sh
```
