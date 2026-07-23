# Collaboration Performance and Diagnostics Runbook

This document explains how the peer-to-peer collaboration stack in `src/services/collab/` operates, how it leverages platform diagnostics, and the operational workflows required to capture and analyze performance data across iOS and Android.

## 1. Architecture Overview

The collaboration service is built around `CollabSessionService` and helper modules exported from `src/services/collab/index.ts`.

- **WebRTC transport** – `CollabSessionService` composes a `RTCPeerConnection` instance (via dependency injection for testability) and manages an ordered data channel labelled `daft-collab`. Application-level sequence numbers, acknowledgements, bounded retries, duplicate suppression, and history replay make edit delivery reliable even when a caller selects a partially reliable WebRTC channel configuration. Offer/answer exchange is performed through an injected `PeerSignalingClient`, which can be backed by WebSockets, push notifications, or any custom signaling fabric.
- **Authenticated end-to-end encryption** – Each participant generates a Curve25519 identity key pair using `generateIdentityKeyPair`. A connection must provide either a session-bound shared authentication secret of at least 16 bytes or an explicit remote-public-key verifier. The handshake binds the protocol version, session ID, role, sender fingerprint, handshake ID, and public key before `EncryptionContext` derives a session-bound key and encrypts payloads via XSalsa20-Poly1305 (`tweetnacl.secretbox`). Both peers then complete encrypted key confirmation, proving private-key possession before either peer is published as authenticated. Unauthenticated key exchange and post-authentication re-handshakes are rejected.
- **Validated collaboration protocol** – Encrypted messages carry the authenticated sender, session, schema version, timestamp, message ID, and monotonic sequence. The receiver rejects mismatched senders/sessions/schemas, unsafe clocks, malformed frames, and replayed updates before invoking application code. Inbound frame count and byte budgets, staged ICE limits, SDP/ICE size limits, and a bounded pending-acknowledgement window prevent untrusted peers from growing memory without limit. `broadcastUpdate()` resolves only after the remote peer applies and acknowledges the update.
- **Latency compensation** – `LatencyCompensator` tracks the offset between local and remote clocks using an exponentially weighted moving average. Incoming messages are normalized before surfacing to the app to maintain temporal ordering even on lossy networks.
- **Network-aware tuning** – `createNetworkDiagnostics` binds to the native `CollabNetworkDiagnostics` module, which should surface CoreWLAN metrics on iOS (RSSI, noise floor, transmit rate) and WifiManager readings on Android (link speed, RSSI). The service adjusts the data channel’s `bufferedAmountLowThreshold` based on the current link speed to keep pacing responsive during throughput changes.

### Extending the signaling layer

`PeerSignalingClient` is an abstract interface. Implementations must relay events (`offer`, `answer`, `iceCandidate`, `publicKey`, and `shutdown`) to the intended remote peer. The `publicKey` value is now an opaque serialized authenticated-handshake envelope; signaling backends must preserve it byte-for-byte and must not extract or replace the contained key. Authentication prevents a signaling relay from substituting a usable key, but the backend remains responsible for session membership, rate limits, availability, and preventing cross-session message delivery. The service cleans listeners up on `stop()` and reinstalls them on a later `start()`.

## 2. Collaboration Handshake and Recovery Sequence

With the collaboration toggles now exposed in the UI, every connection run should follow the
same deterministic handshake. `CollabSessionService` emits structured health snapshots so the
UI can reflect connection state without polling low-level primitives.

1. **Session bootstrapping**
   - Instantiate `CollabSessionService` with a `PeerSignalingClient`, an `authentication`
     configuration, an optional `createNetworkDiagnostics()` instance, and an
     `onRemoteUpdateApplied` handler that points to
     `createRemoteSessionPatchApplier(SessionManager)`. Provision shared authentication secrets
     through a secure out-of-band channel and store them with platform keychain/keystore APIs; do
     not send them through `PeerSignalingClient`.
   - Call `subscribeHealth(listener)` immediately after construction so the UI can present the
     initial `idle → connecting` state while the service negotiates keys.
2. **Handshake progression**
   - `start('initiator' | 'responder')` creates/accepts the data channel, broadcasts the
     authenticated Curve25519 handshake envelope, and begins sampling diagnostics. Health
     snapshots transition through
     `connecting` until both the ICE and data-channel callbacks report `connected`.
   - The service records the last network metrics payload and exposes the current
     `RTCDataChannel.readyState` inside `CollabSessionHealthSnapshot` so the UI can surface
     channel quality indicators.
3. **Remote edits and history**
   - Remote payloads are validated, sequence-checked, timestamp-compensated, and delegated to the
     injected `onRemoteUpdateApplied`. Its second argument contains an `AbortSignal`; application
     handlers must stop before committing when that signal is aborted. When wired through
     `createRemoteSessionPatchApplier`, the patch is applied via `SessionManager.updateSession`,
     ensuring an undo point is recorded before the merged session is emitted.
   - The receiver acknowledges only successfully applied edits. Missing acknowledgements trigger
     bounded retransmission. Sequence gaps request a replay from bounded outbound history. Supply
     `onResyncRequested` to return the current canonical session when a requested edit has aged out
     of that history. Remote appliers should remain idempotent because a transport failure can occur
     after application but before its acknowledgement arrives.
   - `CollabSessionService` updates `lastLatencyMs`, `averageLatencyMs`, and
     `lastUpdateReceivedAt` in the health snapshot after each frame, allowing the UI to render
     live latency readouts.
4. **Recovery and teardown**
   - The sender checks `RTCDataChannel.bufferedAmount` before every frame and waits for
     `bufferedamountlow` (with a timeout) when the configured high-water mark is exceeded. Health
     snapshots expose pending acknowledgement counts and the last acknowledged sequence.
   - On disconnection (ICE state `disconnected` or data channel `close`), health snapshots switch
     to `reconnecting`/`disconnected`. The UI should prompt the operator or attempt an automatic
     retry by calling `start` again once signaling reconnects.
   - Always call `stop()` when collaboration is disabled to release listeners, close the
     `RTCPeerConnection`, and reset encryption keys. The health snapshot remains available via
     `getHealthSnapshot()` so the UI can display the last-known state for audit logs.

Health snapshots deliberately avoid including raw diagnostics payloads with personally
identifiable interface data (e.g., adapter names). The sanitised metrics mirror the values logged
via `collab.networkMetrics` so operators can reconcile GUI output with logcat/syslog captures.

## 3. Native Diagnostics Integration

### iOS (Wi-Fi APIs)

1. The repository ships `native/collab/ios/CollabNetworkDiagnostics.swift`, which fulfils the following contract:
   - On iOS 14+, it gathers metrics with `NEHotspotNetwork.fetchCurrent(completionHandler:)`, falling back to `CNCopyCurrentNetworkInfo` on older OS versions and using `CWWiFiClient` when built for Mac Catalyst.
   - Publishes updates via `sendEvent(withName: "CollabNetworkDiagnosticsEvent", body: metrics)`.
   - `app.json` and the checked-in host include the `com.apple.developer.networking.wifi-info` entitlement plus a when-in-use location description. The module requests Core Location authorization before querying the current network. Builds must still be signed with a provisioning profile that permits the entitlement. When access is denied, the module emits error payloads instead of metrics.
   - `NEHotspotNetwork.signalStrength` is surfaced as a normalized `0...1` value. Shared quality evaluation uses that value directly and never labels it as RSSI/dBm.
2. Ensure the module exposes `getCurrentLinkMetrics` together with the `beginObserving`/`endObserving` commands that mirror the React Native lifecycle (`startObserving`/`stopObserving`). `beginObserving`/`endObserving` are the public commands invoked by `NetworkDiagnostics.ts`.
3. Log failures with `os_log` to aid diagnosis when Wi-Fi information is unavailable (e.g., on simulator hardware or when the entitlement is missing). NEHotspotNetwork does not expose RSSI or noise floor values, so physical iOS devices return normalized signal strength instead.

### Android (WifiManager)

1. The Android bridge lives in `native/collab/android/src/main/java/com/daftcitadel/collab/CollabNetworkDiagnosticsModule.kt` and polls `WifiManager` for link state before emitting `CollabNetworkDiagnosticsEvent` updates.
2. The library manifest scopes fine/coarse location to API 32 and below and declares `NEARBY_WIFI_DEVICES` with `neverForLocation` on Android 13+. Before collecting or observing metrics, the JavaScript adapter requests fine/coarse location on Android 12 and below or `NEARBY_WIFI_DEVICES` on Android 13+. Denial prevents the native poller from starting.
3. Optionally integrate `ConnectivityManager.registerNetworkCallback` to capture link bandwidth using `LinkProperties.getLinkBandwidths()` on Android 13+.

## 4. Performance Capture Workflow

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

## 5. Local Sideloading Builds

### iOS (Xcode + AltStore)

1. **Local archive** – On a trusted macOS workstation with the intended signing identity and provisioning profile installed, run:
   ```bash
   xcodebuild -workspace ios/DaftCitadel.xcworkspace \
     -scheme DaftCitadel \
     -configuration Release \
     -destination 'generic/platform=iOS' \
     CODE_SIGN_STYLE=Manual \
     CODE_SIGN_IDENTITY='Apple Development' \
     PROVISIONING_PROFILE_SPECIFIER='DaftCitadelCollab'
   ```
2. **Entitlements** – Keep `com.apple.developer.networking.wifi-info` in the signed target. Add restricted VPN or communication entitlements only if the corresponding feature is implemented and the provisioning profile explicitly permits it.
3. **AltStore packaging** – Export an `.ipa` with `xcodebuild -exportArchive` and sign it using an AltStore-compatible personal development certificate. Provide a manifest JSON pointing to the `.ipa` for easy sideload distribution.
4. **Local handoff** – Keep the `.ipa` in encrypted operator-controlled storage. Never commit or bundle signing certificates, private keys, or provisioning profiles; regenerate the app from the tagged commit when possible.

### Android (Gradle + sideload)

1. Assemble a debug diagnostics build locally, then install it on the attached device:
   ```bash
   (cd android && ./gradlew app:assembleDebug)
   adb install -r android/app/build/outputs/apk/debug/app-debug.apk
   ```
2. Keep the normal `ACCESS_WIFI_STATE` permission plus the version-scoped runtime declarations shipped by the module: fine/coarse location through API 32 and `NEARBY_WIFI_DEVICES` on API 33+. Do not add `CHANGE_NETWORK_STATE` or VPN permissions unless a corresponding network-mutation or foreground VPN feature is actually implemented.
3. Distribute the resulting APK through encrypted operator-controlled storage. Install without `--grant-all-permissions` so the app's runtime permission and denial flows are exercised.

## 6. Operational Runbooks

### Establishing a collaboration session

1. Initialize platform diagnostics with `createNetworkDiagnostics()`. The adapter owns the runtime permission request; use `requiresLocationPermission()` only to choose Android-version-specific explanatory UI before collection starts.
2. Instantiate a `PeerSignalingClient` (WebSocket client recommended) and connect it before invoking `CollabSessionService.start(role)`.
3. Select one authentication mode:
   - `shared-secret`: give both peers the same high-entropy secret and session ID through a trusted out-of-band invitation flow.
   - `verified-key`: implement `verifyRemotePublicKey` against a key fingerprint obtained through a trusted directory, QR code, or an operator confirmation flow. The callback must verify the key for the supplied session ID and sender identity.
4. Provide `onResyncRequested` when the application can serialize a canonical current session. Without it, recovery is limited to the configured `resyncHistorySize`.
5. Log `collab.peerAuthenticated`, `collab.resync*`, `collab.acknowledgement*`, `collab.networkMetrics`, and `collab.dataChannel.*` events to correlate authentication and delivery failures with network conditions.

### Responding to performance regressions

1. Capture live metrics using `CollabSessionService` logs and attach `scripts/rvictl-capture.sh` captures when anomalies occur on iOS.
2. On Android, gather `adb shell dumpsys wifi` output and, if necessary, run `adb shell cmd connectivity diag` to observe link-layer behavior.
3. Compare compensated timestamps (`payload.clock`) between peers to quantify desynchronization—values above ±150 ms require investigation.
4. Validate entitlements and runtime permissions if diagnostics data appears stale. Missing entitlements typically manifest as `collab.networkMetrics.error` logs.

### Maintenance and verification checklist

- Run `npm run verify` for every change to `src/services/collab/` modules, then compile and exercise the affected platform locally.
- Keep the native `CollabNetworkDiagnostics` module in parity across platforms so the JS layer remains platform-agnostic.
- Record the source commit and local toolchain versions beside any sideloaded build so operators can reproduce it without depending on retained build artifacts.
- Schedule quarterly drills to exercise the rvictl workflow and confirm engineers maintain sudo access to diagnostics hosts.

## 7. References

- `src/services/collab/CollabSessionService.ts` for orchestration logic.
- `src/services/collab/diagnostics/NetworkDiagnostics.ts` for native bridging expectations.
- `scripts/rvictl-capture.sh` for tethered capture automation.
