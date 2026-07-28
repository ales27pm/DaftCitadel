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

describe('instrument native bridge contract', () => {
  const iosModule = readRepositoryFile('native/audio/ios/AudioEngineModule.mm');
  const iosBridge = readRepositoryFile('audio-engine/platform/ios/AudioEngineBridge.mm');
  const androidBridge = readRepositoryFile(
    'audio-engine/platform/android/AudioEngineBridge.cpp',
  );
  const androidModule = readRepositoryFile(
    'native/audio/android/src/main/java/com/daftcitadel/audio/AudioEngineModule.kt',
  );
  const androidJni = readRepositoryFile(
    'native/audio/android/src/main/jni/AudioEngineModule.cpp',
  );
  const androidDeviceDriver = readRepositoryFile(
    'native/audio/android/src/main/java/com/daftcitadel/audio/AudioTrackDeviceDriver.kt',
  );
  const sceneGraph = readRepositoryFile('audio-engine/src/SceneGraph.cpp');
  const controlPlane = readRepositoryFile('audio-engine/src/RealtimeControlPlane.cpp');

  const operations = [
    'sendMidiEvent',
    'sendMidiEvents',
    'setInstrumentParameter',
    'sendInstrumentParameters',
    'allNotesOff',
  ];

  it('exports matching promise APIs on iOS and Android', () => {
    operations.forEach((operation) => {
      expect(iosModule).toContain(`RCT_EXPORT_METHOD(${operation}:`);
      expect(androidModule).toMatch(new RegExp(`fun\s+${operation}\(`));
    });
  });

  it('keeps scheduling bounded across the SPSC and instrument queues', () => {
    expect(sceneGraph).toContain('dynamic_cast<InstrumentNode*>');
    expect(sceneGraph).toContain('instrument->scheduleEvents(events, replace)');
    expect(sceneGraph).toContain('scheduleInstrumentEvent(command.nodeId, event)');
    expect(iosBridge).toContain(
      'graph_->scheduleInstrumentEvents(nodeId, events, replace)',
    );
    expect(iosBridge).toContain('realtimePlane_.enqueueBatch(');
    expect(androidBridge).toContain('realtimePlane_.enqueueBatch(');
    expect(controlPlane).toContain('commandQueue_.tryPop(command)');
    expect(androidJni).toContain('AudioEngineBridge::scheduleInstrumentEvents');
    expect(androidJni).toContain('nativeSendMidiEvents');
    expect(androidJni).toContain('nativeSendInstrumentParameters');
  });

  it('exposes native transport looping on both mobile bridges', () => {
    expect(iosModule).toContain('RCT_EXPORT_METHOD(setTransportLoop:');
    expect(iosBridge).toContain(
      'graph_->setTransportLoop(startFrame, endFrame, enabled)',
    );
    expect(iosBridge).toContain('RealtimeCommandType::kSetTransportLoop');
    expect(androidBridge).toContain('RealtimeCommandType::kSetTransportLoop');
    expect(androidModule).toMatch(/fun\s+setTransportLoop\(/);
    expect(androidModule).toContain(
      'nativeSetTransportLoop(startTicks, endTicks, enabled)',
    );
    expect(androidJni).toContain('nativeSetTransportLoop');
    expect(androidJni).toContain('AudioEngineBridge::setTransportLoop');
    expect(sceneGraph).toContain('rewindTimelineForLoop');
  });

  it('hard-silences live instrument state when transport stops', () => {
    const iosStop = methodBody(
      iosBridge,
      'void AudioEngineBridge::stopTransport(',
      'void AudioEngineBridge::locateTransport(',
    );
    const androidStop = methodBody(
      androidBridge,
      'void AudioEngineBridge::stopTransport(',
      'void AudioEngineBridge::locateTransport(',
    );
    const iosStopPlane = methodBody(
      iosBridge,
      'void AudioEngineBridge::stopRealtimePlaneLocked()',
      'RealtimeNodeId AudioEngineBridge::requireRealtimeNodeLocked(',
    );
    const androidStopPlane = methodBody(
      androidBridge,
      'void AudioEngineBridge::stopRealtimePlaneLocked()',
      'RealtimeNodeId AudioEngineBridge::requireRealtimeNodeLocked(',
    );

    expect(iosStop).toContain('stopRealtimePlaneLocked()');
    expect(androidStop).toContain('stopRealtimePlaneLocked()');
    for (const helper of [iosStopPlane, androidStopPlane]) {
      expect(helper).toContain('RealtimeCommandType::kPanicAllInstruments');
      expect(helper).toContain('realtimePlane_.setPlaying(false)');
      expect(helper).toContain('realtimePlane_.waitUntilRenderIdle()');
      expect(helper).toContain('graph_->panicInstruments()');
      expect(helper).toContain('discardCommandsQuiescent()');
    }
    expect(iosBridge).toContain('event.retainAcrossPanic = false;');
    expect(androidBridge).toContain('event.retainAcrossPanic = false;');
  });

  it('suspends and restores the Android render driver with transport state', () => {
    const initializeMethod = androidModule.slice(
      androidModule.indexOf('fun initialize('),
      androidModule.indexOf('fun shutdown('),
    );
    const startMethod = androidModule.slice(
      androidModule.indexOf('fun startTransport('),
      androidModule.indexOf('fun stopTransport('),
    );
    const stopMethod = androidModule.slice(
      androidModule.indexOf('fun stopTransport('),
      androidModule.indexOf('fun locateTransport('),
    );

    expect(initializeMethod).toContain(
      'deviceConfiguration = DeviceConfiguration(deviceSampleRate, framesInt)',
    );
    expect(initializeMethod).not.toContain('deviceDriver.start(');
    expect(startMethod).toContain('if (!deviceDriver.isRunning())');
    expect(startMethod).toContain(
      'deviceDriver.start(configuration.sampleRate, configuration.framesPerBuffer)',
    );
    expect(startMethod).toContain('check(deviceDriver.isRunning())');
    expect(stopMethod).toMatch(/nativeStopTransport\(\)[\s\S]*deviceDriver\.stop\(\)/);
    expect(androidDeviceDriver).toMatch(/fun isRunning\(\): Boolean/);
  });

  it('keeps the Android audio render loop free of logs and exception handling', () => {
    const renderLoop = methodBody(
      androidDeviceDriver,
      'private fun renderLoop(',
      'private companion object',
    );

    expect(renderLoop).toContain('renderInterleaved(');
    expect(renderLoop).toContain('track.write(');
    expect(renderLoop).not.toMatch(/\btry\b|\bcatch\b|runCatching|Log\./);
    expect(androidDeviceDriver).toContain('uncaughtExceptionHandler =');
    expect(androidDeviceDriver).toContain('running.set(false)');
  });
});
