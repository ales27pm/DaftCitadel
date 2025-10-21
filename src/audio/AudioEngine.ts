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
  private readonly graphId: string;
  private readonly clock: ClockSyncService;

  constructor(params: {
    sampleRate: number;
    framesPerBuffer: number;
    bpm: number;
    graphId?: string;
  }) {
    if (!isNativeModuleAvailable()) {
      throw new Error('AudioEngine native module is unavailable');
    }
    this.sampleRate = params.sampleRate;
    this.framesPerBuffer = params.framesPerBuffer;
    this.graphId = params.graphId ?? 'default';
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
    await NativeAudioEngine.createSceneGraph(this.graphId);
    await NativeAudioEngine.setTempo(this.graphId, this.clock.describe().bpm);
  }

  public async dispose(): Promise<void> {
    await NativeAudioEngine.destroySceneGraph(this.graphId);
    await NativeAudioEngine.shutdown();
  }

  public async configureNodes(nodes: NodeConfiguration[]): Promise<void> {
    for (const node of nodes) {
      await NativeAudioEngine.addNode(
        this.graphId,
        node.id,
        node.type,
        node.options ?? {},
      );
    }
  }

  public async connect(source: string, destination: string): Promise<void> {
    await NativeAudioEngine.connectNodes(this.graphId, source, destination);
  }

  public async disconnect(source: string, destination: string): Promise<void> {
    await NativeAudioEngine.disconnectNodes(this.graphId, source, destination);
  }

  public async start(): Promise<void> {
    await NativeAudioEngine.start(this.graphId);
    await NativeAudioEngine.setTransportState(this.graphId, true, 0);
  }

  public async stop(): Promise<void> {
    await NativeAudioEngine.setTransportState(this.graphId, false, 0);
    await NativeAudioEngine.stop(this.graphId);
  }

  public async publishAutomation(nodeId: string, lane: AutomationLane): Promise<void> {
    await publishAutomationLane(this.graphId, nodeId, lane);
  }
}

export { AutomationLane, publishAutomationLane, ClockSyncService };
