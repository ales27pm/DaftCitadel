import Foundation
import AVFoundation
import AudioToolbox
import React

@objc(PluginHostModule)
class PluginHostModule: RCTEventEmitter {
  private let runtimeUnavailableMessage =
    "AUv3 hosting is disabled because its render callback is not connected to the audio engine"
  private struct PluginInstanceState {
    let identifier: String
    let instanceId: String
    let audioUnit: AUAudioUnit
    let descriptor: [String: Any]
    let sandboxPath: String?
    let renderObserverToken: AUAudioUnitRenderObserverToken?
  }

  private let queue = DispatchQueue(label: "com.daftcitadel.pluginhost", qos: .userInitiated)
  private var instances: [String: PluginInstanceState] = [:]
  private let componentManager = AVAudioUnitComponentManager.shared()
  private let sandboxCoordinator = PluginSandboxCoordinator()
  private let isoFormatter = ISO8601DateFormatter()

  override static func requiresMainQueueSetup() -> Bool {
    false
  }

  override func constantsToExport() -> [AnyHashable: Any]! {
    ["runtimeReady": false]
  }

  override func supportedEvents() -> [String]! {
    ["pluginCrashed", "sandboxPermissionRequired"]
  }

  @objc(queryAvailablePlugins:resolver:rejecter:)
  func queryAvailablePlugins(
    _ format: NSString?,
    resolver: @escaping RCTPromiseResolveBlock,
    rejecter: @escaping RCTPromiseRejectBlock
  ) {
    // A linked control bridge is not an audio capability. Do not advertise
    // components until PluginHostBridge has a real-time render callback.
    resolver([])
  }

  @objc(instantiatePlugin:options:resolver:rejecter:)
  func instantiatePlugin(
    _ identifier: NSString,
    options: NSDictionary,
    resolver: @escaping RCTPromiseResolveBlock,
    rejecter: @escaping RCTPromiseRejectBlock
  ) {
    rejecter("runtime_unavailable", runtimeUnavailableMessage, nil)
  }

  @objc(releasePlugin:resolver:rejecter:)
  func releasePlugin(
    _ instanceId: NSString,
    resolver: @escaping RCTPromiseResolveBlock,
    rejecter: @escaping RCTPromiseRejectBlock
  ) {
    queue.async { [weak self] in
      guard let self else { return }
      guard let state = self.instances.removeValue(forKey: instanceId as String) else {
        resolver(NSNull())
        return
      }
      if let token = state.renderObserverToken {
        state.audioUnit.removeRenderObserver(token)
      }
      state.audioUnit.deallocateRenderResources()
      resolver(NSNull())
    }
  }

  @objc(loadPreset:preset:resolver:rejecter:)
  func loadPreset(
    _ instanceId: NSString,
    preset: NSDictionary,
    resolver: @escaping RCTPromiseResolveBlock,
    rejecter: @escaping RCTPromiseRejectBlock
  ) {
    guard let state = instances[instanceId as String] else {
      rejecter("missing_instance", "Plugin instance not found", nil)
      return
    }
    queue.async {
      let presetObject = AUAudioUnitPreset()
      presetObject.number = 0
      presetObject.name = preset["name"] as? String ?? "Preset"
      state.audioUnit.currentPreset = presetObject
      resolver(NSNull())
    }
  }

  @objc(setParameterValue:parameterId:value:resolver:rejecter:)
  func setParameterValue(
    _ instanceId: NSString,
    parameterId: NSString,
    value: NSNumber,
    resolver: @escaping RCTPromiseResolveBlock,
    rejecter: @escaping RCTPromiseRejectBlock
  ) {
    guard let state = instances[instanceId as String], let parameterTree = state.audioUnit.parameterTree else {
      rejecter("missing_parameter_tree", "Parameter tree unavailable", nil)
      return
    }
    guard let parameter = parameterTree.allParameters.first(where: { $0.identifier == parameterId as String }) else {
      rejecter("missing_parameter", "Parameter \(parameterId) not found", nil)
      return
    }
    queue.async {
      parameter.setValue(Float(truncating: value), originator: nil)
      resolver(NSNull())
    }
  }

  @objc(scheduleAutomation:parameterId:curve:resolver:rejecter:)
  func scheduleAutomation(
    _ instanceId: NSString,
    parameterId: NSString,
    curve: NSArray,
    resolver: @escaping RCTPromiseResolveBlock,
    rejecter: @escaping RCTPromiseRejectBlock
  ) {
    guard let state = instances[instanceId as String], let parameterTree = state.audioUnit.parameterTree else {
      rejecter("missing_parameter_tree", "Parameter tree unavailable", nil)
      return
    }
    guard let parameter = parameterTree.allParameters.first(where: { $0.identifier == parameterId as String }) else {
      rejecter("missing_parameter", "Parameter \(parameterId) not found", nil)
      return
    }
    let scheduleBlock = state.audioUnit.scheduleParameterBlock

    let sampleRate = state.audioUnit.outputBusses.first?.format.sampleRate ?? 44100
    let events: [(sampleTime: AUEventSampleTime, value: AUValue)] = curve.compactMap { element in
      guard
        let dict = element as? [String: Any],
        let timeMs = dict["time"] as? Double,
        let value = dict["value"] as? Double
      else {
        return nil
      }
      let sampleTime = AUEventSampleTime(timeMs * sampleRate / 1000.0)
      return (sampleTime: sampleTime, value: AUValue(value))
    }

    queue.async {
      for event in events.sorted(by: { $0.sampleTime < $1.sampleTime }) {
        scheduleBlock(event.sampleTime, 0, parameter.address, event.value)
      }
      resolver(NSNull())
    }
  }

  @objc(ensureSandbox:resolver:rejecter:)
  func ensureSandbox(
    _ identifier: NSString,
    resolver: @escaping RCTPromiseResolveBlock,
    rejecter: @escaping RCTPromiseRejectBlock
  ) {
    queue.async { [weak self] in
      guard let self else { return }
      do {
        let path = try self.sandboxCoordinator.ensureSandbox(identifier: identifier as String)
        resolver(["sandboxPath": path])
      } catch {
        self.sendEvent(withName: "sandboxPermissionRequired", body: [
          "identifier": identifier,
          // Application Support is inside the app container and needs no
          // additional entitlement. The underlying file error is actionable.
          "requiredEntitlements": [],
          "reason": error.localizedDescription,
        ])
        rejecter("sandbox_error", error.localizedDescription, error)
      }
    }
  }

  @objc(acknowledgeCrash:resolver:rejecter:)
  func acknowledgeCrash(
    _ instanceId: NSString,
    resolver: @escaping RCTPromiseResolveBlock,
    rejecter: @escaping RCTPromiseRejectBlock
  ) {
    queue.async { [weak self] in
      guard let self else { return }
      self.instances.removeValue(forKey: instanceId as String)
      resolver(NSNull())
    }
  }

  private func makeDescriptor(component: AVAudioUnitComponent) -> [String: Any] {
    let description = component.audioComponentDescription
    var parameters: [[String: Any]] = []
    var inputChannels = 2
    var outputChannels = 2
    if let audioUnit = try? AUAudioUnit(componentDescription: description) {
      inputChannels = Int(audioUnit.inputBusses.first?.format.channelCount ?? 2)
      outputChannels = Int(audioUnit.outputBusses.first?.format.channelCount ?? 2)
      if let parameterTree = audioUnit.parameterTree {
        parameters = parameterTree.allParameters.map { parameter in
          [
            "id": parameter.identifier,
            "name": parameter.displayName,
            "minValue": parameter.minValue,
            "maxValue": parameter.maxValue,
            "defaultValue": parameter.value,
            "automationRate": parameter.flags.contains(.flag_IsHighResolution) ? "audio" : "control",
          ]
        }
      }
    }

    return [
      "identifier": description.identifierString,
      "name": component.name,
      "format": "auv3",
      "manufacturer": component.manufacturerName,
      "version": component.version,
      "supportsSandbox": true,
      "audioInputChannels": inputChannels,
      "audioOutputChannels": outputChannels,
      "midiInput": component.hasMIDIInput,
      "midiOutput": component.hasMIDIOutput,
      "parameters": parameters,
    ]
  }

  private func availableComponents() -> [AVAudioUnitComponent] {
    let wildcard = AudioComponentDescription(
      componentType: 0,
      componentSubType: 0,
      componentManufacturer: 0,
      componentFlags: 0,
      componentFlagsMask: 0
    )
    return componentManager.components(matching: wildcard)
  }

  private func emitCrashEvent(
    instanceId: String,
    descriptor: [String: Any],
    reason: String,
    sandboxPath: String?,
    recovered: Bool
  ) {
    sendEvent(withName: "pluginCrashed", body: [
      "instanceId": instanceId,
      "descriptor": descriptor,
      "timestamp": isoFormatter.string(from: Date()),
      "reason": reason,
      "recovered": recovered,
      "restartToken": UUID().uuidString,
      "sandboxPath": sandboxPath as Any,
    ])
  }
}

private class PluginSandboxCoordinator {
  private let fileManager = FileManager.default

  func ensureSandbox(identifier: String) throws -> String {
    let baseURL = try pluginBaseDirectory()
    var pluginURL = baseURL.appendingPathComponent(identifier, isDirectory: true)
    if !fileManager.fileExists(atPath: pluginURL.path) {
      try fileManager.createDirectory(at: pluginURL, withIntermediateDirectories: true)
      var resourceValues = URLResourceValues()
      resourceValues.isExcludedFromBackup = true
      try pluginURL.setResourceValues(resourceValues)
    }
    return pluginURL.path
  }

  private func pluginBaseDirectory() throws -> URL {
    let urls = fileManager.urls(for: .applicationSupportDirectory, in: .userDomainMask)
    guard let base = urls.first else {
      throw NSError(domain: "PluginSandbox", code: 1, userInfo: [NSLocalizedDescriptionKey: "Application Support directory unavailable"])
    }
    let pluginsURL = base.appendingPathComponent("Plugins", isDirectory: true)
    if !fileManager.fileExists(atPath: pluginsURL.path) {
      try fileManager.createDirectory(at: pluginsURL, withIntermediateDirectories: true)
    }
    return pluginsURL
  }
}

private extension AudioComponentDescription {
  var identifierString: String {
    return String(format: "%04X-%04X-%04X", componentManufacturer, componentType, componentSubType)
  }
}
