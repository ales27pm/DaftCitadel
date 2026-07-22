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

  it('configures the graph at launch without opening the audio device', () => {
    const initialize = methodBody(
      moduleSource,
      'RCT_EXPORT_METHOD(initialize:',
      'RCT_EXPORT_METHOD(shutdown:',
    );

    expect(initialize).toContain('AudioEngineBridge::initialize');
    expect(initialize).not.toContain('startWithSampleRate:');
    expect(initialize).toContain('@catch (NSException* exception)');
    expect(initialize).toContain(
      'RejectObjectiveCException(reject, @"initialize_failed"',
    );
  });

  it('starts the audio device lazily and rejects Objective-C transport failures', () => {
    const startTransport = methodBody(
      moduleSource,
      'RCT_EXPORT_METHOD(startTransport:',
      'RCT_EXPORT_METHOD(stopTransport:',
    );

    expect(startTransport).toContain('startWithSampleRate:self.configuredSampleRate');
    expect(startTransport).toContain('@catch (NSException* exception)');
    expect(startTransport).toContain(
      'RejectObjectiveCException(reject, @"transport_start_failed"',
    );
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
