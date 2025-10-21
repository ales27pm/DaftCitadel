import { NativeAudioEngine, isNativeModuleAvailable } from './NativeAudioEngine';
import { AutomationLane, publishAutomationLane, ClockSyncService } from './Automation';

export type NodeConfiguration = {
  id: string;
  type: string;
  options?: Record<string, number | string | boolean>;
};

export class AudioEngine {
  private readonly sampleRate: number;
  private readonly framesPerBuffer: number;
  private readonly clock: ClockSyncService;

  constructor(params: { sampleRate: number; framesPerBuffer: number; bpm: number }) {
    if (!isNativeModuleAvailable()) {
      throw new Error('AudioEngine native module is unavailable');
    }
    if (params.sampleRate <= 0) {
      throw new Error('sampleRate must be positive');
    }
    if (params.framesPerBuffer <= 0) {
      throw new Error('framesPerBuffer must be positive');
    }
    this.sampleRate = params.sampleRate;
    this.framesPerBuffer = params.framesPerBuffer;
    this.clock = new ClockSyncService(
      params.sampleRate,
      params.framesPerBuffer,
      params.bpm,
    );
  }

  public getClock(): ClockSyncService {
    return this.clock;
  }

  public async init(): Promise<void> {
    await NativeAudioEngine.initialize(this.sampleRate, this.framesPerBuffer);
  }

  public async dispose(): Promise<void> {
    await NativeAudioEngine.shutdown();
  }

  public async configureNodes(nodes: NodeConfiguration[]): Promise<void> {
    if (nodes.length === 0) {
      return;
    }

    await Promise.all(
      nodes.map((node) =>
        NativeAudioEngine.addNode(node.id, node.type, node.options ?? {}),
      ),
    );
  }

  public async connect(source: string, destination: string): Promise<void> {
    await NativeAudioEngine.connectNodes(source, destination);
  }

  public async disconnect(source: string, destination: string): Promise<void> {
    await NativeAudioEngine.disconnectNodes(source, destination);
  }

  public async publishAutomation(nodeId: string, lane: AutomationLane): Promise<void> {
    await publishAutomationLane(nodeId, lane);
  }

  public async uploadClipBuffer(
    bufferKey: string,
    sampleRate: number,
    channels: number,
    frames: number,
    channelData: ReadonlyArray<ArrayBuffer>,
  ): Promise<void> {
    await NativeAudioEngine.registerClipBuffer(
      bufferKey,
      sampleRate,
      channels,
      frames,
      Array.from(channelData),
    );
  }

  public async removeNodes(nodeIds: string[]): Promise<void> {
    if (nodeIds.length === 0) {
      return;
    }

    await Promise.all(nodeIds.map((nodeId) => NativeAudioEngine.removeNode(nodeId)));
  }
}

export { AutomationLane, publishAutomationLane, ClockSyncService };
export const OUTPUT_BUS = '__output__';
