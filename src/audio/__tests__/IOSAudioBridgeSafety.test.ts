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

describe('iOS audio bridge crash containment', () => {
  const moduleSource = readRepositoryFile('native/audio/ios/AudioEngineModule.mm');
  const deviceSource = readRepositoryFile('native/audio/ios/AudioDeviceDriver.mm');
  const bridgeHeader = readRepositoryFile(
    'audio-engine/platform/ios/AudioEngineBridge.hpp',
  );
  const bridgeSource = readRepositoryFile(
    'audio-engine/platform/ios/AudioEngineBridge.mm',
  );

  it('contains native exceptions in every exported Promise operation', () => {
    const exports = [...moduleSource.matchAll(/RCT_EXPORT_METHOD\((\w+):/g)];

    expect(exports.map((match) => match[1])).toEqual([
      'initialize',
      'shutdown',
      'addNode',
      'registerClipBuffer',
      'unregisterClipBuffer',
      'removeNode',
      'connectNodes',
      'disconnectNodes',
      'scheduleParameterAutomation',
      'startTransport',
      'stopTransport',
      'locateTransport',
      'getTransportState',
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
    expect(helper.indexOf('@catch (NSException* exception)')).toBeLessThan(
      helper.indexOf('catch (const std::exception& ex)'),
    );
    expect(helper).toContain('RCTPromiseResolveBlock captureResolve');
    expect(helper).toContain('RCTPromiseRejectBlock captureReject');
    expect(helper).toContain('state != OutcomeState::pending');
    expect(helper.indexOf('resolve(resolvedValue)')).toBeGreaterThan(
      helper.indexOf('catch (...)'),
    );
  });

  it('defers lifecycle and transport Promise callbacks to the shared settlement boundary', () => {
    const exportedMethods = [
      ['initialize', 'RCT_EXPORT_METHOD(initialize:', 'RCT_EXPORT_METHOD(shutdown:'],
      ['shutdown', 'RCT_EXPORT_METHOD(shutdown:', '- (void)invalidate'],
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
      expect(exportedMethod).toContain('finish(');
      expect(exportedMethod).toContain('fail(');
      expect(exportedMethod).not.toMatch(/\b(?:resolve|reject)\s*\(/);
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

    expect(moduleSource).toContain('self.engineGeneration = generation');
    expect(invalidate).toContain('ShutdownBridgeIfOwner');
    expect(dealloc).toContain('ShutdownBridgeIfOwner');
    expect(moduleSource).not.toContain('AudioEngineBridge::shutdown();');
    expect(diagnostics).toContain('@"initialized"');
    expect(diagnostics).toContain('AudioEngineBridge::getDiagnostics(generation)');
    expect(diagnostics).toContain('diagnostics.initialized');

    [
      'startTransport',
      'stopTransport',
      'locateTransport',
      'getTransportState',
      'addNode',
      'removeNode',
      'connect',
      'disconnect',
      'scheduleParameterAutomation',
      'registerClipBuffer',
      'unregisterClipBuffer',
      'clipBufferForKey',
      'getDiagnostics',
    ].forEach((operation) => {
      expect(bridgeHeader).toMatch(
        new RegExp(`\\b${operation}\\(EngineGeneration generation`),
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
    expect(initialize).toContain('@catch (NSException* exception)');
    expect(initialize).toContain('RejectObjectiveCException(fail, @"initialize_failed"');
    expect(initialize).not.toMatch(/\b(?:resolve|reject)\s*\(/);
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
      'RejectObjectiveCException(fail, @"transport_start_failed"',
    );
    expect(startTransport).not.toMatch(/\b(?:resolve|reject)\s*\(/);
  });

  it('silences stale iOS device routes instead of rendering a replacement graph', () => {
    expect(deviceSource).toContain('engineGeneration:(uint64_t)engineGeneration');
    expect(deviceSource).toContain(
      'AudioEngineBridge::render(engineGeneration, channelPointers.data(), channels, frames)',
    );
    expect(bridgeSource).toContain('if (!ownsGenerationLocked(generation))');
    expect(bridgeSource).toContain('generation_.load(std::memory_order_acquire)');
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
