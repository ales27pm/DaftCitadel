import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const readRepositoryFile = (relativePath: string): string =>
  readFileSync(resolve(process.cwd(), relativePath), 'utf8');

describe('instrument native bridge contract', () => {
  const iosModule = readRepositoryFile('native/audio/ios/AudioEngineModule.mm');
  const iosBridge = readRepositoryFile('audio-engine/platform/ios/AudioEngineBridge.mm');
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
      expect(androidModule).toMatch(new RegExp(`fun\\s+${operation}\\(`));
    });
  });

  it('keeps batch scheduling bounded inside the instrument node', () => {
    expect(sceneGraph).toContain('dynamic_cast<InstrumentNode*>');
    expect(sceneGraph).toContain('instrument->scheduleEvents(events, replace)');
    expect(iosBridge).toContain(
      'graph_->scheduleInstrumentEvents(nodeId, events, replace)',
    );
    expect(androidJni).toContain('AudioEngineBridge::scheduleInstrumentEvents');
    expect(androidJni).toContain('nativeSendMidiEvents');
    expect(androidJni).toContain('nativeSendInstrumentParameters');
  });

  it('exposes native transport looping on both mobile bridges', () => {
    expect(iosModule).toContain('RCT_EXPORT_METHOD(setTransportLoop:');
    expect(iosBridge).toContain(
      'graph_->setTransportLoop(startFrame, endFrame, enabled)',
    );
    expect(androidModule).toMatch(/fun\s+setTransportLoop\(/);
    expect(androidModule).toContain(
      'nativeSetTransportLoop(startTicks, endTicks, enabled)',
    );
    expect(androidJni).toContain('nativeSetTransportLoop');
    expect(androidJni).toContain('AudioEngineBridge::setTransportLoop');
    expect(sceneGraph).toContain('rewindTimelineForLoop');
  });

  it('hard-silences live instrument state when transport stops', () => {
    expect(iosBridge).toMatch(/stopTransport[\s\S]*graph_->panicInstruments\(\)/);
    const androidBridge = readRepositoryFile(
      'audio-engine/platform/android/AudioEngineBridge.cpp',
    );
    expect(androidBridge).toMatch(/stopTransport[\s\S]*graph_->panicInstruments\(\)/);
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
});
