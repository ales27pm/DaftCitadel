import type { TurboModule } from 'react-native';
import { TurboModuleRegistry, NativeModules } from 'react-native';

type NodeId = string;

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
  getRenderDiagnostics(): Promise<{
    xruns: number;
    lastRenderDurationMicros: number;
    clipBufferBytes: number;
  }>;
}

const moduleName = 'AudioEngineModule';

type TurboModuleLookup = {
  get?<T extends TurboModule>(name: string): T | null;
};

const resolveNativeAudioEngine = (): AudioEngineSpec | undefined => {
  const registry = TurboModuleRegistry as unknown as TurboModuleLookup | undefined;
  const turboModule = registry?.get?.<AudioEngineSpec>(moduleName);
  if (turboModule) {
    return turboModule;
  }

  return (NativeModules as Record<string, unknown> | undefined)?.[moduleName] as
    | AudioEngineSpec
    | undefined;
};

const unavailableNativeAudioEngine = new Proxy({} as AudioEngineSpec, {
  get: (_target, property) => {
    if (typeof property === 'symbol') {
      return undefined;
    }

    return async () => {
      throw new Error(
        `${moduleName}.${property} is unavailable. Use an Expo development build that includes the native audio module.`,
      );
    };
  },
});

export const NativeAudioEngine: AudioEngineSpec =
  resolveNativeAudioEngine() ?? unavailableNativeAudioEngine;

export const isNativeModuleAvailable = (): boolean => {
  return resolveNativeAudioEngine() != null;
};
