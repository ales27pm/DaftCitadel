import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const readRepositoryFile = (relativePath: string): string =>
  readFileSync(resolve(process.cwd(), relativePath), 'utf8');

const methodBody = (source: string, startMarker: string, endMarker: string): string => {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);

  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);

  return source.slice(start, end);
};

const forbiddenRealtimeConstructs =
  /\b(?:std::)?(?:unique_lock|lock_guard|mutex)\b|os_log|__android_log|\btry\b|\bcatch\b|\bthrow\b|std::function|make_unique|make_shared|\bnew\b/;

describe('native audio bridge crash containment', () => {
  const moduleSource = readRepositoryFile('native/audio/ios/AudioEngineModule.mm');
  const deviceSource = readRepositoryFile('native/audio/ios/AudioDeviceDriver.mm');
  const bridgeHeader = readRepositoryFile(
    'audio-engine/platform/ios/AudioEngineBridge.hpp',
  );
  const bridgeSource = readRepositoryFile(
    'audio-engine/platform/ios/AudioEngineBridge.mm',
  );
  const androidBridgeSource = readRepositoryFile(
    'audio-engine/platform/android/AudioEngineBridge.cpp',
  );
  const controlPlaneHeader = readRepositoryFile(
    'audio-engine/include/audio_engine/RealtimeControlPlane.h',
  );
  const controlPlaneSource = readRepositoryFile(
    'audio-engine/src/RealtimeControlPlane.cpp',
  );
  const pluginHostHeader = readRepositoryFile(
    'audio-engine/include/audio_engine/PluginHost.h',
  );
  const pluginHostSource = readRepositoryFile('audio-engine/src/PluginHost.cpp');

  it('contains native exceptions in every exported Promise operation', () => {
    const exports = [...moduleSource.matchAll(/RCT_EXPORT_METHOD\((\w+):/g)];

    expect(exports.map((match) => match[1])).toEqual([
      'initialize',
      'shutdown',
      'startTransport',
      'stopTransport',
      'locateTransport',
      'setTransportLoop',
      'getTransportState',
      'describeGraph',
      'applyGraph',
      'addNode',
      'registerClipBuffer',
      'unregisterClipBuffer',
      'removeNode',
      'connectNodes',
      'disconnectNodes',
      'scheduleParameterAutomation',
      'sendInstrumentMidi',
      'allNotesOff',
      'getRenderDiagnostics',
    ]);

    exports.forEach((entry, index) => {
      const start = entry.index ?? 0;
      const end = exports[index + 1]?.index ?? moduleSource.indexOf('@end', start);
      const exportedMethod = moduleSource.slice(start, end);
      const hasExceptionBoundary =
        exportedMethod.includes('PerformPromiseOperation(') ||
        exportedMethod.includes('@try {');

      expect({ method: entry[1], hasExceptionBoundary }).toEqual({
        method: entry[1],
        hasExceptionBoundary: true,
      });
    });
  });

  it('handles Objective-C exceptions before the C++ catch-all and settles once', () => {
    const helper = methodBody(
      moduleSource,
      'void PerformPromiseOperation(',
      'void ShutdownBridgeIfOwner(',
    );

    expect(helper.indexOf('try {')).toBeLessThan(helper.indexOf('@try {'));
    expect(helper.indexOf('@catch (id exception)')).toBeLessThan(
      helper.indexOf('catch (const std::exception& ex)'),
    );
    expect(helper.match(/@catch \(id exception\)/g)).toHaveLength(2);
    expect(helper).toContain('RCTPromiseResolveBlock captureResolve');
    expect(helper).toContain('RCTPromiseRejectBlock captureReject');
    expect(helper).toContain('state != OutcomeState::pending');
    expect(helper.indexOf('resolve(resolvedValue)')).toBeGreaterThan(
      helper.indexOf('catch (...)'),
    );
    expect(helper).toContain('failed with an unknown native exception');
  });

  it('converts ordinary string node options without exception-driven numeric parsing', () => {
    const convertOptions = methodBody(
      moduleSource,
      'NodeOptions ConvertOptions(',
      'NSString* NSStringFromStdString(',
    );

    expect(convertOptions).toContain('daft::audio::bridge::detail::storeStringOption(');
    expect(convertOptions).toContain('if (trimmed.empty())');
    expect(convertOptions).toContain('continue;');
    expect(convertOptions).not.toContain('std::stod');
    expect(convertOptions).not.toContain('try {');
  });

  it('defers lifecycle and transport Promise callbacks to the shared settlement boundary', () => {
    const exportedMethods = [
      ['initialize', 'RCT_EXPORT_METHOD(initialize:', 'RCT_EXPORT_METHOD(shutdown:'],
      ['shutdown', 'RCT_EXPORT_METHOD(shutdown:', 'RCT_EXPORT_METHOD(startTransport:'],
      [
        'startTransport',
        'RCT_EXPORT_METHOD(startTransport:',
        'RCT_EXPORT_METHOD(stopTransport:',
      ],
      [
        'stopTransport',
        'RCT_EXPORT_METHOD(stopTransport:',
        'RCT_EXPORT_METHOD(locateTransport:',
      ],
    ] as const;

    exportedMethods.forEach(([name, startMarker, endMarker]) => {
      const exportedMethod = methodBody(moduleSource, startMarker, endMarker);

      expect({
        name,
        usesCaptureBoundary: exportedMethod.includes('PerformPromiseOperation('),
      }).toEqual({
        name,
        usesCaptureBoundary: true,
      });
      expect(exportedMethod).toContain(
        '^(RCTPromiseResolveBlock resolve, RCTPromiseRejectBlock reject)',
      );
    });
  });

  it('allows only the module that initialized a graph generation to use it', () => {
    const invalidate = methodBody(moduleSource, '- (void)invalidate', '- (void)dealloc');
    const dealloc = methodBody(
      moduleSource,
      '- (void)dealloc',
      'RCT_EXPORT_METHOD(addNode:',
    );
    const diagnostics = methodBody(
      moduleSource,
      'RCT_EXPORT_METHOD(getRenderDiagnostics:',
      '@end',
    );

    expect(moduleSource).toMatch(
      /const auto generation =\s+AudioEngineBridge::initialize/,
    );
    expect(invalidate).toContain('ShutdownBridgeIfOwner');
    expect(dealloc).toContain('[self invalidate]');
    expect(moduleSource).not.toContain('AudioEngineBridge::shutdown();');
    expect(diagnostics).toContain('@"initialized"');
    expect(diagnostics).toContain('AudioEngineBridge::getDiagnostics(generation)');
    expect(diagnostics).toContain('diagnostics.initialized');

    [
      'startTransport',
      'stopTransport',
      'locateTransport',
      'setTransportLoop',
      'getTransportState',
      'describeGraph',
      'applyGraph',
      'addNode',
      'removeNode',
      'connect',
      'disconnect',
      'scheduleParameterAutomation',
      'scheduleInstrumentEventFromNow',
      'scheduleInstrumentEvents',
      'allNotesOff',
      'registerClipBuffer',
      'unregisterClipBuffer',
      'clipBufferForKey',
      'getDiagnostics',
    ].forEach((operation) => {
      expect(bridgeHeader).toMatch(
        new RegExp(`\\b${operation}\\(\\s*EngineGeneration generation`),
      );
    });
    expect(bridgeSource).toContain('requireGenerationLocked(generation)');
    expect(bridgeSource).toContain('ownsGenerationLocked(generation)');
  });

  it('configures the graph at launch without opening the audio device', () => {
    const initialize = methodBody(
      moduleSource,
      'RCT_EXPORT_METHOD(initialize:',
      'RCT_EXPORT_METHOD(shutdown:',
    );

    expect(initialize).toContain('AudioEngineBridge::initialize');
    expect(initialize).not.toContain('startWithSampleRate:');
    expect(initialize).toContain('PerformPromiseOperation(');
    expect(initialize).toContain(
      '^(RCTPromiseResolveBlock resolve, RCTPromiseRejectBlock reject)',
    );
  });

  it('starts the audio device lazily and rejects Objective-C transport failures', () => {
    const startTransport = methodBody(
      moduleSource,
      'RCT_EXPORT_METHOD(startTransport:',
      'RCT_EXPORT_METHOD(stopTransport:',
    );

    expect(startTransport).toContain('startWithSampleRate:self.configuredSampleRate');
    expect(startTransport).toContain('engineGeneration:generation');
    expect(startTransport).toContain('PerformPromiseOperation(');
    expect(startTransport).toContain('@catch (NSException* exception)');
    expect(startTransport).toContain(
      '^(RCTPromiseResolveBlock resolve, RCTPromiseRejectBlock reject)',
    );
  });

  it('accepts base64 clip payloads instead of bridgeless ArrayBuffer dictionaries', () => {
    const registerClipBuffer = methodBody(
      moduleSource,
      'RCT_EXPORT_METHOD(registerClipBuffer:',
      'RCT_EXPORT_METHOD(unregisterClipBuffer:',
    );

    expect(registerClipBuffer).toContain('initWithBase64EncodedString');
    expect(registerClipBuffer).toContain(
      'channelData entries must be base64 Float32 PCM strings',
    );
  });

  it('silences stale iOS device routes before touching a replacement graph', () => {
    expect(deviceSource).toContain('engineGeneration:(uint64_t)engineGeneration');
    expect(deviceSource).toContain(
      'AudioEngineBridge::render(engineGeneration, channelPointers.data(), channels, frames)',
    );

    const render = methodBody(
      bridgeSource,
      'void AudioEngineBridge::render(',
      'void AudioEngineBridge::startTransport(',
    );
    expect(render).toContain('realtimePlane_.render(view, generation)');
    expect(render).not.toMatch(forbiddenRealtimeConstructs);
    expect(controlPlaneSource).toContain(
      'publicationToken_.load(std::memory_order_acquire)',
    );
    expect(controlPlaneSource).toContain('expectedPublicationToken');
    expect(controlPlaneSource).toContain('RenderReaderLease reader(renderReaders_)');
  });

  it('keeps iOS, Android, and common render callbacks lock-free and exception-free', () => {
    const iosRender = methodBody(
      bridgeSource,
      'void AudioEngineBridge::render(',
      'void AudioEngineBridge::startTransport(',
    );
    const androidRender = methodBody(
      androidBridgeSource,
      'void AudioEngineBridge::render(',
      'void AudioEngineBridge::startTransport(',
    );
    const commonRender = methodBody(
      controlPlaneSource,
      'void RealtimeControlPlane::render(',
      'void RealtimeControlPlane::waitUntilRenderIdle(',
    );

    expect(iosRender).not.toMatch(forbiddenRealtimeConstructs);
    expect(androidRender).not.toMatch(forbiddenRealtimeConstructs);
    expect(commonRender).not.toMatch(forbiddenRealtimeConstructs);
    expect(controlPlaneHeader).toContain('is_always_lock_free');
    expect(controlPlaneHeader).toContain('RealtimeSpscQueue<RealtimeControlCommand');
    expect(commonRender).toContain('commandQueue_.tryPop(command)');
    expect(commonRender).toContain('graph->applyRealtimeCommand(command)');
  });

  it('forbids structural graph mutations while transport is playing', () => {
    const methods = [
      [
        'addNode',
        'bool AudioEngineBridge::addNode(',
        'void AudioEngineBridge::removeNode(',
      ],
      [
        'removeNode',
        'void AudioEngineBridge::removeNode(',
        'bool AudioEngineBridge::connect(',
      ],
      [
        'connect',
        'bool AudioEngineBridge::connect(',
        'void AudioEngineBridge::disconnect(',
      ],
      [
        'disconnect',
        'void AudioEngineBridge::disconnect(',
        'void AudioEngineBridge::scheduleParameterAutomation(',
      ],
    ] as const;

    for (const [name, startMarker, endMarker] of methods) {
      const iosMethod = methodBody(bridgeSource, startMarker, endMarker);
      const androidMethod = methodBody(androidBridgeSource, startMarker, endMarker);
      expect({
        name,
        ios: iosMethod.includes('requireTransportStoppedLocked()'),
      }).toEqual({
        name,
        ios: true,
      });
      expect({
        name,
        android: androidMethod.includes('requireTransportStoppedLocked()'),
      }).toEqual({
        name,
        android: true,
      });
    }
  });

  it('requires plugin render callbacks to contain their own failures', () => {
    const render = methodBody(
      pluginHostSource,
      'std::optional<PluginRenderResult> PluginHostBridge::Render(',
      '}  // namespace daft::audio',
    );
    expect(pluginHostHeader).toContain('void* userData) noexcept');
    expect(pluginHostSource).toContain('is_always_lock_free');
    expect(render).not.toMatch(/\btry\b|\bcatch\b|\bthrow\b/);
    expect(render).toContain('return callback(request, userData)');
  });

  it('turns AVFoundation exceptions into NSError failures after guarded cleanup', () => {
    const startDevice = methodBody(
      deviceSource,
      '- (BOOL)startWithSampleRate:',
      '- (void)stop',
    );

    expect(startDevice).toContain('@catch (NSException* exception)');
    expect(startDevice).toContain('AssignError(error, 3,');
    expect(startDevice).toContain(
      'CleanupEngine(engine, sourceNode, sourceAttached, session);',
    );
    expect(startDevice).toMatch(/CleanupEngine[\s\S]+return NO;/);
  });
});
