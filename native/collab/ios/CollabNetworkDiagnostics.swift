import Foundation
import os.log
import React
#if canImport(CoreWLAN)
import CoreWLAN
#endif

@objc(CollabNetworkDiagnostics)
class CollabNetworkDiagnostics: RCTEventEmitter {
  private enum DiagnosticsError: LocalizedError {
    case coreWLANUnavailable
    case interfaceUnavailable

    var errorDescription: String? {
      switch self {
      case .coreWLANUnavailable:
        return "CoreWLAN is not available on this platform."
      case .interfaceUnavailable:
        return "No active Wi-Fi interface could be found."
      }
    }
  }

  private let log = OSLog(subsystem: "com.daftcitadel.collab", category: "diagnostics")
  private let eventName = "CollabNetworkDiagnosticsEvent"
  private let metricsQueue = DispatchQueue(label: "com.daftcitadel.collab.diagnostics")
  private var pollTimer: DispatchSourceTimer?

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

  @objc(startObserving)
  func startObservingCommand() {
    startMonitoring()
  }

  @objc(stopObserving)
  func stopObservingCommand() {
    stopMonitoring()
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

      let timer = DispatchSource.makeTimerSource(queue: self.metricsQueue)
      timer.schedule(deadline: .now(), repeating: .seconds(5), leeway: .seconds(1))
      timer.setEventHandler { [weak self] in
        self?.emitLatestMetrics()
      }
      self.pollTimer = timer
      timer.resume()
    }
  }

  private func stopMonitoring() {
    metricsQueue.async {
      self.pollTimer?.cancel()
      self.pollTimer = nil
    }
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
#if canImport(CoreWLAN)
    guard let client = CWWiFiClient.shared() else {
      throw DiagnosticsError.coreWLANUnavailable
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
    if let ssid = interface.ssid(), ssid != "" {
      payload["ssid"] = ssid
    }
    if let bssid = interface.bssid(), bssid != "" {
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
#else
    throw DiagnosticsError.coreWLANUnavailable
#endif
  }
}
