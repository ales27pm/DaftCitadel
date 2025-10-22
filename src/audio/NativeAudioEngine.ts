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
  getRenderDiagnostics(): Promise<{
    xruns: number;
    lastRenderDurationMicros: number;
    clipBufferBytes: number;
  }>;
}

const moduleName = 'AudioEngineModule';

export const NativeAudioEngine: AudioEngineSpec =
  TurboModuleRegistry.getEnforcing<AudioEngineSpec>(moduleName);

export const isNativeModuleAvailable = (): boolean => {
  return NativeModules[moduleName] != null;
};
