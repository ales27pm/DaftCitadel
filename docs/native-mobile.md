# Native Mobile Host

Daft Citadel has a real Expo development host for iOS and Android. Expo owns the
generated application shells, while `modules/daft-citadel-native` packages the
existing audio, collaboration, plugin-host, and sample-loading sources as one
local native module.

## Supported toolchain

- Node.js 22 and npm
- Expo SDK 54 / React Native 0.81
- Android Studio toolchain with JDK 17 and Android SDK 36
- Xcode 16.1 or newer on macOS, CocoaPods, and an iOS 15.1+ target

The checked-in `android/` and `ios/` directories are the build inputs and are
reproducible from `app.json`, the local Expo module, and the config plugin:

```bash
npm ci
npx expo prebuild --clean --no-install
```

Run that command after changing bundle identifiers, native dependencies,
deployment targets, permissions, or module registration. Review the native diff
before committing it. CI repeats the clean prebuild and fails if either committed
host drifts, then the platform jobs compile those checked-in projects directly.

## Run a development build

```bash
npm run android
npm run ios
```

These commands build a custom development client. Expo Go is not sufficient
because `AudioEngineModule`, `AudioSampleLoaderModule`, `CollabConnectionModule`,
and the platform plugin hosts are compiled locally. `npm run web` remains useful
for UI work and deliberately uses the passive audio/session environment. Web
sessions use browser storage when available and fall back to failure-atomic
in-memory storage in restricted browser contexts.

## Native module layout

- `modules/daft-citadel-native/android/build.gradle` adds the existing Kotlin,
  JNI, and C++ source roots and builds the audio engine with CMake.
- `modules/daft-citadel-native/ios/DaftCitadelNative.podspec` links the Swift,
  Objective-C++, and C++ sources with AVFoundation, AudioToolbox, and
  NetworkExtension.
- `plugins/with-daft-citadel-native.js` registers the legacy React Native package
  alongside Expo's automatically linked health module.
- `AudioSampleLoaderModule` decodes bounded WAV/PCM data off the render path and
  returns planar Float32 payloads for the native clip registry.

Android declares Wi-Fi discovery permissions in the local module manifest.
Device collaboration on iOS also requires the Wi-Fi information and local
network capabilities to be enabled for the app's signing profile; Simulator CI
does not add production entitlements.

## Compilation and safety gates

The GitHub Actions workflow has four independent jobs:

1. repository formatting, lint, types, Jest, documentation, and production
   dependency audit;
2. host C++ tests compiled with AddressSanitizer and UndefinedBehaviorSanitizer;
3. an Android `assembleDebug` build of the committed host; and
4. an unsigned iOS Simulator `xcodebuild` of the committed host after CocoaPods
   installation.

Run the portable gates locally with:

```bash
npm run format:check
npm run lint
npm run typecheck
npm run test:ci
npm run native:core:test:sanitize
npm run expo:doctor
```

The platform compilation jobs remain authoritative for JNI/Kotlin and
Objective-C++/Swift integration because they require their respective SDKs.

Expo Doctor's native-config sync warning is disabled because this repository
intentionally commits native hosts and enforces prebuild drift itself. Its
React Native Directory check excludes the in-repository module and
`react-native-webrtc`; both are reviewed and compiled by this project's own
native jobs instead of relying on third-party metadata.
