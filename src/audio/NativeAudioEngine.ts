import type { TurboModule } from 'react-native';
import { NativeModules, Platform, TurboModuleRegistry } from 'react-native';

import type {
  AudioInstrumentMidiEvent,
  InstrumentParameterChange,
} from '../session/sessionManager';

type NodeId = string;

export type NativeRenderDiagnostics = {
  xruns: number;
  lastRenderDurationMicros: number;
  clipBufferBytes: number;
  initialized?: boolean;
  activeVoices?: number;
  pendingInstrumentEvents?: number;
  realtimeQueueDepth?: number;
  realtimeQueueOverflows?: number;
  realtimeCommandFailures?: number;
  renderCount?: number;
  averageRenderDurationMicros?: number;
  maximumRenderDurationMicros?: number;
  p50RenderDurationMicros?: number;
  p95RenderDurationMicros?: number;
  p99RenderDurationMicros?: number;
};

export interface AudioEngineSpec extends TurboModule {
  initialize(sampleRate: number, framesPerBuffer: number): Promise<void>;
  shutdown(): Promise<void>;
  addNode(
    nodeId: NodeId,
    nodeType: string,
    options: Record<string, number | string | boolean>,
  ): Promise<void>;
  registerClipBuffer(
    bufferKey: string,
    sampleRate: number,
    channels: number,
    frames: number,
    channelData: string[],
  ): Promise<void>;
  unregisterClipBuffer(bufferKey: string): Promise<void>;
  removeNode(nodeId: NodeId): Promise<void>;
  connectNodes(source: NodeId, destination: NodeId): Promise<void>;
  disconnectNodes(source: NodeId, destination: NodeId): Promise<void>;
  scheduleParameterAutomation(
    nodeId: NodeId,
    parameter: string,
    frame: number,
    value: number,
  ): Promise<void>;
  sendInstrumentMidi(nodeId: NodeId, event: AudioInstrumentMidiEvent): Promise<void>;
  setInstrumentParameter?(
    nodeId: NodeId,
    change: InstrumentParameterChange,
  ): Promise<void>;
  allNotesOff(nodeId: NodeId): Promise<void>;
  startTransport(): Promise<void>;
  stopTransport(): Promise<void>;
  locateTransport(frame: number): Promise<void>;
  getTransportState(): Promise<{
    currentFrame: number;
    isPlaying: boolean;
  }>;
  getRenderDiagnostics(): Promise<NativeRenderDiagnostics>;
}

const moduleName = 'AudioEngineModule';

const REQUIRED_AUDIO_ENGINE_METHODS = [
  'initialize',
  'shutdown',
  'addNode',
  'registerClipBuffer',
  'unregisterClipBuffer',
  'removeNode',
  'connectNodes',
  'disconnectNodes',
  'scheduleParameterAutomation',
  'sendInstrumentMidi',
  'allNotesOff',
  'startTransport',
  'stopTransport',
  'locateTransport',
  'getTransportState',
  'getRenderDiagnostics',
] as const satisfies ReadonlyArray<keyof AudioEngineSpec>;

const hasNativeAudioEngineMethods = (
  candidate: unknown,
): candidate is AudioEngineSpec => {
  if (!candidate || typeof candidate !== 'object') {
    return false;
  }
  const module = candidate as Record<string, unknown>;
  return REQUIRED_AUDIO_ENGINE_METHODS.every(
    (method) => typeof module[method] === 'function',
  );
};

const getTurboModuleSafely = (): unknown | null => {
  try {
    return TurboModuleRegistry.get<AudioEngineSpec>(moduleName);
  } catch (error) {
    console.warn(`${moduleName} TurboModule lookup failed`, error);
    return null;
  }
};

const getNativeAudioEngineModule = (): AudioEngineSpec | null => {
  if (Platform.OS === 'web') {
    return null;
  }
  const bridgeModule = NativeModules[moduleName];
  if (hasNativeAudioEngineMethods(bridgeModule)) {
    return bridgeModule;
  }
  const turboModule = getTurboModuleSafely();
  if (hasNativeAudioEngineMethods(turboModule)) {
    return turboModule;
  }
  return null;
};

const requireNativeAudioEngineModule = (): AudioEngineSpec => {
  const module = getNativeAudioEngineModule();
  if (!module) {
    throw new Error(`${moduleName} is not available on this platform`);
  }
  return module;
};

export const NativeAudioEngine: AudioEngineSpec = {
  initialize(sampleRate: number, framesPerBuffer: number): Promise<void> {
    return requireNativeAudioEngineModule().initialize(sampleRate, framesPerBuffer);
  },
  shutdown(): Promise<void> {
    return requireNativeAudioEngineModule().shutdown();
  },
  addNode(
    nodeId: NodeId,
    nodeType: string,
    options: Record<string, number | string | boolean>,
  ): Promise<void> {
    return requireNativeAudioEngineModule().addNode(nodeId, nodeType, options);
  },
  registerClipBuffer(
    bufferKey: string,
    sampleRate: number,
    channels: number,
    frames: number,
    channelData: string[],
  ): Promise<void> {
    return requireNativeAudioEngineModule().registerClipBuffer(
      bufferKey,
      sampleRate,
      channels,
      frames,
      channelData,
    );
  },
  unregisterClipBuffer(bufferKey: string): Promise<void> {
    return requireNativeAudioEngineModule().unregisterClipBuffer(bufferKey);
  },
  removeNode(nodeId: NodeId): Promise<void> {
    return requireNativeAudioEngineModule().removeNode(nodeId);
  },
  connectNodes(source: NodeId, destination: NodeId): Promise<void> {
    return requireNativeAudioEngineModule().connectNodes(source, destination);
  },
  disconnectNodes(source: NodeId, destination: NodeId): Promise<void> {
    return requireNativeAudioEngineModule().disconnectNodes(source, destination);
  },
  scheduleParameterAutomation(
    nodeId: NodeId,
    parameter: string,
    frame: number,
    value: number,
  ): Promise<void> {
    return requireNativeAudioEngineModule().scheduleParameterAutomation(
      nodeId,
      parameter,
      frame,
      value,
    );
  },
  sendInstrumentMidi(nodeId: NodeId, event: AudioInstrumentMidiEvent): Promise<void> {
    return requireNativeAudioEngineModule().sendInstrumentMidi(nodeId, event);
  },
  setInstrumentParameter(
    nodeId: NodeId,
    change: InstrumentParameterChange,
  ): Promise<void> {
    const module = requireNativeAudioEngineModule();
    if (typeof module.setInstrumentParameter !== 'function') {
      throw new Error(`${moduleName}.setInstrumentParameter is not available`);
    }
    return module.setInstrumentParameter(nodeId, change);
  },
  allNotesOff(nodeId: NodeId): Promise<void> {
    return requireNativeAudioEngineModule().allNotesOff(nodeId);
  },
  startTransport(): Promise<void> {
    return requireNativeAudioEngineModule().startTransport();
  },
  stopTransport(): Promise<void> {
    return requireNativeAudioEngineModule().stopTransport();
  },
  locateTransport(frame: number): Promise<void> {
    return requireNativeAudioEngineModule().locateTransport(frame);
  },
  getTransportState(): Promise<{ currentFrame: number; isPlaying: boolean }> {
    return requireNativeAudioEngineModule().getTransportState();
  },
  getRenderDiagnostics(): Promise<NativeRenderDiagnostics> {
    return requireNativeAudioEngineModule().getRenderDiagnostics();
  },
} as AudioEngineSpec;

export const isNativeModuleAvailable = (): boolean => {
  return getNativeAudioEngineModule() != null;
};

export const isNativeInstrumentControlsAvailable = (): boolean => {
  const module = getNativeAudioEngineModule();
  return (
    typeof module?.sendInstrumentMidi === 'function' &&
    typeof module.allNotesOff === 'function'
  );
};
