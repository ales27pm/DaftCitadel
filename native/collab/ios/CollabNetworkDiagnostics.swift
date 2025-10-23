import Foundation
import os.log
import React
#if canImport(CoreWLAN)
import CoreWLAN
#endif
#if canImport(SystemConfiguration)
import SystemConfiguration.CaptiveNetwork
#endif
#if canImport(NetworkExtension)
import NetworkExtension
#endif

@objc(CollabNetworkDiagnostics)
final class CollabNetworkDiagnostics: RCTEventEmitter {
  private enum DiagnosticsError: LocalizedError {
    case interfaceUnavailable
    case wifiInformationUnavailable

    var errorDescription: String? {
      switch self {
      case .interfaceUnavailable:
        return "Wi-Fi interface unavailable"
      case .wifiInformationUnavailable:
        return "Wi-Fi metrics are unavailable on this device."
      }
    }
  }

  private let log = OSLog(subsystem: "com.daftcitadel.collab", category: "diagnostics")
  private let eventName = "CollabNetworkDiagnosticsEvent"
  private let metricsQueue = DispatchQueue(label: "com.daftcitadel.collab.diagnostics")
  private var pollTimer: DispatchSourceTimer?
  private var pollInterval: TimeInterval = 5.0

  override static func requiresMainQueueSetup() -> Bool {
    return false
  }

  override func supportedEvents() -> [String]! {
    return [eventName]
  }

  override func startObserving() {
    startMonitoring()
  }

  override func stopObserving() {
    stopMonitoring()
  }

  @objc(beginObserving)
  func beginObserving() {
    startMonitoring()
  }

  @objc(endObserving)
  func endObserving() {
    stopMonitoring()
  }

  @objc(setPollingInterval:)
  func setPollingInterval(intervalMs: NSNumber) {
    let interval = intervalMs.doubleValue
    guard interval.isFinite, interval > 0 else {
      return
    }

    metricsQueue.async {
      self.pollInterval = interval / 1000.0
      let wasActive = self.pollTimer != nil
      self.pollTimer?.cancel()
      self.pollTimer = nil
      if wasActive {
        self.scheduleTimerLocked()
      }
    }
  }

  @objc(getCurrentLinkMetrics:rejecter:)
  func getCurrentLinkMetrics(
    _ resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    metricsQueue.async {
      do {
        let metrics = try self.fetchMetrics()
        resolve(metrics)
      } catch {
        self.logFailure(error: error)
        reject("collab_metrics_unavailable", error.localizedDescription, error)
      }
    }
  }

  private func startMonitoring() {
    metricsQueue.async {
      guard self.pollTimer == nil else {
        return
      }
      self.scheduleTimerLocked()
    }
  }

  private func stopMonitoring() {
    metricsQueue.async {
      self.pollTimer?.cancel()
      self.pollTimer = nil
    }
  }

  private func scheduleTimerLocked() {
    let timer = DispatchSource.makeTimerSource(queue: metricsQueue)
    timer.schedule(
      deadline: .now(),
      repeating: .milliseconds(Int(pollInterval * 1_000.0)),
      leeway: .milliseconds(250)
    )
    timer.setEventHandler { [weak self] in
      self?.emitLatestMetrics()
    }
    pollTimer = timer
    timer.resume()
  }

  private func emitLatestMetrics() {
    do {
      let metrics = try fetchMetrics()
      DispatchQueue.main.async {
        self.sendEvent(withName: self.eventName, body: metrics)
      }
    } catch {
      logFailure(error: error)
      DispatchQueue.main.async {
        self.sendEvent(
          withName: self.eventName,
          body: [
            "error": error.localizedDescription,
            "timestamp": Date().timeIntervalSince1970 * 1000.0,
          ]
        )
      }
    }
  }

  private func logFailure(error: Error) {
    let nsError = error as NSError
    os_log(
      "Collab diagnostics failure: %{public}@ (%{public}@)",
      log: log,
      type: .error,
      nsError.localizedDescription,
      nsError.domain
    )
  }

  private func fetchMetrics() throws -> [String: Any] {
#if targetEnvironment(macCatalyst)
    return try fetchMetricsUsingCoreWLAN()
#else
    if #available(iOS 14.0, *) {
      return try fetchMetricsUsingHotspotNetwork()
    } else {
      return try fetchMetricsUsingCaptiveNetwork()
    }
#endif
  }

#if canImport(CoreWLAN)
  private func fetchMetricsUsingCoreWLAN() throws -> [String: Any] {
    guard let client = CWWiFiClient.shared(),
          let interface = client.interface()
    else {
      throw DiagnosticsError.interfaceUnavailable
    }

    var payload: [String: Any] = [
      "timestamp": Date().timeIntervalSince1970 * 1000.0,
    ]

    if let name = interface.interfaceName, !name.isEmpty {
      payload["interface"] = name
    }
    if let ssid = interface.ssid(), !ssid.isEmpty {
      payload["ssid"] = ssid
    }
    if let bssid = interface.bssid(), !bssid.isEmpty {
      payload["bssid"] = bssid
    }

    let rssi = interface.rssiValue()
    if rssi != 0 {
      payload["rssi"] = rssi
    }

    let noise = interface.noiseMeasurement()
    if noise != 0 {
      payload["noise"] = noise
    }

    let transmitRate = interface.transmitRate()
    if transmitRate.isFinite {
      payload["linkSpeedMbps"] = transmitRate
      payload["transmitRateMbps"] = transmitRate
    }

    if #available(macOS 11.0, macCatalyst 14.0, *) {
      if let phyMode = interface.activePHYMode()?.rawValue {
        payload["phyMode"] = phyMode
      }
    }

    return payload
  }
#endif

#if canImport(NetworkExtension)
  @available(iOS 14.0, *)
  private func fetchMetricsUsingHotspotNetwork() throws -> [String: Any] {
    let semaphore = DispatchSemaphore(value: 0)
    var result: Result<[String: Any], Error> = .failure(DiagnosticsError.wifiInformationUnavailable)

    NEHotspotNetwork.fetchCurrent { network in
      defer { semaphore.signal() }
      guard let network = network else {
        result = .failure(DiagnosticsError.wifiInformationUnavailable)
        return
      }

      var payload: [String: Any] = [
        "timestamp": Date().timeIntervalSince1970 * 1000.0,
      ]

      if let interfaceName = network.interfaceName, !interfaceName.isEmpty {
        payload["interface"] = interfaceName
      }
      if let ssid = network.ssid, !ssid.isEmpty {
        payload["ssid"] = ssid
      }
      if let bssid = network.bssid, !bssid.isEmpty {
        payload["bssid"] = bssid
      }

      result = .success(payload)
    }

    semaphore.wait()

    switch result {
    case .success(let payload):
      return payload
    case .failure(let error):
      throw error
    }
  }
#endif

  private func fetchMetricsUsingCaptiveNetwork() throws -> [String: Any] {
#if canImport(SystemConfiguration)
    guard
      let supportedInterfaces = CNCopySupportedInterfaces() as? [String],
      let interfaceName = supportedInterfaces.first
    else {
      throw DiagnosticsError.interfaceUnavailable
    }

    guard
      let information = CNCopyCurrentNetworkInfo(interfaceName as CFString) as? [String: Any]
    else {
      throw DiagnosticsError.wifiInformationUnavailable
    }

    var payload: [String: Any] = [
      "timestamp": Date().timeIntervalSince1970 * 1000.0,
      "interface": interfaceName,
    ]

    if let ssid = information[kCNNetworkInfoKeySSID as String] as? String,
       !ssid.isEmpty {
      payload["ssid"] = ssid
    }

    if let bssid = information[kCNNetworkInfoKeyBSSID as String] as? String,
       !bssid.isEmpty {
      payload["bssid"] = bssid
    }

    return payload
#else
    throw DiagnosticsError.wifiInformationUnavailable
#endif
  }
}
