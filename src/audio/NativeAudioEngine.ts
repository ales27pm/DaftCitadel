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

const resolveRegisteredModule = (): AudioEngineSpec | null => {
  const registry = TurboModuleRegistry as typeof TurboModuleRegistry | undefined;
  const modules = NativeModules as typeof NativeModules | undefined;
  return (
    (typeof registry?.get === 'function'
      ? registry.get<AudioEngineSpec>(moduleName)
      : null) ??
    (modules?.[moduleName] as AudioEngineSpec | undefined) ??
    null
  );
};

// Keep imports safe when an embedding target intentionally omits native audio;
// resolve the binding at access time so fast refresh and test hosts cannot retain
// a stale module reference across native lifecycle changes.
export const NativeAudioEngine = new Proxy({} as AudioEngineSpec, {
  get: (target, property, receiver) => {
    if (Reflect.has(target, property)) {
      return Reflect.get(target, property, receiver);
    }
    const registeredModule = resolveRegisteredModule();
    if (!registeredModule) {
      return () =>
        Promise.reject(
          new Error(
            `${moduleName}.${String(property)} is unavailable because the native module is not linked. Use an Expo development build that includes native audio.`,
          ),
        );
    }
    const value = Reflect.get(registeredModule as object, property);
    return typeof value === 'function' ? value.bind(registeredModule) : value;
  },
});

export const isNativeModuleAvailable = (): boolean => {
  return resolveRegisteredModule() != null;
};
