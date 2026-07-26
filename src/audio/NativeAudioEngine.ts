import type { TurboModule } from 'react-native';
import { NativeModules, Platform, TurboModuleRegistry } from 'react-native';

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
    channelData: ArrayBuffer[],
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

const unavailableModule = new Proxy({} as AudioEngineSpec, {
  get: () => () =>
    Promise.reject(new Error(`${moduleName} is not available on this platform`)),
});

export const NativeAudioEngine: AudioEngineSpec =
  Platform.OS === 'web'
    ? unavailableModule
    : TurboModuleRegistry.getEnforcing<AudioEngineSpec>(moduleName);

export const isNativeModuleAvailable = (): boolean => {
  return Platform.OS !== 'web' && NativeModules[moduleName] != null;
};
