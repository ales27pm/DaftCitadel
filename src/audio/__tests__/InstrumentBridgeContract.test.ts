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

const stripNativeSourceComments = (source: string): string => {
  let result = '';
  let state: 'code' | 'lineComment' | 'blockComment' | 'singleQuote' | 'doubleQuote' =
    'code';

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    const next = source[index + 1];

    if (state === 'lineComment') {
      if (character === '\n') {
        state = 'code';
        result += character;
      } else {
        result += ' ';
      }
      continue;
    }

    if (state === 'blockComment') {
      if (character === '*' && next === '/') {
        state = 'code';
        result += '  ';
        index += 1;
      } else {
        result += character === '\n' ? '\n' : ' ';
      }
      continue;
    }

    if (state === 'singleQuote' || state === 'doubleQuote') {
      result += character;
      if (character === '\\' && next !== undefined) {
        result += next;
        index += 1;
        continue;
      }
      if (
        (state === 'singleQuote' && character === "'") ||
        (state === 'doubleQuote' && character === '"')
      ) {
        state = 'code';
      }
      continue;
    }

    if (character === '/' && next === '/') {
      state = 'lineComment';
      result += '  ';
      index += 1;
      continue;
    }
    if (character === '/' && next === '*') {
      state = 'blockComment';
      result += '  ';
      index += 1;
      continue;
    }
    if (character === "'") {
      state = 'singleQuote';
    } else if (character === '"') {
      state = 'doubleQuote';
    }
    result += character;
  }

  return result;
};

const realtimeForbiddenPatterns: Array<{ label: string; pattern: RegExp }> = [
  {
    label: 'lock acquisition',
    pattern:
      /\bstd::(?:lock_guard|unique_lock)\s*<|\bstd::try_to_lock\b|\bpthread_mutex_\w+\s*\(/,
  },
  {
    label: 'exception handling',
    pattern:
      /@catch\s*\(|@throw\b|\bcatch\s*\(|\bthrow(?:\s+|;)|\bThrowJavaException\s*\(/,
  },
  {
    label: 'logging',
    pattern:
      /\bos_log(?:_[a-z_]+)?\s*\(|\b__android_log_(?:print|write|assert)\s*\(|\bNSLog\s*\(|\bLog\.(?:v|d|i|w|e|wtf)\s*\(/,
  },
  {
    label: 'allocation',
    pattern:
      /\bnew\s+(?:[A-Za-z_:]|\()|\bstd::vector\s*<|\bstd::(?:make_unique|make_shared)\s*<|\b(?:malloc|calloc|realloc)\s*\(/,
  },
];

const expectRealtimeCallbackContract = (name: string, source: string): void => {
  const uncommentedSource = stripNativeSourceComments(source);
  for (const { label, pattern } of realtimeForbiddenPatterns) {
    const match = uncommentedSource.match(pattern);
    if (match) {
      throw new Error(
        `Realtime callback contract violated for ${name}: found ${label} token "${match[0]}"`,
      );
    }
  }
};

describe('instrument native bridge contract', () => {
  const iosModule = readRepositoryFile('native/audio/ios/AudioEngineModule.mm');
  const iosBridge = readRepositoryFile('audio-engine/platform/ios/AudioEngineBridge.mm');
  const iosDeviceDriver = readRepositoryFile('native/audio/ios/AudioDeviceDriver.mm');
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

  const operations = ['sendInstrumentMidi', 'allNotesOff'];

  it('exports matching promise APIs on iOS and Android', () => {
    operations.forEach((operation) => {
      expect(iosModule).toContain(`RCT_EXPORT_METHOD(${operation}:`);
      expect(androidModule).toMatch(new RegExp(`fun\\s+${operation}\\(`));
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
    expect(androidJni).toContain('AudioEngineBridge::scheduleInstrumentEventFromNow');
    expect(androidJni).toContain('nativeSendInstrumentMidi');
    expect(androidJni).toContain('AudioEngineBridge::allNotesOff');
    expect(androidJni).toContain('nativeAllNotesOff');
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

  it('ignores comments and similarly named identifiers in realtime callback probes', () => {
    expect(() =>
      expectRealtimeCallbackContract(
        'comment probe',
        `
          // catch (...) { Log.e("comment only"); throw std::runtime_error("comment"); }
          /* std::vector<float> scratch; os_log("comment only"); new ScratchBuffer(); */
          auto catchment = 0;
          auto throwaway = catchment;
          auto LogState = throwaway;
        `,
      ),
    ).not.toThrow();
    expect(() =>
      expectRealtimeCallbackContract(
        'diagnostic probe',
        'throw std::runtime_error("bad");',
      ),
    ).toThrow(/diagnostic probe/);
  });

  it('keeps native callback entry points free of locks, logging, exceptions, and allocations', () => {
    const iosBridgeRender = methodBody(
      iosBridge,
      'void AudioEngineBridge::render(EngineGeneration generation',
      'void AudioEngineBridge::startTransport(',
    );
    const androidBridgeRender = methodBody(
      androidBridge,
      'void AudioEngineBridge::render(float** outputs',
      'void AudioEngineBridge::startTransport()',
    );
    const realtimePlaneRender = methodBody(
      controlPlane,
      'void RealtimeControlPlane::render(',
      'void RealtimeControlPlane::waitUntilRenderIdle()',
    );
    const iosSourceNodeRenderBlock = methodBody(
      iosDeviceDriver,
      'AVAudioSourceNodeRenderBlock renderBlock =',
      'phase = @"source-node-creation";',
    );
    const androidJniRender = methodBody(
      androidJni,
      'Java_com_daftcitadel_audio_AudioEngineModule_nativeRenderInterleaved',
      'JNIEXPORT jobjectArray JNICALL\nJava_com_daftcitadel_audio_AudioEngineModule_nativeRecoverAfterAudioConfigurationChange',
    );

    expect(iosBridgeRender).toContain('realtimePlane_.render(view, generation)');
    expect(androidBridgeRender).toContain('realtimePlane_.render(view, publication)');
    expect(realtimePlaneRender).toContain('commandQueue_.tryPop(command)');
    expect(realtimePlaneRender).toContain('graph->render(outputBuffer)');
    expect(iosSourceNodeRenderBlock).toContain('AudioEngineBridge::render(');
    expect(iosSourceNodeRenderBlock).toContain('thread_local PlanarBuffer planar{}');
    expect(androidJniRender).toContain('AudioEngineBridge::render(');
    expect(androidJniRender).toContain('gRenderScratch');

    const realtimeCallbackEntries = [
      { name: 'iOS bridge render', source: iosBridgeRender },
      { name: 'Android bridge render', source: androidBridgeRender },
      { name: 'realtime control plane render', source: realtimePlaneRender },
      { name: 'iOS source node render block', source: iosSourceNodeRenderBlock },
      { name: 'Android JNI render entry point', source: androidJniRender },
    ];

    realtimeCallbackEntries.forEach(({ name, source }) => {
      expectRealtimeCallbackContract(name, source);
    });
  });
});
