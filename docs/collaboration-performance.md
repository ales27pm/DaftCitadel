# Collaboration Performance and Diagnostics Runbook

This document explains how the peer-to-peer collaboration stack in `src/services/collab/` operates, how it leverages platform diagnostics, and the operational workflows required to capture and analyze performance data across iOS and Android.

## 1. Architecture Overview

The collaboration service is built around `CollabSessionService` and helper modules exported from `src/services/collab/index.ts`.

- **WebRTC transport** – `CollabSessionService` composes a `RTCPeerConnection` instance (via dependency injection for testability) and manages a reliable, ordered data channel labelled `daft-collab`. Offer/answer exchange is performed through an injected `PeerSignalingClient`, which can be backed by WebSockets, push notifications, or any custom signaling fabric.
- **End-to-end encryption** – Each participant generates a Curve25519 identity key pair using `generateIdentityKeyPair`. A per-session shared secret is derived through `EncryptionContext`, which combines the Diffie-Hellman shared secret with an optional pre-shared key and encrypts payloads via XSalsa20-Poly1305 (`tweetnacl.secretbox`). Payloads are versioned (`schemaVersion`) and timestamped (`clock`) before being serialized.
- **Latency compensation** – `LatencyCompensator` tracks the offset between local and remote clocks using an exponentially weighted moving average. Incoming messages are normalized before surfacing to the app to maintain temporal ordering even on lossy networks.
- **Network-aware tuning** – `createNetworkDiagnostics` binds to the native `CollabNetworkDiagnostics` module, which should surface CoreWLAN metrics on iOS (RSSI, noise floor, transmit rate) and WifiManager readings on Android (link speed, RSSI). The service adjusts the data channel’s `bufferedAmountLowThreshold` based on the current link speed to keep pacing responsive during throughput changes.

### Extending the signaling layer

`PeerSignalingClient` is an abstract interface. Implementations must relay events (`offer`, `answer`, `iceCandidate`, `publicKey`, and `shutdown`) to remote peers. The default service registers listeners in its constructor and cleans them up on `stop()`.

## 2. Native Diagnostics Integration

### iOS (CoreWLAN)

1. The repository ships `native/collab/ios/CollabNetworkDiagnostics.swift`, which fulfils the following contract:
   - Uses `CWWiFiClient` to query the current interface (`interface()?.ssid()`, `rssiValue()`, `noiseMeasurement()`).
   - Publishes updates via `sendEventWithName("CollabNetworkDiagnosticsEvent", body: metrics)`.
   - Requests temporary full Wi-Fi usage entitlement for sideloaded builds (`com.apple.developer.networking.multiple-packets.tuple`).
2. Ensure the module exposes `getCurrentLinkMetrics` and paired observation commands (`startObserving`/`stopObserving` or `beginObserving`/`endObserving`) as used in `NetworkDiagnostics.ts`.
3. Log failures with `os_log` to aid diagnosis when CoreWLAN is unavailable (e.g., on simulator).

### Android (WifiManager)

1. The Android bridge lives in `native/collab/android/src/main/java/com/daftcitadel/collab/CollabNetworkDiagnosticsModule.kt` and polls `WifiManager` for link state before emitting `CollabNetworkDiagnosticsEvent` updates.
2. Declare and request `ACCESS_FINE_LOCATION` at runtime using React Native’s permission APIs—`requiresLocationPermission()` surfaces the need to the JS layer. Android 13+ devices also require `NEARBY_WIFI_DEVICES` for link metrics.
3. Optionally integrate `ConnectivityManager.registerNetworkCallback` to capture link bandwidth using `LinkProperties.getLinkBandwidths()` on Android 13+.

## 3. Performance Capture Workflow

### Tethered capture with rvictl

Use `scripts/rvictl-capture.sh` to collect encrypted packets directly from a connected iOS device:

1. Install Xcode command-line tools and ensure `rvictl` and `tcpdump` are present.
2. Connect the device via USB and obtain the UDID with `xcrun xctrace list devices`.
3. Run the helper script, providing the UDID, output file, duration, and optional tcpdump filter:
   ```bash
   scripts/rvictl-capture.sh -u 00008030-001C195E26A2002E -o captures/collab-session.pcap -d 120 -f 'port 7000'
   ```
4. The script brings up an RVI interface, streams packets to the specified `.pcap`, and tears down the interface automatically (even if interrupted).
5. Analyze the capture with Wireshark or `tshark`, correlating timestamps with the compensated clocks emitted by `CollabSessionService` logs.

### Android tethering alternatives

- Use `adb shell tcpdump -i any -w /sdcard/collab.pcap` combined with `adb pull` for rooted diagnostics builds.
- On stock devices, rely on `adb shell dumpsys wifi` and `adb bugreport` for aggregated link metrics when packet capture is unavailable.

## 4. CI/CD Pipelines for Sideloading Builds

### iOS (Xcode + AltStore)

1. **Build automation** – Configure a CI workflow (GitHub Actions or similar) that runs:
   ```bash
   xcodebuild -workspace ios/DaftCitadel.xcworkspace \
     -scheme DaftCitadel \
     -configuration Release \
     -destination 'generic/platform=iOS' \
     CODE_SIGN_STYLE=Manual \
     CODE_SIGN_IDENTITY='Apple Development' \
     PROVISIONING_PROFILE_SPECIFIER='DaftCitadelCollab'
   ```
2. **Entitlements** – Include `com.apple.developer.networking.multiple-packets.tuple`, `com.apple.developer.networking.wifi-info`, and `com.apple.developer.networking.vpn.api` for diagnostics tooling. Add `com.apple.developer.usernotifications.communication` if background signaling is required.
3. **AltStore packaging** – Export an `.ipa` with `xcodebuild -exportArchive` and sign it using an AltStore-compatible personal development certificate. Provide a manifest JSON pointing to the `.ipa` for easy sideload distribution.
4. **Post-build artifacts** – Publish the `.ipa`, provisioning profile, and entitlements plist as CI artifacts to ensure operators can reinstall builds locally.

### Android (Gradle + sideload)

1. Integrate a Gradle task within CI to assemble diagnostics builds:
   ```bash
   ./gradlew assembleCollabRelease \
     -Pandroid.injected.signing.store.file=$SIGNING_STORE \
     -Pandroid.injected.signing.store.password=$SIGNING_PASSWORD \
     -Pandroid.injected.signing.key.alias=$SIGNING_ALIAS \
     -Pandroid.injected.signing.key.password=$SIGNING_KEY_PASSWORD
   ```
2. Request `android.permission.ACCESS_FINE_LOCATION`, `android.permission.ACCESS_WIFI_STATE`, and `android.permission.CHANGE_NETWORK_STATE` in the manifest. If leveraging tethered VPN captures, declare `android.permission.BIND_VPN_SERVICE` and implement a foreground service wrapper for `VpnService`.
3. Distribute the resulting APK via secure artifact storage or an internal AltStore-equivalent (e.g., `adb install --grant-all-permissions`).

## 5. Operational Runbooks

### Establishing a collaboration session

1. Initialize platform diagnostics by calling `createNetworkDiagnostics()` and gating location permission requests on `requiresLocationPermission()`.
2. Instantiate a `PeerSignalingClient` (WebSocket client recommended) and connect it before invoking `CollabSessionService.start(role)`.
3. Persist the local public key (`getLocalPublicKey()`) alongside any session metadata to streamline reconnections.
4. Log `collab.networkMetrics` and `collab.dataChannel.*` events to correlate throughput changes with user activity.

### Responding to performance regressions

1. Capture live metrics using `CollabSessionService` logs and attach `scripts/rvictl-capture.sh` captures when anomalies occur on iOS.
2. On Android, gather `adb shell dumpsys wifi` output and, if necessary, run `adb shell cmd connectivity diag` to observe link-layer behavior.
3. Compare compensated timestamps (`payload.clock`) between peers to quantify desynchronization—values above ±150 ms require investigation.
4. Validate entitlements and runtime permissions if diagnostics data appears stale. Missing entitlements typically manifest as `collab.networkMetrics.error` logs.

### Maintenance and verification checklist

- Run `npm run lint`, `npm run typecheck`, and `npm test` for every change to `src/services/collab/` modules.
- Keep the native `CollabNetworkDiagnostics` module in parity across platforms so the JS layer remains platform-agnostic.
- Review CI artifact retention policies to ensure sideloadable builds remain accessible for at least 30 days.
- Schedule quarterly drills to exercise the rvictl workflow and confirm engineers maintain sudo access to diagnostics hosts.

## 6. References

- `src/services/collab/CollabSessionService.ts` for orchestration logic.
- `src/services/collab/diagnostics/NetworkDiagnostics.ts` for native bridging expectations.
- `scripts/rvictl-capture.sh` for tethered capture automation.
