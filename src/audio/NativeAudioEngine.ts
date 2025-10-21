import type { TurboModule } from 'react-native';
import { TurboModuleRegistry, NativeModules } from 'react-native';

type NodeId = string;

type AutomationPoint = {
  frame: number;
  value: number;
};

type AutomationLanePayload = {
  parameter: string;
  points: AutomationPoint[];
};

export interface AudioEngineSpec extends TurboModule {
  initialize(sampleRate: number, framesPerBuffer: number): Promise<void>;
  shutdown(): Promise<void>;
  createSceneGraph(graphId: string): Promise<void>;
  destroySceneGraph(graphId: string): Promise<void>;
  addNode(
    graphId: string,
    nodeId: NodeId,
    nodeType: string,
    options: Record<string, number | string | boolean>,
  ): Promise<void>;
  connectNodes(graphId: string, source: NodeId, destination: NodeId): Promise<void>;
  disconnectNodes(graphId: string, source: NodeId, destination: NodeId): Promise<void>;
  start(graphId: string): Promise<void>;
  stop(graphId: string): Promise<void>;
  setTransportState(
    graphId: string,
    isPlaying: boolean,
    startFrame: number,
  ): Promise<void>;
  setTempo(graphId: string, bpm: number): Promise<void>;
  scheduleAutomation(
    graphId: string,
    nodeId: NodeId,
    lane: AutomationLanePayload,
  ): Promise<void>;
  cancelAutomation(graphId: string, nodeId: NodeId, parameter: string): Promise<void>;
  getRenderDiagnostics(): Promise<{
    xruns: number;
    lastRenderDurationMicros: number;
  }>;
}

const moduleName = 'AudioEngineModule';

export const NativeAudioEngine: AudioEngineSpec =
  TurboModuleRegistry.getEnforcing<AudioEngineSpec>(moduleName);

export const isNativeModuleAvailable = (): boolean => {
  return NativeModules[moduleName] != null;
};
