# Native Mobile Host

Daft Citadel has a real Expo development host for iOS and Android. Expo owns the
generated application shells, while `modules/daft-citadel-native` packages the
existing audio, collaboration, plugin-host, and sample-loading sources as one
local native module.

## Supported toolchain

- Node.js 22 and npm
- Expo SDK 54 / React Native 0.81
- Android Studio toolchain with JDK 17 and Android SDK 36
- Xcode 16.1 or newer on macOS, CocoaPods, and an iOS 18.0+ target

The checked-in `android/` and `ios/` directories are the build inputs and are
reproducible from `app.json`, the local Expo module, and the config plugin:

```bash
npm ci
npx expo prebuild --clean --no-install
```

Run that command after changing bundle identifiers, native dependencies,
deployment targets, permissions, or module registration. Review the native diff
before committing it. A whitespace-only line-ending difference may be ignored,
but every semantic host change must be committed with its source configuration.

## Run a development build

```bash
npm run android
npm run ios
```

These commands build a custom development client. On iOS and Android,
`SessionAppProvider` detects the locally linked `AudioEngineModule` and attempts
the production/native environment in both debug and release builds. If the
module is missing or cannot initialize, it safely falls back to the passive
environment. Expo Go therefore remains usable for passive UI/session work, but
cannot exercise `AudioEngineModule`, `AudioSampleLoaderModule`, or
`CollabNetworkDiagnostics`. `npm run web` always stays passive. Set
`EXPO_PUBLIC_DAFT_CITADEL_USE_NATIVE_BRIDGE=false` only when a custom client must
be forced into passive mode for debugging.

The native audio graph also includes the persisted Juno-106 instrument, live
MIDI/parameter bridge, and hard-silence lifecycle handling. See the
[`Juno-106 instrument guide`](juno106-instrument.md) for its architecture,
Performance workflow, realtime bounds, presets/SysEx APIs, and focused
validation commands.

The current development client also exposes native transport loops through
`setTransportLoop(startFrame, endFrame, enabled)`. Enabled ranges are half-open
(`[startFrame, endFrame)`) and wrap inside the portable render callback, including
when a device buffer crosses the end frame. Persisted Juno timeline events in the
range are replayed on every pass; transient live-touch MIDI is canceled at a wrap
so gestures cannot replay as phantom notes. This capability requires rebuilding
the development client after native changes and is not available in Expo Go.

## Native module layout

- `modules/daft-citadel-native/android/build.gradle` adds the existing Kotlin,
  JNI, and C++ source roots and builds the audio engine with CMake.
- `DaftCitadelNative.podspec` links the Swift,
  Objective-C++, and C++ sources with AVFoundation, AudioToolbox, and
  NetworkExtension.
- `plugins/with-daft-citadel-native.js` registers the legacy React Native package
  alongside Expo's automatically linked health module.
- `AudioSampleLoaderModule` decodes bounded WAV/PCM data off the render path and
  returns planar Float32 payloads for the native clip registry. Mobile decodes
  are limited to 8 channels and 64 MiB of decoded PCM; Android also caps the
  encoded input at 64 MiB. Larger assets require a future streaming loader.

Android declares version-scoped Wi-Fi discovery permissions in the local module
manifest. The JavaScript diagnostics adapter requests `NEARBY_WIFI_DEVICES` on
Android 13+ or fine/coarse location on older releases before starting native
polling. On iOS, app config includes the Wi-Fi information entitlement and a
when-in-use location description; the native module requests authorization
before reading the current network. These APIs still require a signed physical
device for meaningful verification.

The AUv3 and VST3 control/discovery sources are compiled, but plugin capability
is deliberately disabled. Neither platform currently connects
`PluginHostBridge::SetRenderCallback` to the audio device path, and Android also
lacks the packaged `vst3sandbox` executable. Native modules report
`runtimeReady: false`, discovery returns no descriptors, and instantiation fails
closed until those runtime pieces are implemented.

## Local compilation and safety gates

Run the portable repository gates locally with:

```bash
npm run verify
npm run verify:sanitize
```

Then compile the checked-in Android host with JDK 17/Android SDK 36 and the iOS
host with Xcode/CocoaPods on macOS. Those local platform builds are the only way
to validate JNI/Kotlin and Objective-C++/Swift integration in this repository.

```bash
(cd android && ./gradlew app:assembleDebug)
(cd ios && pod install && xcodebuild \
  -workspace DaftCitadel.xcworkspace \
  -scheme DaftCitadel \
  -sdk iphonesimulator \
  -configuration Debug \
  CODE_SIGNING_ALLOWED=NO build)
```

Expo Doctor's native-config sync warning is disabled because this repository
intentionally commits native hosts. Validate drift locally with the clean
prebuild command above and review `git diff -- android ios`. Its React Native
Directory check excludes the in-repository module and
`react-native-webrtc`; both must be reviewed and compiled with the project's
local platform toolchains instead of relying on third-party metadata.
