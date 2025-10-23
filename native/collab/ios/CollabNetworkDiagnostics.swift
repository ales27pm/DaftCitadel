import Foundation
import os.log
import React
#if canImport(CoreWLAN)
import CoreWLAN
#endif
#if canImport(SystemConfiguration)
import SystemConfiguration.CaptiveNetwork
#endif
    case wifiInformationUnavailable
      case .wifiInformationUnavailable:
        return "Wi-Fi metrics are unavailable on this device."

  private var pollInterval: TimeInterval = 5.0
  @objc(beginObserving)
  func beginObserving() {
  @objc(endObserving)
  func endObserving() {
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

      self.scheduleTimerLocked()
  private func scheduleTimerLocked() {
    guard pollTimer == nil else {
      return
    }
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

#if canImport(CoreWLAN) && targetEnvironment(macCatalyst)
    return try fetchMetricsUsingCoreWLAN()
#else
    return try fetchMetricsUsingCaptiveNetwork()
#endif
  }

  private func fetchMetricsUsingCoreWLAN() throws -> [String: Any] {
      throw DiagnosticsError.wifiInformationUnavailable
    if let ssid = interface.ssid(), !ssid.isEmpty {
    }
    if let bssid = interface.bssid(), !bssid.isEmpty {

    return payload
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
      let information = CNCopyCurrentNetworkInfo(interfaceName as CFString)
        as? [String: Any]
    else {
      throw DiagnosticsError.wifiInformationUnavailable
    }

    var payload: [String: Any] = [
      "timestamp": Date().timeIntervalSince1970 * 1000.0,
      "interface": interfaceName,
    ]

    if let ssid = information[kCNNetworkInfoKeySSID as String] as? String,
       !ssid.isEmpty
    {
      payload["ssid"] = ssid
    }

    if let bssid = information[kCNNetworkInfoKeyBSSID as String] as? String,
       !bssid.isEmpty
    {
      payload["bssid"] = bssid
    }

    throw DiagnosticsError.wifiInformationUnavailable
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
    guard pollTimer == nil else {
      return
    }
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
#if canImport(CoreWLAN) && targetEnvironment(macCatalyst)
    return try fetchMetricsUsingCoreWLAN()
#else
    return try fetchMetricsUsingCaptiveNetwork()
#endif
  }

#if canImport(CoreWLAN)
  private func fetchMetricsUsingCoreWLAN() throws -> [String: Any] {
    guard let client = CWWiFiClient.shared() else {
      throw DiagnosticsError.wifiInformationUnavailable
    }

    guard let interface = client.interface() else {
      throw DiagnosticsError.interfaceUnavailable
    }

    var payload: [String: Any] = [
      "timestamp": Date().timeIntervalSince1970 * 1000.0,
    ]

    if let name = interface.interfaceName {
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

  private func fetchMetricsUsingCaptiveNetwork() throws -> [String: Any] {
#if canImport(SystemConfiguration)
    guard
      let supportedInterfaces = CNCopySupportedInterfaces() as? [String],
      let interfaceName = supportedInterfaces.first
    else {
      throw DiagnosticsError.interfaceUnavailable
    }

    guard
      let information = CNCopyCurrentNetworkInfo(interfaceName as CFString)
        as? [String: Any]
    else {
      throw DiagnosticsError.wifiInformationUnavailable
    }

    var payload: [String: Any] = [
      "timestamp": Date().timeIntervalSince1970 * 1000.0,
      "interface": interfaceName,
    ]

    if let ssid = information[kCNNetworkInfoKeySSID as String] as? String,
       !ssid.isEmpty
    {
      payload["ssid"] = ssid
    }

    if let bssid = information[kCNNetworkInfoKeyBSSID as String] as? String,
       !bssid.isEmpty
    {
      payload["bssid"] = bssid
    }

    return payload
#else
    throw DiagnosticsError.wifiInformationUnavailable
#endif
  }
}
